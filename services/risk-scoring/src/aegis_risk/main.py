"""risk-scoring composition root: settings → telemetry → logs → owned clients → probes.

Run: ``uvicorn aegis_risk.main:app --host 0.0.0.0 --port 8086``.
Routes: /internal/v1/score (FR-TXN-04). No business logic here.
Uvicorn delivers SIGTERM as lifespan shutdown, which runs the ordered NFR-11 stages.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from redis.asyncio import Redis

from aegis_platform.auth import JwtVerifier
from aegis_platform.build_info import build_version
from aegis_platform.checks import Check
from aegis_platform.config import ConfigError, load_settings
from aegis_platform.health import HealthRegistry, Lifecycle, Phase, Stage, health_router
from aegis_platform.logging import configure_logging, get_logger
from aegis_platform.telemetry import start_telemetry
from aegis_platform.web import install_http
from aegis_risk.adapters.http.score import score_router
from aegis_risk.config import PORT, SERVICE, Settings
from aegis_risk.domain.fx import fx_static_v1
from aegis_risk.service.scoring import ScoringService
from aegis_risk.storage.features import RedisFeatureStore


def _redis_check(redis: Redis) -> Check:
    """Readiness inside the ACL key prefix (service users have no @connection, so no PING)."""

    async def check() -> None:
        await redis.exists("feat:readiness-probe")

    return check


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
        await _start(loaded, app, health, lifecycle)
        lifecycle.on_shutdown(Stage.TELEMETRY, "otel", lambda: asyncio.to_thread(telemetry.shutdown))
        health.phase = Phase.RUNNING
        get_logger(SERVICE).info("risk-scoring ready", port=PORT)
        yield
        await lifecycle.shutdown("SIGTERM")

    app = FastAPI(title=f"aegispulse-{SERVICE}", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    install_http(app)
    app.include_router(health_router(health))
    return app


async def _start(settings: Settings, app: FastAPI, health: HealthRegistry, lifecycle: Lifecycle) -> None:
    redis = Redis.from_url(settings.REDIS_URL.get_secret_value(), socket_timeout=2)
    health.add_check("redis", _redis_check(redis))
    lifecycle.on_shutdown(Stage.POOLS, "redis", redis.aclose)
    verifier = JwtVerifier(
        issuer=settings.JWT_ISSUER,
        audience=settings.JWT_AUDIENCE,
        jwks_url=f"{str(settings.REGISTRY_URL).rstrip('/')}/.well-known/jwks.json",
    )
    service = ScoringService(
        features=RedisFeatureStore(redis), fx=fx_static_v1(), default_high_risk=settings.default_high_risk()
    )
    app.include_router(score_router(verifier, service))


def _app() -> FastAPI:
    try:
        return create_app()
    except ConfigError as e:  # pragma: no cover - exercised by the container smoke test
        raise SystemExit(str(e)) from None


app = _app()
