---
name: messaging-engineer
description: AegisPulse RabbitMQ/event-driven messaging role. Use when adding or changing exchanges, queues, bindings, routing keys, event payloads, consumers, publishers, the outbox relay, retry/DLQ behavior, replay, or the rxjs-rabbitmq based TypeScript kit; also for AsyncAPI and envelope changes.
---

# Messaging Engineer — AegisPulse

Source of truth: `PROJECT.md` §5.5 (queues), §6.4 (envelope), §6.5 (topology and kit), §6.6 (outbox), §6.7 (catalog), §2.11 (replay), §2.15 (DLQ), ADR-0003, ADR-0004, and `docs/libs/RXJS_RABBITMQ.md`.

## Adding or changing an event (checklist)
1. Add the routing key to the §6.7 catalog (via a `PROJECT.md` amendment) and the payload schema to `packages/contracts/events/{routing.key}.v1.schema.json`.
2. Add the message to `asyncapi/aegispulse.asyncapi.yaml`. Run `make contracts` and check the breaking-change diff.
3. Producer: write via the outbox in the same transaction as the state change. For storeless services, use a deterministic UUIDv5 id with confirms.
4. Consumer queue: add it to `topology/aegispulse.topology.json` with its bindings, prefetch, retry tiers, and DLQ, then add a row to §5.5.
5. Least privilege: grant the consuming service's RabbitMQ user read on the new queue only (§5.7.3).
6. Loop check: if the archive (`#`) captures it, does Stage 1 need a no-scan rule (§1.4.2)?

## Envelope rules
- `eventId` UUIDv7 (or UUIDv5 deterministic). `correlationId` propagated unchanged. `causationId` = the triggering `eventId`.
- `classification` block always present. Producers seed it, and the Events Service is the authority.
- Payload ≤ 64 KiB and message ≤ 256 KiB. No binaries. Pointers only (`fileId`, `storageKey`, `sha256`).
- AMQP properties and headers per §6.4. `traceparent` is mandatory.
- Consumers accept the same major `schemaVersion` and ignore unknown fields. An unknown major is poison.

## Consumer contract (all languages)
```
receive → validate envelope (poison → DLQ) → set log/trace context
→ dedup (consumer, eventId, replayGeneration) if the service owns a store
→ call ONE service action
→ success: ack | TransientError: republish to aegispulse.retry/{queue}.retry.{tier} (x-retry-count+1), ack
→ PermanentError/Poison/exhausted: publish to aegispulse.dlx/{queue} with x-aegis-error-code, ack
→ republish failed: nack(requeue=true)
```
- Ack only after the service action commits. Never ack first and process later.
- Prefetch per §5.5. Keep concurrency bounded by prefetch, not by unbounded promises.
- Replay: honor `x-aegis-replay-job` and `x-aegis-replay-generation`. The archive consumer never creates records from replays.

## TypeScript kit (`packages/ts-platform/amqp`)
- Wraps `rxjs-rabbitmq` `RabbitMQClient<Queue, Exchange, RoutingKey, MessageName, PayloadMap>` with generics **generated from the topology contract**, so unknown queues and keys fail to compile.
- Consumer handlers subscribe via `client.onQueue(q).handleAll(...)` and route into the kit's pipeline above. Don't scatter `event.ack()`, `retry`, or `deadLetter` calls in handlers. The kit owns the failure policy (use `handleMessageError` semantics centrally).
- Topology is asserted by the topology Job, not by runtime clients. Configure the client with no declarations, or with `passive` checks only.
- Publisher confirms on (confirm channel). Size guard ≤ 256 KiB. `persistent: true`.
- Graceful shutdown: cancel consumers → drain in-flight → `client.close()`.

## Outbox relay
`FOR UPDATE SKIP LOCKED LIMIT 100`, 250 ms poll, publish with confirm → `SENT`. Exponential `available_at` backoff capped at 5 min, `FAILED` after 20 attempts, `aegispulse_outbox_lag_seconds`.

## Tests you must have
Redelivery ×3 → single effect. Transient → 1 s/5 s/30 s → DLQ with headers. Poison → DLQ immediately. Relay crash between publish and `SENT` → single effective event. Replay generation dedup. Archive captures the new event type exactly once.
