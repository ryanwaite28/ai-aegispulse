"""py-platform end to end (Phase 1d), FR-MSG-01, NFR-02/11.

Outbox → confirmed publish, SKIP LOCKED, backoff, dedup, readiness, and the consumer kit (retry through the real 1 s TTL
queue, DLQ, poison, replay headers, graceful drain).
"""

import asyncio
import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

import aio_pika
import aiormq
import pytest
import pytest_asyncio
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from aegis_contracts.envelope.canonical_envelope_v1_schema import CanonicalEnvelope
from aegis_contracts.topology import ExchangeName, QueueName
from aegis_platform.amqp import AmqpClient, DeliveryContext, Outcome
from aegis_platform.db import flyway_version_check, postgres_ping_check, transaction
from aegis_platform.envelope import encode_envelope
from aegis_platform.errors import NotFoundError, TransientError
from aegis_platform.idempotency import ProcessedMessagesRepository
from aegis_platform.outbox import OutboxMessage, OutboxRelay, OutboxRepository
from tests.fixtures import envelope
from tests.integration.conftest import Broker

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="session")]
REPO = OutboxRepository("analytics")
QUEUE = QueueName.INTEL_FACTS_Q


@pytest_asyncio.fixture(loop_scope="session")
async def admin(broker: Broker) -> AsyncIterator[aio_pika.abc.AbstractChannel]:
    connection = await aio_pika.connect(broker.admin_url)
    channel = await connection.channel(publisher_confirms=True)
    for q in (
        "intel.facts.q",
        "intel.facts.q.dlq",
        "events.deadletter.q",
        "events.archive.q",
        "intel.facts.q.retry.1s",
    ):
        await (await channel.get_queue(q)).purge()
    yield channel
    await connection.close()


async def drain(channel: aio_pika.abc.AbstractChannel, queue: str) -> list[aio_pika.abc.AbstractIncomingMessage]:
    q = await channel.get_queue(queue)
    out = []
    while (m := await q.get(no_ack=True, fail=False)) is not None:
        out.append(m)
    return out


async def wait_for_message(
    channel: aio_pika.abc.AbstractChannel, queue: str, timeout: float = 10
) -> aio_pika.abc.AbstractIncomingMessage:
    q = await channel.get_queue(queue)
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        m = await q.get(no_ack=True, fail=False)
        if m is not None:
            return m
        await asyncio.sleep(0.05)
    raise AssertionError(f"no message on {queue}")


async def until(predicate: Any, timeout: float = 10) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("condition not met")
        await asyncio.sleep(0.05)


def rollup() -> CanonicalEnvelope:
    return envelope("intel.rollup.completed", tenantId=None)


# ── readiness (NFR-11) ────────────────────────────────────────────────────────────────────────────────


async def test_readiness_checks_against_real_dependencies(
    pool: AsyncConnectionPool[AsyncConnection], broker: Broker
) -> None:
    await postgres_ping_check(pool)()
    await flyway_version_check(pool, "analytics", "2")()
    with pytest.raises(RuntimeError, match="need >= V3"):
        await flyway_version_check(pool, "analytics", "3")()
    client = AmqpClient(
        broker.runtime_url, service="data-intel-test", publishes_to=[ExchangeName.AEGISPULSE_INTELLIGENCE]
    )
    with pytest.raises(RuntimeError):
        await client.ready_check()
    await client.connect()
    await client.ready_check()
    await client.close()


async def test_runtime_user_cannot_verify_a_queue_it_may_not_read(broker: Broker) -> None:
    client = AmqpClient(broker.runtime_url, service="data-intel-test", consumes=[QueueName.CASES_AUDIT_INGEST_Q])
    with pytest.raises(aiormq.exceptions.ChannelAccessRefused):
        await client.connect()


# ── outbox (§6.6) ─────────────────────────────────────────────────────────────────────────────────────


async def test_outbox_commits_with_the_transaction_and_relay_publishes_with_confirms(
    pool: AsyncConnectionPool[AsyncConnection], broker: Broker, admin: aio_pika.abc.AbstractChannel
) -> None:
    committed, rolled_back = rollup(), rollup()
    async with transaction(pool) as conn:
        assert await REPO.enqueue(conn, OutboxMessage("aegispulse.intelligence", "intel.rollup.completed", committed))
        assert not await REPO.enqueue(
            conn, OutboxMessage("aegispulse.intelligence", "intel.rollup.completed", committed)
        )

    async def enqueue_then_fail() -> None:
        async with transaction(pool) as conn:
            await REPO.enqueue(conn, OutboxMessage("aegispulse.intelligence", "intel.rollup.completed", rolled_back))
            raise RuntimeError("state change failed")

    with pytest.raises(RuntimeError, match="state change failed"):
        await enqueue_then_fail()

    client = AmqpClient(
        broker.runtime_url, service="data-intel-test", publishes_to=[ExchangeName.AEGISPULSE_INTELLIGENCE]
    )
    await client.connect()
    relay = OutboxRelay(pool, REPO, client.publish_envelope)
    assert await relay.run_once() == 1
    async with transaction(pool) as conn:
        cur = await conn.execute(
            "SELECT status FROM analytics.outbox_events WHERE event_id = %s", (committed.eventId.root,)
        )
        assert (await cur.fetchone()) == ("SENT",)
        cur = await conn.execute(
            "SELECT count(*) FROM analytics.outbox_events WHERE event_id = %s", (rolled_back.eventId.root,)
        )
        assert (await cur.fetchone()) == (0,)
    archived = await wait_for_message(admin, "events.archive.q")
    assert archived.message_id == committed.eventId.root
    assert archived.type == "intel.rollup.completed"
    assert archived.delivery_mode == aio_pika.DeliveryMode.PERSISTENT
    assert archived.headers["x-aegis-schema-version"] == "1.1.0"
    assert "x-aegis-tenant" not in archived.headers  # platform-level event (tenantId null)
    await client.close()


