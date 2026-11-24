# Spec — FR-MSG-01 / FR-MSG-02 / FR-MSG-03 / FR-MSG-04 — Messaging resilience & dead letters

| | |
|---|---|
| Phase | 07 — Messaging Resilience & Dead Letters (`PROJECT.md` §11) |
| Owner runtime(s) | consumer kits (`packages/ts-platform`, `packages/java-platform`, `packages/py-platform`); `services/events` (dead-letter registry + admin actions); `gateway/nest-http` (`/v1/ops/dead-letters*`) |
| Status | RUNTIME-VERIFIED locally (see `docs/evidence/phase-07.md`); FR-MSG-04 alert-fires-in-dev evidence is Phase 18 |
| Related NFRs | NFR-02 (idempotent consumers), NFR-07 (no silent failures, metrics), NFR-10 (bounded retries), NFR-11 (graceful drain) |
| Related ADRs | ADR-0002 (layering), ADR-0004 (outbox), ADR-0009 (pointers only on the broker) |

## 1. Requirement (verbatim from PROJECT.md §2)
> - **FR-MSG-01**: Every consumer uses the platform consumer kit (§6.5): manual ack after successful processing, prefetch per §5.5, retry tiers `1 s → 5 s → 30 s` via TTL queues with `x-retry-count`, then dead-letter to `{queue}.dlq` via `aegispulse.dlx`. Errors are classified: `TRANSIENT` (retry), `PERMANENT`/`POISON` (DLQ immediately).
> - **FR-MSG-02**: Dead-letter registry consumer (`events.deadletter.q`, bound to all `*.dlq` via `aegispulse.dlx` routing `#`) stores each dead letter in Mongo `dead_letters` (original envelope, headers, queue, error code/message/stack hash, retry count, first/last failure time) and acks; emits `ops.dead_letter.recorded`.
> - **FR-MSG-03**: `GET /v1/ops/dead-letters` (`PLATFORM_ADMIN`; `TENANT_ADMIN` sees own tenant) lists/filters by queue, error code, date; `GET .../{id}` shows details; `POST .../{id}/replay` republishes to the original queue with `x-retry-count = 0` and marks `REPLAYED`; `POST .../{id}/discard` marks `DISCARDED` with reason. Audited: both emit `ops.audit.dead_letter_resolved` (FR-AUD-02) through the Mongo outbox with the status change.
> - **FR-MSG-04**: OpenObserve alert: dead letters > 10 in 5 min or any `*.dlq` depth > 0 for 10 min → ntfy (N-04).

## 2. Behavior
**Kits (FR-MSG-01).** Unchanged classification (`docs/steering/quality.md`). The DLQ republish now also sets the §6.4 DLQ-only headers `x-aegis-error-message` (the log-safe description, ≤ 500 chars) and `x-aegis-error-stack-hash` (16 hex; error type + top 10 frames without line numbers). The republish stays confirm-then-ack: if the DLQ/retry copy is not confirmed, the original is nack-requeued and redelivered.

**Consumer error mappings (FR-MSG-01 "each consumer declares its mapping").** Consumers added in later phases declare theirs in their own specs.

| Queue → action | TRANSIENT (retry 1 s/5 s/30 s, then DLQ) | PERMANENT (DLQ now) | POISON (DLQ now) |
|---|---|---|---|
| `files.validation.q` → `files.validateUploadedFile` | clamd unreachable/timeout (`DEPENDENCY_UNAVAILABLE`), object-store or DB errors, unknown errors (`INTERNAL_ERROR`) | `NOT_FOUND` (file missing in its tenant), other domain errors | invalid envelope (`ENVELOPE_INVALID`); not a `file.uploaded` (`VALIDATION_ERROR`) |
| `events.archive.q` → `events.archiveEvent` | Mongo/registry/object-store errors, unknown errors | domain errors | invalid envelope (`ENVELOPE_INVALID`, FR-EVT-01) |
| `events.deadletter.q` → `events.recordDeadLetter` | n/a: no DLQ; any failure waits 5 s and requeues (`consumeRaw`) | n/a | n/a: bodies are recorded raw, never rejected |

