# Phase 07 — Messaging Resilience & Dead Letters — Exit Evidence

| | |
|---|---|
| Commit SHA | `46ccd5e` + uncommitted Phase 7 work |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local compose stack (RabbitMQ 4.4.1, MongoDB 8 rs0, ClamAV 1.5.5, OpenObserve v1.1.2), with every runtime image rebuilt from this tree; Testcontainers suites |
| Pipeline | pending |
| Verified by | Claude Code (Opus); every command below was run by Claude Code |
| Resulting status | `RUNTIME-VERIFIED` locally; architecture and security reviews addressed. Open: pipelines, merge to `main`, clean-state run. FR-MSG-04 dev alert test → Phase 18 |

Spec: [FR-MSG-01-04](../specs/FR-MSG-01-04-messaging-resilience.md) · Runbook: [dlq.md](../runbooks/dlq.md). The amendments behind it, owner-approved 2026-11-24:
- the §6.4 DLQ headers `x-aegis-error-message` and `x-aegis-error-stack-hash`;
- the event `ops.audit.dead_letter_resolved`.

## §11 exit item — forced failure demo, retry timings, registry entry, replay
`make demo-dlq` stops ClamAV, the real scanner dependency, so that file validation fails `TRANSIENT`. This stands in for the "scanner stub returning 500". The demo then uploads a clean PDF, waits for the dead letter, restarts ClamAV, replays the dead letter as the bootstrap PLATFORM_ADMIN through the gateway, and waits for the outcome:
```
demo-dlq: 1. stopping ClamAV (the scanner dependency) to force TRANSIENT failures
demo-dlq: 2. uploaded dlq-demo.pdf (fileId bb706e2c-de07-40ac-8454-18a7f15bde9c); file.uploaded → files.validation.q
demo-dlq: 3. waiting for retries (1 s, 5 s, 30 s) and the dead-letter registry entry …
demo-dlq:    2026-11-24T20:54:20.909Z  retryCount=0  handler failed; scheduled retry → files.validation.q.retry.1s  code=DEPENDENCY_UNAVAILABLE
demo-dlq:    2026-11-24T20:54:21.940Z  retryCount=1  handler failed; scheduled retry → files.validation.q.retry.5s  code=DEPENDENCY_UNAVAILABLE
demo-dlq:    2026-11-24T20:54:26.960Z  retryCount=2  handler failed; scheduled retry → files.validation.q.retry.30s  code=DEPENDENCY_UNAVAILABLE
demo-dlq:    2026-11-24T20:54:56.985Z  retryCount=3  message dead-lettered  code=DEPENDENCY_UNAVAILABLE
demo-dlq:    registry: id=6b05f9a05a7e2522f400195d status=OPEN errorCode=DEPENDENCY_UNAVAILABLE retryCount=3 stackHash=365bcc42ac455be2 (36 s after complete)
demo-dlq:    errorMessage: TransientError[DEPENDENCY_UNAVAILABLE]: clamd unreachable
demo-dlq:    file status while dead-lettered: UPLOADED
demo-dlq: 4. restarting ClamAV and waiting until it is healthy …
demo-dlq: 5. replaying the dead letter (POST /v1/ops/dead-letters/{id}/replay)
demo-dlq:    status=REPLAYED resolvedBy=user:508c5c14-ffdc-40ee-abf9-e1f166cafe28
demo-dlq: 6. file status after replay: VALIDATED
demo-dlq: 7. archived on corr-fe0dae27-2c18-4a4d-97f1-ce938b92e091: classification.finalized, classification.finalized, doc.file.ready, file.status.changed, ops.audit.dead_letter_resolved, ops.dead_letter.recorded, classification.finalized, classification.finalized, file.status.changed, file.uploaded
```
- **Retry timings:** attempts at +0, +1.03 s, +5.02 s and +30.03 s, i.e. through the TTL queues `retry.1s`, `retry.5s`, `retry.30s`. After that the copy went to `files.validation.q.dlq` and `events.deadletter.q`.
- **Registry entry:** one OPEN record with code, message, stack hash and `retryCount 3`, recorded 36 s after `complete`. Both new headers came from the rebuilt files image. On the first demo run, against the pre-rebuild files image, they were absent and the record fell back to an empty `errorMessage` and no `stackHash`, as designed.
- **Replay:** the record went `REPLAYED` with the acting user. The stored message re-entered `files.validation.q` with `x-retry-count 0`, and the file reached `VALIDATED`. The registry's outbox events `ops.dead_letter.recorded` and `ops.audit.dead_letter_resolved` were published and archived on the upload's correlation chain.
- **Repeatability:** the demo was run three times (2026-11-24 20:46, 20:53, 20:54 UTC), with the same timings each time.

