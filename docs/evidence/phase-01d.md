# Phase 01 (slice 1d) — `py-platform` Python kit — Exit Evidence

| | |
|---|---|
| Commit SHA | base `1b7a4ee` + uncommitted slices 1b–1d working tree |
| Date (UTC) | 2026-11-23 |
| Environment(s) | local (macOS arm64, Python 3.13 via uv, Docker 29.4.3); Testcontainers PostgreSQL 18.7 (migrated by `aegispulse-migrate:test`, as `svc_analytics`) and RabbitMQ 4.4.1 (contract topology, configure-`^$` runtime user `svc_data_intel`) |
| Pipeline | pending: first GitLab pipeline after commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 1d `INTEGRATION-VERIFIED`; Phase 1 overall `IN PROGRESS` (1e pending) |

## Scope
This slice covers the PROJECT.md §11 Phase 1 `py-platform` item, built from the start on the 2026-11-23 amendments (ADR-0016 enforced RLS bypass; token `typ` rules). It has two parts:
- `packages/py-platform` (`aegis_platform`, a uv workspace member);
- `aegis_contracts`, now an installable workspace package (`packages/contracts/pyproject.toml`). `make contracts` now also emits `aegis_contracts.topology` (`QueueName`/`ExchangeName` StrEnums, `QueuePolicy`, `WORK_QUEUES`, `policy()`) and bundles the envelope schema and topology JSON as package resources.