async def test_two_relays_never_publish_a_row_twice(
    pool: AsyncConnectionPool[AsyncConnection], broker: Broker, admin: aio_pika.abc.AbstractChannel
) -> None:
    async with transaction(pool) as conn:
        for _ in range(120):
            await REPO.enqueue(conn, OutboxMessage("aegispulse.intelligence", "intel.rollup.completed", rollup()))
    client = AmqpClient(
        broker.runtime_url, service="data-intel-test", publishes_to=[ExchangeName.AEGISPULSE_INTELLIGENCE]
    )
    await client.connect()
    a = OutboxRelay(pool, REPO, client.publish_envelope, batch_size=40)
    b = OutboxRelay(pool, REPO, client.publish_envelope, batch_size=40)
    total = 0
    while True:
        n = sum(await asyncio.gather(a.run_once(), b.run_once()))
        total += n
        if n == 0:
            break
    assert total == 120
    await asyncio.sleep(0.5)
    ids = [m.message_id for m in await drain(admin, "events.archive.q")]
    assert len(ids) == 120
    assert len(set(ids)) == 120
    await client.close()


async def test_failed_publishes_back_off_and_fail_after_twenty_attempts(
    pool: AsyncConnectionPool[AsyncConnection],
) -> None:
    e = rollup()
    async with transaction(pool) as conn:
        await REPO.enqueue(conn, OutboxMessage("aegispulse.intelligence", "intel.rollup.completed", e))

    async def failing(_: OutboxMessage) -> None:
        raise RuntimeError("broker nacked")

    relay = OutboxRelay(pool, REPO, failing)
    assert await relay.run_once() == 1
    async with transaction(pool) as conn:
        cur = await conn.execute(
            "SELECT attempts, status, last_error, EXTRACT(EPOCH FROM available_at - now())::float8 "
            "FROM analytics.outbox_events WHERE event_id = %s",
            (e.eventId.root,),
        )
        attempts, status, last_error, delay = await cur.fetchone() or (None, None, None, None)
    assert (attempts, status, last_error) == (1, "PENDING", "RuntimeError: broker nacked")
    assert delay is not None
    assert delay > 0.5
    assert await relay.run_once() == 0  # not due yet
    async with transaction(pool) as conn:
        rows = await conn.execute("SELECT id FROM analytics.outbox_events WHERE event_id = %s", (e.eventId.root,))
        (row_id,) = await rows.fetchone() or (None,)
        from aegis_platform.outbox import OutboxRow

        status = await REPO.mark_failed(
            conn,
            OutboxRow(
                row_id,
                uuid.UUID(e.eventId.root),
                OutboxMessage("aegispulse.intelligence", "intel.rollup.completed", e),
                19,
            ),
            "x",
        )
    assert status == "FAILED"
    async with transaction(pool) as conn:
        assert await REPO.purge_sent(conn, 0) >= 121


async def test_processed_messages_dedup_and_replay_generations(pool: AsyncConnectionPool[AsyncConnection]) -> None:
    repo = ProcessedMessagesRepository("analytics")
    event_id = uuid.uuid4()
    async with transaction(pool) as conn:
        assert await repo.mark_processed(conn, QUEUE.value, event_id, 0)
    async with transaction(pool) as conn:
        assert not await repo.mark_processed(conn, QUEUE.value, event_id, 0)
    async with transaction(pool) as conn:
        assert await repo.mark_processed(conn, QUEUE.value, event_id, 1)
    other = uuid.uuid4()

    async def mark_then_fail() -> None:
        async with transaction(pool) as conn:
            await repo.mark_processed(conn, QUEUE.value, other, 0)
            raise RuntimeError("service action failed")

    with pytest.raises(RuntimeError, match="service action failed"):
        await mark_then_fail()
    async with transaction(pool) as conn:
        assert await repo.mark_processed(conn, QUEUE.value, other, 0)  # rolled-back mark is not remembered


# ── consumer kit (FR-MSG-01) ──────────────────────────────────────────────────────────────────────────