## FR-MSG-01 — kits (Testcontainers, RabbitMQ 4 with the asserted contract topology, configure-`^$` runtime users)
| Kit | Suite | New / changed tests | Result |
|---|---|---|---|
| TS | `packages/ts-platform/tests/integration/consumer.integration.test.ts` | full chain 1 s → 5 s → 30 s with increasing gaps → DLQ (`x-retry-count 3`); DLX deleted mid-flight → original redelivered (`redelivered: [false, true]`), DLQ empty; PERMANENT copy carries `x-aegis-error-message` + 16-hex `x-aegis-error-stack-hash` | 9/9 (consumer file), package 22/22 |
| Java | `PlatformIntegrationTest` | `walksTheFullRetryChainWithIncreasingDelaysThenDeadLetters_FR_MSG_01` (36.1 s), `requeuesTheOriginalWhenTheDeadLetterRepublishFails_FR_MSG_01`, header asserts | 13/13 |
| Python | `test_platform_integration.py` | `test_walks_the_full_retry_chain_…`, `test_requeues_the_original_when_the_dead_letter_republish_fails`, header asserts | 13/13 |

Stack-hash unit tests in each kit show that the same call site with a different message gives the same hash, that a different error type gives a different hash, and (TS) that shifted line numbers give the same hash.

## FR-MSG-02 / FR-MSG-03 — registry and admin API
- `services/events/tests/integration/dead-letters.integration.test.ts` runs against real RabbitMQ and MongoDB rs0, 8/8:
  - a files consumer failure → a record with envelope, headers, code, message, stack hash and one `ops.dead_letter.recorded`, whose envelope validates against the schema;
  - poison is recorded with `rawBody` and no event id; a repeat failure bumps `occurrences` without adding a row;
  - a dead-lettered `ops.dead_letter.recorded` is not re-announced;
  - visibility: TA own tenant, other TA 404, PA all or narrowed, cursor paging;
  - replay after the fix → processed **exactly once**, one audit event; a same-user repeat is a no-op, otherwise 409;
  - discard needs a reason and a person; a tenantless record is audited under the platform tenant;
  - a failure after a replay opens a new record.
- Domain unit tests (`dead-letter.test.ts`) and kit `replayRoute` unit tests pass.
- Gateway unit tests "dead-letter routes over the gateway" cover forwarding and the local 404.
- E2E `tests/e2e/dead-letters.e2e.test.ts` passes, and the role matrix now includes "Phase 7" (4 routes × every role).
- `make test-e2e` → **Test Files 7 passed · Tests 294 passed**, on the stack with rebuilt images.

## FR-MSG-04 — alerting
- **Format check:** `deploy/observability/alerts/dlq-spike.json` holds two OpenObserve v2 scheduled PromQL alerts. The format was checked by creating an equivalent alert through the local OpenObserve v1.1.2 API (`POST /api/v2/default/alerts` → "Alert saved") with a disabled probe destination. Both were deleted afterwards.
- **Local equivalent, `make check-dlq-alert`:**
  ```
  # clean stack
  aegispulse-dlq-spike: ok — > 10 via OpenObserve: total=0
  aegispulse-dlq-depth: FIRING — > 0 via rabbitmqctl (…): files.validation.q.dlq=3     # the three demo copies (retained by design)
  # after 11 synthetic dead letters published to aegispulse.dlx via the local management API
  aegispulse-dlq-spike: FIRING — > 10 via OpenObserve: total=11.8839
  aegispulse-dlq-depth: FIRING — > 0 via rabbitmqctl (…): files.validation.q.dlq=14
  ```
- **Cleanup:** the 11 synthetic records were discarded through `POST /v1/ops/dead-letters/{id}/discard` (11/11 DISCARDED, audited). `files.validation.q.dlq` was purged per the runbook, and every DLQ is empty again.
- **Still to do:** an alert firing to ntfy in dev is the Phase 18 item, as planned in §11.

## Architecture review (architecture-reviewer agent) — verdict "conforms with fixes", no blockers; majors fixed
| Finding | Fix | Proof |
|---|---|---|
| One-OPEN-record rule not enforced under concurrency | Migration `20261124000001-dead-letter-open-identity.cjs`: `identityKey` backfill + partial unique index `{queue, identityKey}` (OPEN); the losing recording reruns its transaction; events `/readyz` requires the migration | integration "concurrent recordings of one failure keep a single OPEN record" (6 parallel → 1 record, `occurrences 6`, 1 event); `make migrate` → `MIGRATED UP: 20261124000001-…` |
| Replay publish inside `withTransaction` could repeat on transaction retries | The transaction is driven explicitly. Before the publish, the attempt reruns on `TransientTransactionError`; after it, only the commit is retried. A failed commit after a confirmed publish is an accepted, documented at-least-once replay. Poison replays carry the stable `messageId` `dead-letter-{id}` | integration "two simultaneous replays by different admins" (one 200, one 409, processed once, one audit event) |
| `consumeRaw` 5 s requeue loses dead letters after ~50 s of store outage (quorum `x-delivery-limit` 10) | In-process retry holding the delivery, 5 s doubling to 60 s, requeue after 20 min or on shutdown (§5.5 note amended) | kit integration "retries a failing store in process …" (no redelivery, gaps 200/400/400 ms with test timings) and "requeues the delivery once the hold window is spent" |