| Module | What it provides | PROJECT.md |
|---|---|---|
| `config` | Pydantic Settings classes for the §10.4 blocks (`PlatformSettings`, `AmqpSettings`, `PostgresSettings`, `AuthSettings`). `load_settings` raises one `ConfigError` listing every problem without values; secrets are `SecretStr` | §6.9, NFR-11 |
| `logging` | structlog JSON with NFR-07 fields (traceId/spanId from the active OTel span), contextvars `log_context`, key-name redaction at any depth, `mask_email` | NFR-07 |
| `telemetry` | OTLP/HTTP traces + metrics, W3C propagator, inject/extract helpers for AMQP headers (bytes or str) | NFR-07 |
| `errors` | `DomainError` family with §8.4 codes and HTTP statuses, Transient/Permanent/Poison classes, `classify_failure`, `describe_error` | §6.8 |
| `auth` | `JwtVerifier`: RS256, JWKS via PyJWKClient (10 min cache), 60 s leeway, `typ` rules (user/integration on `JWT_AUDIENCE`, service on `aegispulse-internal`, jti required). User/Integration/Service principals, `authorize_internal` (act[]), `ServiceTokenProvider` | FR-AUTH-01/04/05, FR-TEN-07 |
| `health` | `HealthRegistry` and a FastAPI `health_router` (`/livez`, `/readyz` 503 until ready, `/healthz`). `Lifecycle` runs ordered SIGTERM stages http → consumers → outbox → telemetry → pools within the grace budget. `connect_with_retry` (≤ 60 s) | NFR-11 |
| `checks` | Framework-free readiness `Check` type | NFR-04 |
| `db` | psycopg 3 `transaction` / `tenant_transaction` (`SET LOCAL app.tenant_id`, no bypass per ADR-0016), validated identifiers, Postgres ping and Flyway version checks | §7.0, NFR-06, NFR-11 |
| `envelope` | Envelope decode against the bundled contract schema (POISON `ENVELOPE_INVALID`); encode omits null optional members; `uuid_str` / `event_id` for the generated `Uuid` root models | §6.4, FR-EVT-01 |
| `outbox` | `OutboxRepository` (enqueue in the caller's tx, SKIP LOCKED claim, 2^n backoff capped at 5 min, FAILED after 20, purge, lag). `OutboxRelay` (asyncio, `stop()` finishes the batch, `aegispulse_outbox_lag_seconds`) | §6.6, ADR-0004 |
| `idempotency` | `ProcessedMessagesRepository`, the dedup hook the service calls inside its transaction | NFR-02 |
| `amqp` | `AmqpClient` on aio-pika:<br>• robust connection; passive topology checks only;<br>• confirmed and mandatory publishes with §6.4 properties and `traceparent`;<br>• one channel per consumed queue with the contract prefetch;<br>• `DeliveryContext` (retry count, replay generation/job, redelivered);<br>• retry to `aegispulse.retry` / `{queue}.retry.{tier}` or DLQ to `aegispulse.dlx` / `{queue}`, confirm-then-ack, nack-requeue if the republish fails;<br>• `close()` drains in-flight handlers;<br>• `aegispulse_consumer_processed_total` | §6.4, §6.5, FR-MSG-01 |
| import-linter | Kit core (errors, config, envelope) is transport- and driver-free; only `health` touches FastAPI. Service contracts are templated for 1e | NFR-04, NFR-09 |

## Runtime Completion Gate (§11.0), applied to this slice
- [ ] 1. Source merged: no, the working tree is uncommitted.
- [x] 2. Clean-state startup: empty containers each run. PostgreSQL is initialised by the compose init script and migrated by the real migrate image (V1 + V2).
- [x] 3. Real dependencies only. No DB or broker mocks.
- [x] 4. Async infrastructure:
  - outbox → confirmed publish → `events.archive.q` with §6.4 properties;
  - two relays publish 120 rows exactly once;
  - retry through the real 1 s TTL queue;
  - DLQ with headers, plus fan-in to `events.deadletter.q`;
  - poison and exhausted retries dead-lettered;
  - `close()` drains the in-flight handler, and the message is acked, not redelivered.
- [x] 5. Security:
  - The runtime broker user has configure `^$`, and it can't even passively check a queue outside its read permission (`ChannelAccessRefused`).
  - DB access runs as `svc_analytics`.
  - JWT rules are covered by unit tests (wrong audience, foreign key, HS256, expiry, missing or unknown `typ`, service token on the public audience, escalated integration roles).
  - Config errors never echo values, and logs redact by key name.
- [ ] 6. Observability: log fields and trace extraction/injection are proven in tests. **OTLP export to OpenObserve is not exercised here** (1e).

## Commands & output
```text
$ ci/lint-python.sh   → ruff check + ruff format --check + mypy --strict + lint-imports (2 contracts KEPT): lint-python: OK (29 files)
$ ci/test-python.sh   → 42 passed (py-platform 33 unit + contracts 9)
$ uv run pytest -m integration packages/py-platform/tests/integration → 11 passed in 16.60s:
  readiness checks against real deps (ping, Flyway V2 ok / V3 refused, amqp ready)
  runtime user cannot verify a queue outside its read permission
  outbox commit/rollback/duplicate → relay → archive queue (§6.4 properties, no tenant header for platform events)
  two relays, 120 rows, each published once
  backoff + FAILED after 20 + purge
  processed_messages: redelivery vs replay generation, rolled-back mark not remembered
  consume with context + ack; TRANSIENT → 1 s TTL retry → success; PERMANENT / poison / exhausted → DLQ headers
  replay headers + DUPLICATE acked; close() drains and acks
$ ci/contract.sh      → all checks passed; generation deterministic across all languages
$ pnpm run lint       → clean; ts-platform 48/48 still green
```

## Problems found and fixed during verification
- **Envelope IDs (real defect, fixed).** The generated Pydantic `Uuid` is a `RootModel`, so `str(envelope.eventId)` renders `root='…'`. That would have corrupted the AMQP `message_id`, the `x-aegis-tenant` header, the log context and the outbox SQL parameters. `uuid_str` / `event_id` accessors are now used everywhere.
- **Layering leak (caught by import-linter, fixed).** `db` imported `health` for the `Check` type, which pulled FastAPI into the data layer. `Check` now lives in the framework-free `checks` module.
- **Role-name inconsistency from 1a (clarified).** PROJECT.md §5.7.2 and the §10.4 example said `svc_data_intel`, while the init script, migrations and the `svc_<schema>` convention all use `svc_analytics`. PROJECT.md now says `svc_analytics`. The broker user stays `svc_data_intel` (per-runtime, §5.7.3).

## Decisions and deviations
- **Outbox driver.** psycopg 3 async directly. Data-intel can use SQLAlchemy Core on the same driver.
- **Outbound HTTP client deferred.** httpx + pybreaker are not in the py-platform checklist item; they land with the first Python service that calls another (doc-extraction → files).
- **Licensing.** psycopg is LGPL-3.0. `docs/steering/tech.md` now states that LGPL is acceptable for unmodified, imported libraries.
- **Python contracts.** The new `aegis_contracts.topology` StrEnums follow the same wire-name-once pattern as the Java enums.

## Open items (carried forward)
- 1e: service skeletons (FastAPI apps mounting `health_router`, import-linter service contracts, OTLP export check).
- The Starlette `TestClient` deprecation (httpx → httpx2) is upstream and only affects the test client.