**Recording (FR-MSG-02), `events.recordDeadLetter`.** `events.deadletter.q` is consumed raw (kit `consumeRaw`): bodies may be poison, so there is no envelope validation. On failure the kit retries in process, holding the delivery, with backoff 5 s doubling to 60 s. After 20 min, or on shutdown, it nack-requeues. It never dead-letters again (§5.5 note). The quorum `x-delivery-limit: 10` is reached only after about 10 × 20 min of store outage; a fixed 5 s requeue would lose a dead letter after about 50 s.
1. Domain `deadLetterFacts` turns the delivery into facts, and never throws:
   - `queue`: the `x-aegis-original-queue` header, falling back to the DLQ routing key.
   - `eventId`, `tenantId`, `eventType`: from the envelope when the body is a JSON object with valid UUIDs. `tenantId` falls back to the `x-aegis-tenant` header. A broker-stamped `messageId` is **not** an event id.
   - `routingKey`: equals `eventType`, because producers publish with routingKey = eventType.
   - `envelope`: the body when it is a JSON object; otherwise `rawBody`, the text bounded to 256 KiB.
   - `bodySha256`; headers made JSON-safe (Buffers to text, dates to ISO, bigint to string, depth ≤ 8).
   - `errorCode` (`UNKNOWN` when missing), `errorMessage` (≤ 500), `stackHash` and `retryCount` from the headers.
2. In one Mongo transaction, upsert the **OPEN** record for (queue, `identityKey`), where `identityKey` is the eventId, or `sha256:{bodySha256}` when eventId is null. The partial unique index from migration `20261124000001-dead-letter-open-identity.cjs` enforces one OPEN record. A concurrent recording that loses (E11000) reruns the transaction and updates the winner.
   - Insert: `firstFailedAt = lastFailedAt = now`, `occurrences = 1`.
   - Repeat while OPEN: refresh the failure facts and `lastFailedAt`, and increment `occurrences`.
   - When a record **opens**, enqueue `ops.dead_letter.recorded`, except when the dead letter is itself an `ops.dead_letter.recorded` (no feedback loop through `events.archive.q`).
3. Metric `aegispulse_dead_letters_recorded_total{queue}` +1. Every work queue's series is primed at 0 on startup, so `increase()` also counts a queue's first dead letter. Log `dead_letter.recorded` with ids, queue, code, stack hash and `occurrences`, never the body.

After a replay or discard, a new failure of the same message opens a **new** record. The history is kept, and the unique index `{queue, eventId, lastFailedAt}` holds.

**Admin actions (FR-MSG-03).**
- **Visibility:**
  - The contract roles (PA, TA) are re-checked in the service; SERVICE principals get 403.
  - `PLATFORM_ADMIN` sees every tenant, including tenantless poison, and may narrow to one tenant with `X-Aegis-Tenant`.
  - Any other caller is held to the own tenant; sending the header is 403.
  - Another tenant's record is 404 `DEAD_LETTER_NOT_FOUND`, the same as an unknown or malformed id.
- **List:** filters `queue`, `errorCode`, `from`/`to` on `lastFailedAt`. Sorted `lastFailedAt desc, _id desc` with a keyset cursor; `limit` ≤ 100, default 50.
- **Replay** (people only, since the audit payload names the user; integration principals get 403):
  1. The record must be OPEN.
  2. In one transaction, the conditional update `OPEN → REPLAYED` (`resolvedBy`, `resolvedAt`) runs and `ops.audit.dead_letter_resolved` is enqueued.
  3. The stored bytes (envelope or raw body) are republished **before commit**, with the original headers minus DLQ-only and broker headers and with `x-retry-count = 0`.
  4. The republish goes to `aegispulse.retry` with the routing key of the original queue's **shortest retry/delay queue**, whose TTL dead-letters into the original queue (e.g. `files.validation.q.retry.1s`, 1 s; `cases.enrichment-timer.q.delay.10m`). Runtime users may write `aegispulse.retry` (§5.7.3), so no default-exchange grant is needed.
  5. If the broker does not confirm, the transaction aborts, the record stays OPEN and the caller gets 503 `DEPENDENCY_UNAVAILABLE`. A queue with no route back gets 422.
  6. The transaction is driven explicitly, not with `withTransaction`, whose retries would re-run the publish.
     - A `TransientTransactionError` before the publish reruns the attempt. After the publish only the commit is retried (`UnknownTransactionCommitResult`).
     - If the commit still fails, the message is back on its queue while the record stays OPEN. That is an accepted at-least-once replay: consumers dedupe by eventId (NFR-02), and a poison replay carries the stable `messageId` `dead-letter-{id}`.
     - This is not an outbox exception: a replay re-delivers a stored message, it does not announce a state change. The audit event still goes through the outbox in the same transaction as the status change.