class Recorder:
    def __init__(self) -> None:
        self.mode = "ok"
        self.received: list[DeliveryContext] = []
        self.finished: list[str] = []

    async def __call__(self, e: CanonicalEnvelope, ctx: DeliveryContext) -> Outcome | None:
        self.received.append(ctx)
        if self.mode == "transient_once" and ctx.retry_count == 0:
            raise TransientError("DEPENDENCY_UNAVAILABLE", "scanner down")
        if self.mode == "transient_always":
            raise TransientError("DEPENDENCY_UNAVAILABLE", "still down")
        if self.mode == "permanent":
            raise NotFoundError("NOT_FOUND", "fact source missing")
        if self.mode == "slow":
            await asyncio.sleep(0.7)
        self.finished.append(e.eventId.root)
        return Outcome.DUPLICATE if self.mode == "duplicate" else None


async def publish(admin: aio_pika.abc.AbstractChannel, body: bytes, headers: dict[str, Any] | None = None) -> None:
    exchange = await admin.get_exchange("aegispulse.enrichment")
    await exchange.publish(
        aio_pika.Message(
            body, headers=headers or {}, content_type="application/json", delivery_mode=aio_pika.DeliveryMode.PERSISTENT
        ),
        "classification.finalized",
    )


@pytest_asyncio.fixture(loop_scope="session")
async def consumer(broker: Broker, admin: aio_pika.abc.AbstractChannel) -> AsyncIterator[tuple[AmqpClient, Recorder]]:
    recorder = Recorder()
    client = AmqpClient(broker.runtime_url, service="data-intel-test", consumes=[QUEUE])
    await client.connect()
    await client.consume(QUEUE, recorder)
    yield client, recorder
    await client.close()


async def test_consumes_with_context_and_acks(
    consumer: tuple[AmqpClient, Recorder], admin: aio_pika.abc.AbstractChannel
) -> None:
    _, recorder = consumer
    e = envelope()
    await publish(admin, encode_envelope(e), {"traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"})
    await until(lambda: e.eventId.root in recorder.finished)
    assert recorder.received[0] == DeliveryContext(QUEUE, 0, 0, None, False)


async def test_retries_transient_through_the_real_ttl_queue(
    consumer: tuple[AmqpClient, Recorder], admin: aio_pika.abc.AbstractChannel
) -> None:
    _, recorder = consumer
    recorder.mode = "transient_once"
    e = envelope()
    started = asyncio.get_running_loop().time()
    await publish(admin, encode_envelope(e))
    await until(lambda: e.eventId.root in recorder.finished, timeout=15)
    assert [c.retry_count for c in recorder.received] == [0, 1]
    assert asyncio.get_running_loop().time() - started > 0.9
    assert await drain(admin, "intel.facts.q.dlq") == []


async def test_dead_letters_permanent_poison_and_exhausted(
    consumer: tuple[AmqpClient, Recorder], admin: aio_pika.abc.AbstractChannel
) -> None:
    _, recorder = consumer
    recorder.mode = "permanent"
    e = envelope()
    await publish(admin, encode_envelope(e))
    dead = await wait_for_message(admin, "intel.facts.q.dlq")
    assert dead.headers["x-aegis-error-code"] == "NOT_FOUND"
    assert dead.headers["x-aegis-original-queue"] == "intel.facts.q"
    assert json.loads(dead.body)["eventId"] == e.eventId.root
    await wait_for_message(admin, "events.deadletter.q")

    recorder.received.clear()
    await publish(admin, b"{not json")
    assert (await wait_for_message(admin, "intel.facts.q.dlq")).headers["x-aegis-error-code"] == "ENVELOPE_INVALID"
    assert recorder.received == []

    recorder.mode = "transient_always"
    await publish(admin, encode_envelope(envelope()), {"x-retry-count": 3})
    assert (await wait_for_message(admin, "intel.facts.q.dlq")).headers[
        "x-aegis-error-code"
    ] == "DEPENDENCY_UNAVAILABLE"


async def test_passes_replay_headers_and_acks_duplicates(
    consumer: tuple[AmqpClient, Recorder], admin: aio_pika.abc.AbstractChannel
) -> None:
    _, recorder = consumer
    recorder.mode = "duplicate"
    await publish(admin, encode_envelope(envelope()), {"x-aegis-replay-job": "job-1", "x-aegis-replay-generation": 2})
    await until(lambda: bool(recorder.received))
    assert (recorder.received[0].replay_job, recorder.received[0].replay_generation) == ("job-1", 2)
    await asyncio.sleep(0.3)
    assert (await admin.get_queue("intel.facts.q")).declaration_result.message_count == 0


async def test_close_drains_the_in_flight_handler_and_acks(broker: Broker, admin: aio_pika.abc.AbstractChannel) -> None:
    recorder = Recorder()
    recorder.mode = "slow"
    client = AmqpClient(broker.runtime_url, service="data-intel-test", consumes=[QUEUE])
    await client.connect()
    await client.consume(QUEUE, recorder)
    e = envelope()
    await publish(admin, encode_envelope(e))
    await until(lambda: bool(recorder.received))
    await client.close()
    assert e.eventId.root in recorder.finished
    await asyncio.sleep(1)
    assert await drain(admin, "intel.facts.q") == []
