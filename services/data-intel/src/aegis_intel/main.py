"""data-intel composition root (Phase 1e skeleton): settings → telemetry → logs → owned clients → probes.

Run: ``uvicorn aegis_intel.main:app --host 0.0.0.0 --port 8089``.
No business logic: service actions and adapters arrive with their FRs.
Uvicorn delivers SIGTERM as lifespan shutdown, which runs the ordered NFR-11 stages.
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import boto3
from botocore.config import Config as BotoConfig
from botocore.exceptions import ClientError
from fastapi import FastAPI
from psycopg_pool import AsyncConnectionPool

from aegis_contracts.topology import ExchangeName, QueueName
from aegis_intel.config import PORT, SERVICE, Settings
from aegis_platform.amqp import AmqpClient
from aegis_platform.build_info import build_version
from aegis_platform.checks import Check
from aegis_platform.config import ConfigError, load_settings
from aegis_platform.db import flyway_version_check, postgres_ping_check
from aegis_platform.health import HealthRegistry, Lifecycle, Phase, Stage, connect_with_retry, health_router
from aegis_platform.logging import configure_logging, get_logger
from aegis_platform.telemetry import start_telemetry


def _objectstore_check(s3: Any, bucket: str) -> Check:
    """HEAD a probe key inside the identity's grant: 404 = reachable and authorized; 403/5xx = down."""

    async def check() -> None:
        try:
            await asyncio.to_thread(s3.head_object, Bucket=bucket, Key=".readiness")
        except ClientError as e:
            if e.response.get("ResponseMetadata", {}).get("HTTPStatusCode") != 404:
                raise

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
        await _start(loaded, health, lifecycle)
        lifecycle.on_shutdown(Stage.TELEMETRY, "otel", lambda: asyncio.to_thread(telemetry.shutdown))
        health.phase = Phase.RUNNING
        get_logger(SERVICE).info("data-intel ready", port=PORT)
        yield
        await lifecycle.shutdown("SIGTERM")

    app = FastAPI(title=f"aegispulse-{SERVICE}", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.include_router(health_router(health))
    return app


async def _start(settings: Settings, health: HealthRegistry, lifecycle: Lifecycle) -> None:
    pool: AsyncConnectionPool = AsyncConnectionPool(settings.conninfo(), min_size=1, max_size=8, open=False)
    await connect_with_retry("postgres", lambda: pool.open(wait=True, timeout=5))
    health.add_check("postgres", postgres_ping_check(pool)).add_check(
        "schema", flyway_version_check(pool, "analytics", "2")
    )
    lifecycle.on_shutdown(Stage.POOLS, "postgres", pool.close)
    s3 = boto3.client(
        "s3",
        endpoint_url=str(settings.S3_ENDPOINT),
        region_name=settings.S3_REGION,
        aws_access_key_id=settings.S3_ACCESS_KEY_ID.get_secret_value(),
        aws_secret_access_key=settings.S3_SECRET_ACCESS_KEY.get_secret_value(),
        config=BotoConfig(
            s3={"addressing_style": "path" if settings.S3_FORCE_PATH_STYLE else "auto"}, retries={"max_attempts": 2}
        ),
    )
    health.add_check("objectstore", _objectstore_check(s3, f"{settings.S3_BUCKET_PREFIX}-analytics"))
    amqp = AmqpClient(
        settings.AMQP_URL.get_secret_value(),
        service="aegispulse-data-intel",
        consumes=[QueueName.INTEL_FACTS_Q],
        publishes_to=[ExchangeName.AEGISPULSE_INTELLIGENCE],
    )
    await connect_with_retry("rabbitmq", amqp.connect)
    health.add_check("rabbitmq", amqp.ready_check)
    lifecycle.on_shutdown(Stage.CONSUMERS, "rabbitmq", amqp.close)


def _app() -> FastAPI:
    try:
        return create_app()
    except ConfigError as e:  # pragma: no cover - exercised by the container smoke test
        raise SystemExit(str(e)) from None


app = _app()
