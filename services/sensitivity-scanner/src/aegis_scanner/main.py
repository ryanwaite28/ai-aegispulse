"""sensitivity-scanner composition root (Phase 1e skeleton): settings → telemetry → logs → owned clients → probes.

Run: ``uvicorn aegis_scanner.main:app --host 0.0.0.0 --port 8087``.
No business logic: service actions and adapters arrive with their FRs.
Uvicorn delivers SIGTERM as lifespan shutdown, which runs the ordered NFR-11 stages.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from aegis_platform.build_info import build_version
from aegis_platform.config import ConfigError, load_settings
from aegis_platform.health import HealthRegistry, Lifecycle, Phase, Stage, health_router
from aegis_platform.logging import configure_logging, get_logger
from aegis_platform.telemetry import start_telemetry
from aegis_scanner.config import PORT, SERVICE, Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    health = HealthRegistry()
    lifecycle = Lifecycle(health)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        loaded = settings or load_settings(Settings)
        version = build_version()
        telemetry = start_telemetry(
            service=f"aegispulse-{SERVICE}",
            version=version,
            env=loaded.AEGIS_ENV,
            namespace=loaded.OTEL_SERVICE_NAMESPACE,
        )
        configure_logging(service=SERVICE, version=version, env=loaded.AEGIS_ENV, level=loaded.LOG_LEVEL)
        await _start(loaded, health, lifecycle)
        lifecycle.on_shutdown(Stage.TELEMETRY, "otel", lambda: asyncio.to_thread(telemetry.shutdown))
        health.phase = Phase.RUNNING
        get_logger(SERVICE).info("sensitivity-scanner ready", port=PORT)
        yield
        await lifecycle.shutdown("SIGTERM")

    app = FastAPI(title=f"aegispulse-{SERVICE}", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(health_router(health))
    return app


async def _start(settings: Settings, health: HealthRegistry, lifecycle: Lifecycle) -> None:
    return None


def _app() -> FastAPI:
    try:
        return create_app()
    except ConfigError as e:  # pragma: no cover - exercised by the container smoke test
        raise SystemExit(str(e)) from None


app = _app()
