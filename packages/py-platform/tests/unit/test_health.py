"""NFR-11: probes, readiness phases, ordered shutdown, startup retry."""

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aegis_platform.health import HealthRegistry, Lifecycle, Phase, Stage, connect_with_retry, health_router


async def _ok() -> None:
    return None


async def _broken() -> None:
    raise ConnectionError("refused")


async def _hang() -> None:
    await asyncio.sleep(10)


def test_probes_through_fastapi() -> None:
    registry = HealthRegistry().add_check("db", _ok).add_check("amqp", _broken)
    app = FastAPI()
    app.include_router(health_router(registry))
    client = TestClient(app)
    assert client.get("/livez").json() == {"status": "ok"}
    registry.phase = Phase.RUNNING
    not_ready = client.get("/readyz")
    assert not_ready.status_code == 503
    assert [c["status"] for c in not_ready.json()["checks"]] == ["up", "down"]
    assert not_ready.json()["checks"][1]["detail"] == "ConnectionError: refused"


async def test_readiness_phases_and_timeouts() -> None:
    registry = HealthRegistry().add_check("db", _ok).add_check("slow", _hang, timeout_s=0.05)
    ready, results = await registry.readiness()
    assert not ready
    assert results[1].detail == "timed out after 0.05s"
    ok = HealthRegistry().add_check("db", _ok)
    assert not (await ok.readiness())[0]  # starting
    ok.phase = Phase.RUNNING
    assert (await ok.readiness())[0]


async def test_shutdown_runs_stages_in_order_and_survives_failures() -> None:
    order: list[str] = []

    def hook(name: str, fail: bool = False):  # type: ignore[no-untyped-def]
        async def run() -> None:
            order.append(name)
            if fail:
                raise RuntimeError("cancel failed")

        return run

    health = HealthRegistry(phase=Phase.RUNNING)
    lifecycle = (
        Lifecycle(health)
        .on_shutdown(Stage.POOLS, "pg", hook("pools"))
        .on_shutdown(Stage.HTTP, "server", hook("http"))
        .on_shutdown(Stage.CONSUMERS, "amqp", hook("consumers", fail=True))
        .on_shutdown(Stage.OUTBOX, "relay", hook("outbox"))
        .on_shutdown(Stage.TELEMETRY, "otel", hook("telemetry"))
    )
    await asyncio.gather(lifecycle.shutdown("SIGTERM"), lifecycle.shutdown("SIGTERM"))
    assert order == ["http", "consumers", "outbox", "telemetry", "pools"]
    assert health.phase is Phase.STOPPING


async def test_connect_with_retry() -> None:
    attempts = 0

    async def flaky() -> str:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise ConnectionError("down")
        return "up"

    assert await connect_with_retry("pg", flaky, initial_delay_s=0.001) == "up"

    async def dead() -> str:
        raise ConnectionError("down")

    with pytest.raises(ConnectionError):
        await connect_with_retry("amqp", dead, max_wait_s=0.02, initial_delay_s=0.005)