- **Discard** (people only): a `reason` of 1–500 chars after trimming. `OPEN → DISCARDED` and the audit event are written in one transaction.
- **Repeats:**
  - The identical resolution again (same action, actor and reason) is a no-op that returns the record.
  - Any other resolution of a resolved record is 409 `DEAD_LETTER_ALREADY_RESOLVED`.
  - When two requests race, the conditional update decides and the loser is re-evaluated by the same rule.
- **Audit tenant:** `ops.audit.dead_letter_resolved` carries the record's tenant. Tenantless records (platform traffic, unreadable poison) are audited under the reserved platform tenant (FR-TEN-09).

**Alerting (FR-MSG-04).** `deploy/observability/alerts/dlq-spike.json` holds two OpenObserve v2 scheduled PromQL alerts to the per-environment destination `aegispulse-ntfy`:
- `aegispulse-dlq-spike`: `sum(increase(aegispulse_dead_letters_recorded_total[5m])) > 10`.
- `aegispulse-dlq-depth`: `max by (queue)(min_over_time(rabbitmq_queue_messages_ready{queue=~".+\.dlq"}[10m])) > 0`. This needs RabbitMQ per-object metrics in the cluster.

`make check-dlq-alert` is the local equivalent. It evaluates the same PromQL against local OpenObserve and checks DLQ depth with `rabbitmqctl`, because no broker metrics are shipped locally. Exit code 1 means an alert is firing.

**Security review fixes (security-reviewer, 2026-11-24).**
- **H1, unmasked payloads:** every API view (list, detail, replay/discard responses) runs the rules-v1 detectors over the envelope, raw body, string headers and error message, and returns `redactions[]`. The stored bytes stay unmasked only for replay. Resolved records expire 30 days after resolution (`expireAt`, TTL index); OPEN records are kept until resolved.
- **M1, error text:** `x-aegis-error-message` carries the full description only for the kits' own error types. Any other exception carries `"{Type} (message withheld)"`. Implemented as TS `deadLetterMessage`, Python `dead_letter_message` and Java `ConsumerFailure.deadLetterMessage`.
- **M2, tenant drift:** `identityKey = "{tenantId|-}|{eventId | sha256:{hash}}"`, so a dead letter naming another tenant opens its own record.
- **L1, queue from routing key:** `queue` is the routing key. A disagreeing `x-aegis-original-queue` sets `queueHeaderMismatch`, and such records are never replayed (422).
- **L2, poison integrity:** a poison replay is refused unless the stored raw body still hashes to `bodySha256`.

## 3. Data & migrations
- Mongo `dead_letters`: the collection and base indexes come from the baseline migration. New `20261124000001-dead-letter-open-identity.cjs` backfills `identityKey` and adds the partial unique index `ux_open_queue_identity {queue, identityKey}` where `status = OPEN`. Events `/readyz` requires it (`REQUIRED_MIGRATION`).
- `20261124000002-dead-letter-tenant-identity-retention.cjs` recomputes `identityKey` with the tenant, stamps `expireAt` on resolved records, and adds the TTL index `ttl_resolved_expire_at`. Events `/readyz` requires it.
- Stored fields, as §7.6 plus the registry's own: `eventType`, `rawBody`, `bodySha256`, `identityKey`, `queueHeaderMismatch`, `occurrences`, `expireAt`.
- Mongo `outbox`: `ops.dead_letter.recorded` and `ops.audit.dead_letter_resolved` rows.
- Tenant isolation is done by the repository filter (`tenantId` for non-PA), since Mongo has no RLS.

## 4. Contracts
- Internal actions (§6.2): `events.listDeadLetters`, `getDeadLetter`, `replayDeadLetter`, `discardDeadLetter`; consumer action `recordDeadLetter` (`packages/contracts/openapi/events.internal.yaml`). `DeadLetter` adds `rawBody` and `occurrences`.
- Public routes: `GET /v1/ops/dead-letters`, `GET /v1/ops/dead-letters/{id}`, `POST …/{id}/replay`, `POST …/{id}/discard` (PA, TA).
- Errors: `DEAD_LETTER_NOT_FOUND` (404), `DEAD_LETTER_ALREADY_RESOLVED` (409), `VALIDATION_ERROR` (422), `FORBIDDEN` (403), `DEPENDENCY_UNAVAILABLE` (503).
- Events:
  - `ops.dead_letter.recorded` (`packages/contracts/events/ops.dead_letter.recorded.v1.schema.json`).
  - `ops.audit.dead_letter_resolved` (`…/ops.audit.dead_letter_resolved.v1.schema.json`, amendment 2026-11-24).
  - Both go out on `aegispulse.intelligence`.
