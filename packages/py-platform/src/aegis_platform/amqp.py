"""AMQP consumer/publisher kit on aio-pika (PROJECT.md §6.4, §6.5, FR-MSG-01, NFR-02/07/10/11).

- Runtime users never declare topology: queues and exchanges are only checked passively (``ensure=True`` on get_*).
- Publishes are confirmed and mandatory (unroutable → ``DeliveryError``) with the §6.4 properties and headers.
- Consumers: decode + validate envelope → log/trace context → ONE handler (a service action, which owns dedup via
  ``ProcessedMessagesRepository``) → ack. Failures are classified; TRANSIENT goes to ``aegispulse.retry`` /
  ``{queue}.retry.{tier}`` with ``x-retry-count+1``, PERMANENT/POISON/exhausted to ``aegispulse.dlx`` / ``{queue}``
  with error headers; the copy is confirmed before the original is acked, otherwise the original is nack-requeued.
- ``close()`` cancels consumers, waits for in-flight handlers (≤ drain timeout), then closes (NFR-11).
"""

import asyncio
import contextlib
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

import aio_pika
from aio_pika.abc import AbstractChannel, AbstractIncomingMessage, AbstractQueue, AbstractRobustConnection
from opentelemetry import trace

from aegis_contracts.envelope.canonical_envelope_v1_schema import CanonicalEnvelope
from aegis_contracts.topology import (
    DEAD_LETTER_EXCHANGE,
    RETRY_EXCHANGE,
    ExchangeName,
    QueueName,
    QueuePolicy,
    policy,
)
from aegis_platform.envelope import decode_envelope, encode_envelope, event_id, uuid_str
from aegis_platform.errors import (
    ClassifiedFailure,
    FailureKind,
    PoisonMessageError,
    classify_failure,
    dead_letter_message,
    describe_error,
    stack_hash,
)
from aegis_platform.logging import get_logger, log_context
from aegis_platform.outbox import OutboxMessage
from aegis_platform.telemetry import extract_trace_context, inject_trace_headers, meter, tracer

log = get_logger(__name__)

RETRY_COUNT = "x-retry-count"
TENANT = "x-aegis-tenant"
SCHEMA_VERSION = "x-aegis-schema-version"
REPLAY_JOB = "x-aegis-replay-job"
REPLAY_GENERATION = "x-aegis-replay-generation"
ERROR_CODE = "x-aegis-error-code"
ORIGINAL_QUEUE = "x-aegis-original-queue"
ERROR_MESSAGE = "x-aegis-error-message"
ERROR_STACK_HASH = "x-aegis-error-stack-hash"


class Outcome(StrEnum):
    """Return DUPLICATE when the service's dedup check found the message already processed; acked either way."""

    PROCESSED = "processed"
    DUPLICATE = "duplicate"


@dataclass(frozen=True, slots=True)
class DeliveryContext:
    queue: QueueName
    retry_count: int
    replay_generation: int
    replay_job: str | None
    redelivered: bool


EnvelopeHandler = Callable[[CanonicalEnvelope, DeliveryContext], Awaitable[Outcome | None]]


class RouteAction(StrEnum):
    RETRY = "retry"
    DEAD_LETTER = "dead_letter"
    REQUEUE = "requeue"


@dataclass(frozen=True, slots=True)
class FailureRoute:
    action: RouteAction
    routing_key: str | None


def failure_route(queue_policy: QueuePolicy, retry_count: int, failure: ClassifiedFailure) -> FailureRoute:
    """Pure decision (FR-MSG-01)."""
    if failure.kind is FailureKind.TRANSIENT and retry_count < len(queue_policy.retry_tiers):
        tier = queue_policy.retry_tiers[retry_count]
        return FailureRoute(RouteAction.RETRY, f"{queue_policy.queue.value}.retry.{tier}")
    if queue_policy.dead_letter:
        return FailureRoute(RouteAction.DEAD_LETTER, queue_policy.queue.value)
    return FailureRoute(RouteAction.REQUEUE, None)


def header_int(headers: Mapping[str, Any], name: str) -> int:
    raw = headers.get(name)
    if isinstance(raw, bool):
        return 0
    if isinstance(raw, int):
        return raw if 0 <= raw < 2**31 else 0
    if isinstance(raw, bytes):
        raw = raw.decode("ascii", "replace")
    if isinstance(raw, str) and raw.isdigit() and len(raw) <= 9:
        return int(raw)
    return 0


