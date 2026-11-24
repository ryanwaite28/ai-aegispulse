"""Health, readiness and lifecycle (NFR-11).

``/livez`` never touches dependencies; ``/readyz`` runs the readiness checks (config, datastore, schema version, broker)
and is false while starting or stopping; ``/healthz`` is the same report for humans. ``Lifecycle`` runs ordered
shutdown stages on SIGTERM within the grace budget.
"""

import asyncio
import signal
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from aegis_platform.checks import Check
from aegis_platform.errors import describe_error
from aegis_platform.logging import get_logger

log = get_logger(__name__)


class Phase(StrEnum):
    STARTING = "starting"
    RUNNING = "running"
    STOPPING = "stopping"


@dataclass(frozen=True, slots=True)
class CheckResult:
    name: str
    status: str
    duration_ms: int
    detail: str | None = None


@dataclass
class HealthRegistry:
    """Readiness checks with per-check timeouts."""

    phase: Phase = Phase.STARTING
    _checks: list[tuple[str, Check, float]] = field(default_factory=list)

    def add_check(self, name: str, check: Check, timeout_s: float = 2.0) -> "HealthRegistry":
        self._checks.append((name, check, timeout_s))
        return self

    async def _run(self, name: str, check: Check, timeout_s: float) -> CheckResult:
        loop = asyncio.get_running_loop()
        started = loop.time()
        try:
            await asyncio.wait_for(check(), timeout_s)
            return CheckResult(name, "up", int((loop.time() - started) * 1000))
        except TimeoutError:
            return CheckResult(name, "down", int((loop.time() - started) * 1000), f"timed out after {timeout_s}s")
        except Exception as e:  # noqa: BLE001 — a failing check is reported, never raised
            return CheckResult(name, "down", int((loop.time() - started) * 1000), describe_error(e, 200))

    async def readiness(self) -> tuple[bool, list[CheckResult]]:
        results = list(await asyncio.gather(*(self._run(n, c, t) for n, c, t in self._checks)))
        return self.phase is Phase.RUNNING and all(r.status == "up" for r in results), results


def health_router(registry: HealthRegistry) -> APIRouter:
    """FastAPI router with /livez, /readyz, /healthz (mount without auth)."""
    router = APIRouter()

    @router.get("/livez")
    async def livez() -> dict[str, str]:
        return {"status": "ok"}

    async def report() -> JSONResponse:
        ready, results = await registry.readiness()
        body: dict[str, Any] = {
            "ready": ready,
            "phase": registry.phase.value,
            "checks": [_as_dict(r) for r in results],
        }
        return JSONResponse(body, status_code=200 if ready else 503)

    router.add_api_route("/readyz", report, methods=["GET"])
    router.add_api_route("/healthz", report, methods=["GET"])
    return router


def _as_dict(r: CheckResult) -> dict[str, Any]:
    d: dict[str, Any] = {"name": r.name, "status": r.status, "durationMs": r.duration_ms}
    if r.detail is not None:
        d["detail"] = r.detail
    return d


class Stage(StrEnum):
    """NFR-11 order: stop HTTP, cancel consumers + drain, flush outbox batch, flush telemetry, close pools."""

    HTTP = "http"
    CONSUMERS = "consumers"
    OUTBOX = "outbox"
    TELEMETRY = "telemetry"
    POOLS = "pools"


class Lifecycle:
    """Ordered graceful shutdown; hooks in a stage run concurrently; failures never skip later stages."""

    def __init__(self, health: HealthRegistry | None = None, grace_s: float = 25.0) -> None:
        self._hooks: dict[Stage, list[tuple[str, Callable[[], Awaitable[None]]]]] = {s: [] for s in Stage}
        self._health = health
        self._grace = grace_s
        self._done: asyncio.Task[None] | None = None

    def on_shutdown(self, stage: Stage, name: str, hook: Callable[[], Awaitable[None]]) -> "Lifecycle":
        self._hooks[stage].append((name, hook))
        return self

    async def shutdown(self, reason: str) -> None:
        if self._done is None:
            self._done = asyncio.ensure_future(self._run(reason))
        await asyncio.shield(self._done)

    async def _run(self, reason: str) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self._grace
        if self._health is not None:
            self._health.phase = Phase.STOPPING
        log.info("shutdown started", reason=reason)
        for stage in Stage:
            hooks = self._hooks[stage]
            if not hooks:
                continue
            remaining = deadline - loop.time()
            if remaining <= 0:
                log.error("shutdown grace exhausted; skipping remaining stages", stage=stage.value)
                break
            results = await asyncio.gather(
                *(asyncio.wait_for(h(), remaining) for _, h in hooks), return_exceptions=True
            )
            for (name, _), result in zip(hooks, results, strict=True):
                if isinstance(result, BaseException):
                    log.error("shutdown hook failed", stage=stage.value, hook=name, err=describe_error(result))
        log.info("shutdown complete")

    def install_signal_handlers(self, on_done: Callable[[], None]) -> None:
        """SIGTERM/SIGINT → ordered shutdown → ``on_done`` (e.g. stop the server loop)."""
        loop = asyncio.get_running_loop()

        def handle(sig: signal.Signals) -> None:
            task = asyncio.ensure_future(self.shutdown(sig.name))
            task.add_done_callback(lambda _: on_done())

        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, handle, sig)


async def connect_with_retry[T](
    name: str,
    connect: Callable[[], Awaitable[T]],
    *,
    max_wait_s: float = 60.0,
    initial_delay_s: float = 0.5,
    max_delay_s: float = 8.0,
) -> T:
    """NFR-11: startup order is not assumed; retry with backoff up to ``max_wait_s``, then raise."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + max_wait_s
    delay = initial_delay_s
    attempt = 0
    while True:
        attempt += 1
        try:
            return await connect()
        except Exception as e:
            remaining = deadline - loop.time()
            if remaining <= 0:
                log.error("dependency unavailable; giving up", dependency=name, attempt=attempt, err=describe_error(e))
                raise
            log.warning("dependency unavailable; retrying", dependency=name, attempt=attempt, err=describe_error(e))
            await asyncio.sleep(min(delay, remaining))
            delay = min(delay * 2, max_delay_s)