- Envelope headers (§6.4): `x-aegis-error-message`, `x-aegis-error-stack-hash` (amendment 2026-11-24).

## 5. Layer placement
| Piece | File |
|---|---|
| Domain (pure) | `services/events/src/domain/dead-letter.ts` |
| Service / use case | `services/events/src/service/dead-letter.service.ts`; event builders in `src/service/events.ts` |
| Repository | `services/events/src/db/dead-letter.repository.ts` |
| Replay port adapter | `services/events/src/storage/dead-letter-replay.ts` (kit `publishRaw` + `replayRoute`) |
| Internal route adapter | `services/events/src/adapters/http/dead-letters.routes.ts` |
| Consumer adapter | `services/events/src/adapters/amqp/deadletter.consumer.ts` (kit `consumeRaw`) |
| Gateway handler + client | `gateway/nest-http/src/modules/ops/dead-letters.controller.ts`, `src/clients/events.client.ts` |
| Kits | `packages/ts-platform/src/{amqp,errors}/index.ts`; Java `ConsumerFailure.stackHash`, `EnvelopeListener`, `Headers`; Python `errors.stack_hash`, `amqp.py` |

## 6. Security & observability
- **Authz:** as in §2. The gateway validates only the id shape (local 404) and forwards the token, `X-Aegis-Tenant` and `Idempotency-Key`.
- **Data exposure:** dead-letter detail contains the original envelope, so it is visible only to PA and the owning TA. Logs and events never carry bodies, only ids, queue, code and stack hash.
- **Error messages** in headers are the kits' log-safe descriptions; `docs/steering/quality.md` forbids payload values in error messages.
- **Telemetry:** metric `aegispulse_dead_letters_recorded_total{queue}`; consumer counter `aegispulse_consumer_processed_total{queue,outcome}` (outcome `requeue` for registry failures); log events `dead_letter.recorded`, `dead_letter.replayed`, `dead_letter.discarded`.

## 7. Test plan
| Level | Test name (includes FR id) | Proves |
|---|---|---|
| Unit | `errors.test.ts` "hashes the error name + stack frames … (FR-MSG-02)"; Java `stackHashGroupsBySiteNotMessage_FR_MSG_02`; Python `test_stack_hash_groups_by_site_not_message_fr_msg_02` | stack hash stable per call site, independent of message and line shifts |
| Unit | `amqp.test.ts` "replayRoute (FR-MSG-03 …)" | shortest retry/delay route per queue; none for `events.deadletter.q` |
| Unit | `services/events/src/domain/dead-letter.test.ts` | facts from envelope/headers, poison handling, header JSON-safety, replay headers/body, repeat rule |
| Integration | TS `consumer.integration.test.ts` "walks the full 1 s → 5 s → 30 s retry chain …", "leaves the original on its queue … when the DLQ republish fails", DLQ header assertions | FR-MSG-01 per kit against RabbitMQ 4 |
| Integration | Java `walksTheFullRetryChainWithIncreasingDelaysThenDeadLetters_FR_MSG_01`, `requeuesTheOriginalWhenTheDeadLetterRepublishFails_FR_MSG_01` | same, Java kit |
| Integration | Python `test_walks_the_full_retry_chain_with_increasing_delays_then_dead_letters`, `test_requeues_the_original_when_the_dead_letter_republish_fails` | same, Python kit |
| Integration | `services/events/tests/integration/dead-letters.integration.test.ts` (8 tests) | failure → registry → recorded event; poison; repeats; loop guard; visibility; replay after fix → processed once; discard; new record after replay |
| Gateway unit | `files.test.ts` "dead-letter routes over the gateway (FR-MSG-03)" | forwarding, local 404 |
| E2E | `tests/e2e/dead-letters.e2e.test.ts`, role matrix "Phase 7" | routes × roles over the compose stack |
| Runtime | `make demo-dlq`, `make check-dlq-alert` | Phase 7 exit demo; local alert equivalent |

## 8. Acceptance (runtime evidence required)
- [x] Forced failure demo (ClamAV stopped as the failing scanner): retry timings 1 s / 5 s / 30 s, registry entry with code, message and stack hash, replay → VALIDATED, ops events archived (`docs/evidence/phase-07.md`).
- [x] `make check-dlq-alert` fires for 11 synthetic dead letters in 5 min and for non-empty DLQs (local pre-check).
- [ ] FR-MSG-04 alert firing to ntfy in dev (Phase 18 evidence, as planned in §11).