Minor findings: the metric description now says it counts every occurrence. §6.5 states that `consumeRaw` is TS-only. The cases-side platform-tenant audit check moves to the cases audit consumer, which is not built yet (FR-AUD-02 phase).

After the fixes, on a rebuilt events image: `make migrate` → 12 runtimes `/readyz`; `make test-e2e` 294/294; `make demo-dlq` passed again with the same stack hash `365bcc42ac455be2`, which shows grouping across runs; `make check-dlq-alert` → both `ok` after the purge; `make lint` and `make test-unit` exit 0; events integration 27/27; TS kit consumer suite 11/11; migrations suite 30/30.

## Security review (security-reviewer agent) — verdict "approve with fixes"; H1, M1, M2 and L1–L4 fixed
| Finding | Fix | Proof |
|---|---|---|
| H1 dead-letter views served unmasked payloads, with no retention | rules-v1 `maskValue` over envelope, raw body, headers and errorMessage in every view, plus `redactions[]`; stored bytes kept only for replay; TTL `expireAt` = resolvedAt + 30 d | integration "views mask card numbers and secrets … while the replay re-delivers the original" (card absent from detail and list, replay processed, `expireAt` exact); domain unit "masks card numbers, secrets and PII keys …" |
| M1 error header could carry library error text | `deadLetterMessage` / `dead_letter_message` / `ConsumerFailure.deadLetterMessage`: full text only for the platform's own error types, otherwise "{Type} (message withheld)" | unit tests in all three kits; the demo still shows `TransientError[DEPENDENCY_UNAVAILABLE]: clamd unreachable` |
| M2 tenant attribution could drift | tenant in `identityKey` (migration `…0002`) | integration "a dead letter naming another tenant opens its own record" |
| L1 queue header trusted | `queue` = routing key; mismatch → `queueHeaderMismatch`, replay 422 | integration "refuses to replay a suspect record …" |
| L2 poison replay could alter bytes | replay requires sha256(stored body) = `bodySha256` | domain unit |
| L3 registry loss after ~3 h outage | runbook backfill procedure (move `{queue}.dlq` back through `aegispulse.dlx`) | `docs/runbooks/dlq.md` |
| L4 authz test gaps | other-tenant get/replay/discard → 404; tenantless → 404; TA with `X-Aegis-Tenant` → 403; integration replay → 403 | integration "authz: …" |

After the fixes, with every runtime image rebuilt: `make migrate` → `MIGRATED UP: 20261124000002-…`, 12 runtimes `/readyz`; `make test-e2e` 294/294; `make demo-dlq` passed (same stack hash); `make check-dlq-alert` ok/ok after the purge; `make lint` exit 0; events unit 43, events integration 31/31, migrations 30/30, TS kit unit 65, Python unit 64, Java unit + integration BUILD SUCCESSFUL, Python kit integration 13/13.

## Defects found and fixed during the phase
- **OpenObserve stopped ingesting** under the full stack's load. The symptom was `MemoryTableOverflowError`: 878 errors in about 5 min, starting right after all runtime images were rebuilt, and the persist loop stalled.
  - Fix: `deploy/compose/docker-compose.yml` sets `ZO_MAX_FILE_RETENTION_TIME=60`, `ZO_MEM_TABLE_MAX_SIZE=160` and `ZO_MEMORY_CACHE_MAX_SIZE=96` for the 512 MiB container.
  - Verified: during a full `make test-e2e` run (294 tests) there were 0 overflow errors, persists ran, and memory stayed at 281 MiB of 512 MiB.
- **`tests/migrations/postgres.integration.test.ts`** had stale Phase 1 assertions: `max(version) = 2`, and a regex that broke once registry's repeatable migrations widened Flyway's type column. It now derives the latest version from the migration files on disk.
  - This test was not part of the per-package runs used in earlier phases, so it went unnoticed until the full `make test-integration` here.
- **Shared Testcontainers Postgres harness:** an idle pool client could receive `57P01` (admin shutdown) during teardown and surface as an uncaught error under parallel load. The pool now tolerates exactly that code during teardown.

## Verification run (this tree)
| Command | Result |
|---|---|
| `make contracts` | OK: 43 event types, 115 actions, AsyncAPI ↔ events consistent |
| `make lint` | exit 0 (node, python, java spotless, shell, guardrails) |
| `make typecheck` | exit 0 |
| `make test-unit` | all green (ts-platform 64, events 41, gateway 19, files 17, ingestion 15, contracts 15, …; Gradle unit BUILD SUCCESSFUL; pytest unit 63) |
| `make test-integration` | exit 0 (contracts 4, migrations 30, ts-platform 22, events 25, ingestion 11, files 21; Gradle integration BUILD SUCCESSFUL; py-platform 13) |
| `make test-e2e` | 294/294 |
| `make demo-dlq` | as above |
| `make check-dlq-alert` | as above |
| `rabbitmqctl list_queues` | every `*.dlq` and `events.deadletter.q` empty after cleanup |