class AmqpClient:
    """One robust connection; a confirm channel for publishing and one channel per consumed queue (own prefetch)."""

    def __init__(
        self,
        url: str,
        *,
        service: str,
        consumes: Sequence[QueueName] = (),
        publishes_to: Sequence[ExchangeName] = (),
        confirm_timeout_s: float = 10.0,
        drain_timeout_s: float = 20.0,
    ) -> None:
        self._url = url
        self._service = service
        self._consumes = tuple(consumes)
        exchanges = set(publishes_to)
        if self._consumes:
            exchanges |= {RETRY_EXCHANGE, DEAD_LETTER_EXCHANGE}
        self._exchanges = tuple(sorted(exchanges))
        self._confirm_timeout = confirm_timeout_s
        self._drain_timeout = drain_timeout_s
        self._connection: AbstractRobustConnection | None = None
        self._publish_channel: AbstractChannel | None = None
        self._consumers: list[tuple[AbstractQueue, str]] = []
        self._in_flight: set[asyncio.Task[None]] = set()
        self._closing = False
        self._processed = meter().create_counter(
            "aegispulse_consumer_processed_total", description="Consumer deliveries by queue and outcome"
        )

    @property
    def is_ready(self) -> bool:
        return (
            not self._closing
            and self._connection is not None
            and not self._connection.is_closed
            and self._publish_channel is not None
            and not self._publish_channel.is_closed
        )

    async def ready_check(self) -> None:
        """Readiness check (NFR-11 d)."""
        if not self.is_ready:
            raise RuntimeError("amqp client is not ready")

    async def connect(self) -> None:
        """Connect and verify topology passively (configure '^$' compatible). Use inside connect_with_retry."""
        connection = await aio_pika.connect_robust(self._url, client_properties={"connection_name": self._service})
        channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
        for exchange in self._exchanges:
            await channel.get_exchange(exchange.value, ensure=True)
        for queue in self._consumes:
            await channel.get_queue(queue.value, ensure=True)
        self._connection = connection
        self._publish_channel = channel

    def _channel(self) -> AbstractChannel:
        if self._publish_channel is None or self._closing:
            raise RuntimeError("amqp client is not connected")
        return self._publish_channel

    async def _publish(self, message: aio_pika.Message, exchange: str, routing_key: str) -> None:
        inject_trace_headers(message.headers)
        target = await self._channel().get_exchange(exchange, ensure=False)
        await target.publish(message, routing_key, mandatory=True, timeout=self._confirm_timeout)

    async def publish_envelope(self, message: OutboxMessage) -> None:
        """Confirmed + mandatory publish with §6.4 properties; raises on nack, return or timeout."""
        e = message.envelope
        headers: dict[str, Any] = {SCHEMA_VERSION: e.schemaVersion}
        tenant = uuid_str(e.tenantId)
        if tenant is not None:
            headers[TENANT] = tenant
        await self._publish(
            aio_pika.Message(
                encode_envelope(e),
                headers=headers,
                content_type="application/json",
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                message_id=event_id(e),
                correlation_id=e.correlationId,
                type=e.eventType,
                timestamp=time.time(),
            ),
            message.exchange,
            message.routing_key,
        )

    async def _republish(
        self, original: AbstractIncomingMessage, exchange: str, routing_key: str, extra: dict[str, Any]
    ) -> None:
        headers: dict[str, Any] = {k: v for k, v in dict(original.headers).items() if k != "x-death"}
        headers.update(extra)
        await self._publish(
            aio_pika.Message(
                original.body,
                headers=headers,
                content_type=original.content_type,
                delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
                message_id=original.message_id,
                correlation_id=original.correlation_id,
                type=original.type,
                timestamp=original.timestamp,
            ),
            exchange,
            routing_key,
        )

    async def consume(self, queue: QueueName, handler: EnvelopeHandler) -> None:
        """Start a manual-ack consumer for a work queue with its contract prefetch."""
        queue_policy = policy(queue)
        if self._connection is None:
            raise RuntimeError("amqp client is not connected")
        channel = await self._connection.channel(publisher_confirms=False)
        await channel.set_qos(prefetch_count=queue_policy.prefetch)
        amqp_queue = await channel.get_queue(queue.value, ensure=True)

        async def on_message(message: AbstractIncomingMessage) -> None:
            task = asyncio.current_task()
            if task is not None:
                self._in_flight.add(task)
            try:
                await self._handle(queue_policy, handler, message)
            finally:
                if task is not None:
                    self._in_flight.discard(task)

        tag = await amqp_queue.consume(on_message, no_ack=False)
        self._consumers.append((amqp_queue, tag))

    async def _handle(
        self, queue_policy: QueuePolicy, handler: EnvelopeHandler, message: AbstractIncomingMessage
    ) -> None:
        headers = dict(message.headers)
        retry_count = header_int(headers, RETRY_COUNT)
        queue = queue_policy.queue
        try:
            envelope = decode_envelope(message.body)
        except PoisonMessageError as e:
            self._count(queue, await self._settle_failure(queue_policy, message, retry_count, e))
            return
        replay_job = headers.get(REPLAY_JOB)
        context = DeliveryContext(
            queue=queue,
            retry_count=retry_count,
            replay_generation=header_int(headers, REPLAY_GENERATION),
            replay_job=replay_job.decode()
            if isinstance(replay_job, bytes)
            else (replay_job if isinstance(replay_job, str) else None),
            redelivered=bool(message.redelivered),
        )
        parent = extract_trace_context(headers)
        with (
            log_context(
                correlationId=envelope.correlationId,
                tenantId=uuid_str(envelope.tenantId),
                eventId=event_id(envelope),
            ),
            tracer().start_as_current_span(
                f"{queue.value} process",
                context=parent,
                kind=trace.SpanKind.CONSUMER,
                attributes={
                    "messaging.system": "rabbitmq",
                    "messaging.destination.name": queue.value,
                    "messaging.message.id": event_id(envelope),
                    "aegis.event_type": envelope.eventType,
                    "aegis.retry_count": retry_count,
                },
            ),
        ):
            try:
                result = await handler(envelope, context)
                await message.ack()
                outcome = "duplicate" if result is Outcome.DUPLICATE else "success"
            except Exception as e:  # noqa: BLE001 — every failure is classified and routed (NFR-07 no silent failures)
                outcome = await self._settle_failure(queue_policy, message, retry_count, e)
        self._count(queue, outcome)

    async def _settle_failure(
        self, queue_policy: QueuePolicy, message: AbstractIncomingMessage, retry_count: int, error: BaseException
    ) -> str:
        failure = classify_failure(error)
        route = failure_route(queue_policy, retry_count, failure)
        fields = {
            "code": failure.code,
            "kind": failure.kind.value,
            "retryCount": retry_count,
            "err": describe_error(error),
        }
        try:
            if route.action is RouteAction.RETRY and route.routing_key is not None:
                await self._republish(message, RETRY_EXCHANGE.value, route.routing_key, {RETRY_COUNT: retry_count + 1})
                await message.ack()
                log.warning("handler failed; scheduled retry", tier=route.routing_key, **fields)
                return "retry"
            if route.action is RouteAction.DEAD_LETTER:
                await self._republish(
                    message,
                    DEAD_LETTER_EXCHANGE.value,
                    queue_policy.queue.value,
                    {
                        ERROR_CODE: failure.code,
                        ORIGINAL_QUEUE: queue_policy.queue.value,
                        ERROR_MESSAGE: dead_letter_message(error),
                        ERROR_STACK_HASH: stack_hash(error),
                    },
                )
                await message.ack()
                log.error("message dead-lettered", **fields)
                return "dead_letter"
            await message.nack(requeue=True)
            log.error("handler failed on a queue without DLQ; requeued", **fields)
            return "requeue"
        except Exception as republish_error:  # noqa: BLE001 — never lose the original: requeue it
            with contextlib.suppress(Exception):
                await message.nack(requeue=True)
            log.error(
                "retry/DLQ republish failed; original requeued", republishErr=describe_error(republish_error), **fields
            )
            return "requeue"

    def _count(self, queue: QueueName, outcome: str) -> None:
        self._processed.add(1, {"queue": queue.value, "outcome": outcome})

    async def stop_consuming(self) -> None:
        for amqp_queue, tag in self._consumers:
            with contextlib.suppress(Exception):
                await amqp_queue.cancel(tag)
        self._consumers.clear()

    async def close(self) -> None:
        """Cancel consumers, wait for in-flight handlers (≤ drain timeout), then close. Never reconnects afterwards."""
        await self.stop_consuming()
        if self._in_flight:
            _, pending = await asyncio.wait(set(self._in_flight), timeout=self._drain_timeout)
            if pending:
                log.warning("drain timeout; unsettled deliveries will be redelivered", inFlight=len(pending))
        self._closing = True
        if self._connection is not None:
            await self._connection.close()
