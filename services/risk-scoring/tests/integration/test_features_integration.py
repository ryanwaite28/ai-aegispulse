"""FR-TXN-04 feature store against Redis 8 with the compose ACL (user risk_scoring: ~feat:*, no scripting/MULTI)."""

import asyncio
import re
import secrets
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
import pytest_asyncio
from redis.asyncio import Redis
from redis.exceptions import NoPermissionError
from testcontainers.core.container import DockerContainer
from testcontainers.core.wait_strategies import LogMessageWaitStrategy

from aegis_risk.adapters.redis.features import RedisFeatureStore

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]
ROOT = Path(__file__).resolve().parents[4]
HOUR = 3_600_000


@pytest_asyncio.fixture(loop_scope="module", scope="module")
async def redis() -> AsyncIterator[Redis]:
    password = secrets.token_hex(16)
    conf = (ROOT / "deploy/compose/init/redis/redis.conf.tmpl").read_text()
    conf = conf.replace("__REDIS_PASSWORD_RISK_SCORING__", password)
    conf = re.sub(r"__[A-Z0-9_]+__", lambda _: secrets.token_hex(16), conf).replace("appendonly yes", "appendonly no")
    container = (
        DockerContainer("redis:8.10.3-alpine")
        .with_exposed_ports(6379)
        .with_command(["sh", "-c", 'printf "%s" "$CONF" > /tmp/redis.conf && exec redis-server /tmp/redis.conf'])
        .with_env("CONF", conf)
        .waiting_for(LogMessageWaitStrategy("Ready to accept connections"))
    )
    container.start()
    host, port = container.get_container_host_ip(), container.get_exposed_port(6379)
    client = Redis.from_url(f"redis://risk_scoring:{password}@{host}:{port}/0")
    yield client
    await client.aclose()
    container.stop()


async def test_velocity_counts_the_hour_and_a_redelivery_returns_the_first_snapshot(redis: Redis) -> None:
    store = RedisFeatureStore(redis)
    tenant, account = str(uuid.uuid4()), "acc-1"
    t0 = 1_795_000_000_000
    snaps = [await store.observe(tenant, f"e{i}", account, "cp-1", t0 + i * 60_000) for i in range(5)]
    assert [s.txn_count_1h for s in snaps] == [1, 2, 3, 4, 5]
    assert snaps[0].counterparty_last_seen_ms is None
    assert snaps[1].counterparty_last_seen_ms == t0
    again = await store.observe(tenant, "e2", account, "cp-1", t0 + 2 * 60_000)
    assert again == snaps[2]  # redelivery: same features, nothing inflated
    later = await store.observe(tenant, "e9", account, "cp-1", t0 + HOUR + 3 * 60_000)
    assert later.txn_count_1h == 3  # e3, e4 and itself are within the hour before it


async def test_concurrent_duplicates_agree_and_count_once(redis: Redis) -> None:
    store = RedisFeatureStore(redis)
    tenant = str(uuid.uuid4())
    t0 = 1_795_000_000_000
    results = await asyncio.gather(*(store.observe(tenant, "dup", "acc", "cp", t0) for _ in range(8)))
    assert len(set(results)) == 1
    nxt = await store.observe(tenant, "next", "acc", "cp", t0 + 1)
    assert nxt.txn_count_1h == 2
    assert await redis.ttl(f"feat:seen:{tenant}:dup") > 47 * 3600


async def test_acl_confines_the_runtime_user_to_feat_keys(redis: Redis) -> None:
    with pytest.raises(NoPermissionError):
        await redis.set("upload:x", "1")
