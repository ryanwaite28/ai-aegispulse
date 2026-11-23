"""Real infrastructure for py-platform integration tests (PROJECT.md §12: no mocks of PostgreSQL/RabbitMQ).

PostgreSQL 18 is initialised by the compose init script and migrated by the real migrate image (built with the docker
CLI, as the Gradle suite does); tests connect as svc_analytics. RabbitMQ 4 gets the contract topology from an admin
and a runtime user with configure '^$'."""

import json
import secrets
import subprocess
import time
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass

import aio_pika
import pytest
import pytest_asyncio
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool
from testcontainers.core.container import DockerContainer
from testcontainers.core.network import Network
from testcontainers.postgres import PostgresContainer
from testcontainers.rabbitmq import RabbitMqContainer

from tests.fixtures import CONTRACTS, REPO

SCHEMAS = ("ingestion", "files", "registry", "cases", "analytics")
RUNTIME_USER = "svc_data_intel"


@dataclass
class Broker:
    container: RabbitMqContainer
    admin_url: str
    runtime_url: str


def _secret() -> str:
    return secrets.token_hex(16)


@pytest.fixture(scope="session")
def network() -> Iterator[Network]:
    with Network() as net:
        yield net


@pytest.fixture(scope="session")
def postgres_conninfo(network: Network) -> Iterator[str]:
    env = {"PG_BACKUP_PASSWORD": _secret()}
    for s in SCHEMAS:
        env[f"PG_MIG_PASSWORD_{s.upper()}"] = _secret()
        env[f"PG_SVC_PASSWORD_{s.upper()}"] = _secret()
    subprocess.run(
        ["docker", "build", "--quiet", "-t", "aegispulse-migrate:test", "-f", "deploy/docker/migrate.Dockerfile", "."],
        cwd=REPO,
        check=True,
        capture_output=True,
    )
    pg = PostgresContainer("postgres:18.7-alpine", username="aegis_admin", password=_secret(), dbname="aegispulse")
    pg.with_network(network).with_network_aliases("postgres")
    for k, v in env.items():
        pg.with_env(k, v)
    pg.with_volume_mapping(
        str(REPO / "deploy/compose/init/postgres/01-roles-schemas.sh"),
        "/docker-entrypoint-initdb.d/01-roles-schemas.sh",
    )
    with pg:
        migrate = DockerContainer("aegispulse-migrate:test").with_network(network)
        for k, v in {**env, "PG_HOST": "postgres", "PG_PORT": "5432", "PG_DATABASE": "aegispulse"}.items():
            migrate.with_env(k, v)
        migrate.start()
        result = migrate.get_wrapped_container().wait(timeout=180)
        logs = migrate.get_wrapped_container().logs().decode()
        migrate.stop()
        if result["StatusCode"] != 0 or "aegis-migrate: done" not in logs:
            raise RuntimeError(f"migrations failed:\n{logs}")
        host, port = pg.get_container_host_ip(), pg.get_exposed_port(5432)
        yield (
            f"host={host} port={port} dbname=aegispulse user=svc_analytics password={env['PG_SVC_PASSWORD_ANALYTICS']}"
        )


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def pool(postgres_conninfo: str) -> AsyncIterator[AsyncConnectionPool[AsyncConnection]]:
    async with AsyncConnectionPool(postgres_conninfo, min_size=1, max_size=8, open=False) as p:
        yield p


def _rabbitctl(container: RabbitMqContainer, *args: str) -> None:
    code, output = container.get_wrapped_container().exec_run(["rabbitmqctl", "-q", *args], user="rabbitmq")
    if code != 0:
        raise RuntimeError(f"rabbitmqctl {args[0]} failed: {output.decode()}")


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def broker() -> AsyncIterator[Broker]:
    with RabbitMqContainer("rabbitmq:4.4.1-management-alpine") as container:
        host, port = container.get_container_host_ip(), container.get_exposed_port(5672)
        admin_url = f"amqp://guest:guest@{host}:{port}/"
        deadline = time.monotonic() + 60
        while True:
            try:
                connection = await aio_pika.connect(admin_url)
                break
            except (ConnectionError, OSError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(1)
        topology = json.loads((CONTRACTS / "topology" / "aegispulse.topology.json").read_text())
        async with connection:
            ch = await connection.channel()
            for ex in topology["exchanges"]:
                await ch.declare_exchange(ex["name"], ex["type"], durable=True)
            for q in topology["queues"]:
                await ch.declare_queue(q["name"], durable=True, arguments=q["arguments"])
            for b in topology["bindings"]:
                queue = await ch.get_queue(b["queue"])
                await queue.bind(b["exchange"], b["routingKey"])
        password = _secret()
        _rabbitctl(container, "add_user", RUNTIME_USER, password)
        _rabbitctl(
            container,
            "set_permissions",
            "-p",
            "/",
            RUNTIME_USER,
            "^$",
            r"^aegispulse\.(retry|dlx|intelligence)$",
            r"^intel\.facts\.q$",
        )
        yield Broker(container, admin_url, f"amqp://{RUNTIME_USER}:{password}@{host}:{port}/")
