"""Transactional outbox (§6.6, ADR-0004) on psycopg 3.

``enqueue`` joins the caller's transaction; the relay claims due rows with FOR UPDATE SKIP LOCKED, publishes with
confirms, and marks SENT or backs off (2^n s, cap 5 min, FAILED after 20 attempts).
"""

import asyncio
import contextlib
import json
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from opentelemetry.metrics import Observation
from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool

from aegis_contracts.envelope.canonical_envelope_v1_schema import CanonicalEnvelope
from aegis_platform.db import qualified, transaction
from aegis_platform.envelope import encode_envelope, event_id, uuid_str
from aegis_platform.errors import describe_error
from aegis_platform.logging import get_logger
from aegis_platform.telemetry import meter

MAX_ATTEMPTS = 20
MAX_BACKOFF_S = 300
log = get_logger(__name__)


@dataclass(frozen=True, slots=True)
class OutboxMessage:
    exchange: str
    routing_key: str
    envelope: CanonicalEnvelope

    def __post_init__(self) -> None:
        if self.routing_key != self.envelope.eventType:
            raise ValueError("routing key must equal eventType")


@dataclass(frozen=True, slots=True)
class OutboxRow:
    id: uuid.UUID
    event_id: uuid.UUID
    message: OutboxMessage
    attempts: int


def backoff_seconds(attempts: int) -> int:
    return MAX_BACKOFF_S if attempts >= 9 else min(1 << attempts, MAX_BACKOFF_S)


Publisher = Callable[[OutboxMessage], Awaitable[None]]


class OutboxRepository:
    def __init__(self, schema: str) -> None:
        self._table = qualified(schema, "outbox_events")

    async def enqueue(self, conn: AsyncConnection, message: OutboxMessage) -> bool:
        e = message.envelope
        cur = await conn.execute(
            f"INSERT INTO {self._table} (tenant_id, event_id, exchange, routing_key, envelope) "  # noqa: S608
            "VALUES (%s, %s, %s, %s, %s::jsonb) ON CONFLICT (event_id) DO NOTHING",
            (uuid_str(e.tenantId), event_id(e), message.exchange, message.routing_key, encode_envelope(e).decode()),
        )
        return cur.rowcount == 1

    async def claim_batch(self, conn: AsyncConnection, limit: int = 100) -> list[OutboxRow]:
        cur = await conn.execute(
            f"SELECT id, event_id, exchange, routing_key, envelope::text, attempts FROM {self._table} "  # noqa: S608
            "WHERE status = 'PENDING' AND available_at <= now() ORDER BY available_at LIMIT %s FOR UPDATE SKIP LOCKED",
            (limit,),
        )
        rows = await cur.fetchall()
        return [
            OutboxRow(r[0], r[1], OutboxMessage(r[2], r[3], CanonicalEnvelope.model_validate(json.loads(r[4]))), r[5])
            for r in rows
        ]

    async def mark_sent(self, conn: AsyncConnection, ids: list[uuid.UUID]) -> None:
        if ids:
            await conn.execute(
                f"UPDATE {self._table} SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = ANY(%s)",  # noqa: S608
                (ids,),
            )

    async def mark_failed(self, conn: AsyncConnection, row: OutboxRow, error: str) -> str:
        attempts = row.attempts + 1
        status = "FAILED" if attempts >= MAX_ATTEMPTS else "PENDING"
        await conn.execute(
            f"UPDATE {self._table} SET attempts = %s, status = %s, last_error = %s, "  # noqa: S608
            "available_at = now() + make_interval(secs => %s) WHERE id = %s",
            (attempts, status, error[:1000], backoff_seconds(attempts), row.id),
        )
        return status

    async def purge_sent(self, conn: AsyncConnection, days: int = 7) -> int:
        cur = await conn.execute(
            f"DELETE FROM {self._table} WHERE status = 'SENT' AND sent_at < now() - make_interval(days => %s)",  # noqa: S608
            (days,),
        )
        return cur.rowcount

    async def lag_seconds(self, conn: AsyncConnection) -> float:
        cur = await conn.execute(
            f"SELECT EXTRACT(EPOCH FROM (now() - min(created_at)))::float8 FROM {self._table} WHERE status = 'PENDING'"  # noqa: S608
        )
        row = await cur.fetchone()
        return max(0.0, row[0]) if row is not None and row[0] is not None else 0.0


class OutboxRelay:
    """Polls every ``interval_s``; ``stop()`` finishes the in-flight batch (NFR-11).

    Exposes ``aegispulse_outbox_lag_seconds``.
    """

    def __init__(
        self,
        pool: AsyncConnectionPool[AsyncConnection],
        repository: OutboxRepository,
        publish: Publisher,
        *,
        interval_s: float = 0.25,
        batch_size: int = 100,
    ) -> None:
        self._pool = pool
        self._repo = repository
        self._publish = publish
        self._interval = interval_s
        self._batch = batch_size
        self._lag = 0.0
        self._task: asyncio.Task[None] | None = None
        self._stopping = asyncio.Event()
        self._lock = asyncio.Lock()
        meter().create_observable_gauge(
            "aegispulse_outbox_lag_seconds",
            callbacks=[lambda _: [Observation(self._lag)]],
            unit="s",
            description="Age of the oldest PENDING outbox row",
        )

    @property
    def lag_seconds(self) -> float:
        return self._lag

    async def run_once(self) -> int:
        async with self._lock, transaction(self._pool) as conn:
            rows = await self._repo.claim_batch(conn, self._batch)
            results = await asyncio.gather(*(self._publish(r.message) for r in rows), return_exceptions=True)
            sent: list[uuid.UUID] = []
            for row, result in zip(rows, results, strict=True):
                if not isinstance(result, BaseException):
                    sent.append(row.id)
                    continue
                reason = describe_error(result)
                status = await self._repo.mark_failed(conn, row, reason)
                fields = {"eventId": str(row.event_id), "attempts": row.attempts + 1, "err": reason}
                if status == "FAILED":
                    log.error("outbox row FAILED after max attempts", **fields)
                else:
                    log.warning("outbox publish failed; backing off", **fields)
            await self._repo.mark_sent(conn, sent)
            self._lag = await self._repo.lag_seconds(conn)
            return len(rows)

    async def _loop(self) -> None:
        while not self._stopping.is_set():
            processed = 0
            try:
                processed = await self.run_once()
            except Exception as e:  # noqa: BLE001 — logged; the relay keeps polling
                log.error("outbox relay poll failed", err=describe_error(e))
            if processed < self._batch:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self._stopping.wait(), self._interval)

    def start(self) -> None:
        self._stopping.clear()
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        self._stopping.set()
        if self._task is not None:
            await self._task
