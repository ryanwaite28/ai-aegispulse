# Phase 01 (slice 1b) — `ts-platform` Node kit — Exit Evidence

| | |
|---|---|
| Commit SHA | base `1b7a4ee` + uncommitted slice 1b working tree |
| Date (UTC) | 2026-11-23 03:50 |
| Environment(s) | local (macOS arm64, Node 24.22.3, Docker 29.4.3); Testcontainers PostgreSQL 18.7 (migrated by `deploy/docker/migrate.Dockerfile`) and RabbitMQ 4.4.1 (contract topology asserted) |
| Pipeline | pending: first GitLab pipeline after commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 1b `INTEGRATION-VERIFIED`; Phase 1 overall `IN PROGRESS` (1c–1e pending) |

## Scope
PROJECT.md §11 Phase 1, `ts-platform` checklist item. The package is `packages/ts-platform` (`@aegispulse/ts-platform`), with one export subpath per §6.1 directory:

| Module | What it provides | PROJECT.md |
|---|---|---|
| `config` | Zod env loader. Reports every problem in one `ConfigError`, never echoes values. Blocks for global, AMQP, Postgres and auth settings. | §6.9, §10.4, NFR-11 |
| `logging` | pino JSON logger with the mandatory fields (`ts, level, service, version, env, traceId, spanId, correlationId, tenantId, eventId, msg`), AsyncLocalStorage context, key-based redaction, `maskEmail` | NFR-07 |
| `telemetry` | OTel NodeSDK (OTLP/HTTP traces + metrics, http + undici instrumentation, probe paths ignored), an ESM `register` preload, W3C `traceparent` inject/extract for AMQP headers, `withSpan` | NFR-07 |
| `errors` | `Result<T,E>`, `DomainError` with §8.4 codes, `TransientError` / `PermanentError` / `PoisonMessageError`, `classifyFailure` | §6.8, steering/quality.md |
| `http-client` | undici pool with per-attempt timeout. Idempotent-only retries (max 2, full jitter from 100 ms). opossum breaker (50% / 20 calls / 30 s half-open, breaker-open → `TransientError CIRCUIT_OPEN`, 4xx never trips it). `InternalServiceClient.invoke(action, payload)` typed from the generated `ServiceAction` union | §6.2, §6.5, NFR-10 |
| `auth` | `JwtVerifier`: RS256 only, remote JWKS cached 10 min, iss/aud/exp with 60 s leeway, user `typ=user`. SERVICE tokens carry audience `aegispulse-internal` and an `act[]` allowlist; `authorizeInternal(header, action)`. `ServiceTokenProvider` (cached, single-flight, renews 60 s early) | FR-AUTH-05, FR-TEN-07, §5.7.4 |
| `health` | `HealthRegistry` (`livez` never checks dependencies; `readyz` / `healthz` with per-check timeout; not ready while starting or stopping). Postgres ping and Flyway-version checks. `Lifecycle` runs ordered SIGTERM stages http → consumers → outbox → telemetry → pools within the grace budget, and exits non-zero on fatal errors. `connectWithRetry` (≤ 60 s) | NFR-11, §6.8 |
| `idempotency` | `ProcessedMessagesRepository` (in-transaction dedup by consumer + eventId + replay generation), `IdempotencyRepository` (24 h key, body SHA-256, replay, `IDEMPOTENCY_KEY_REUSED`), `sha256Hex` | NFR-02, §7.0 |
| `outbox` | `OutboxRepository` (enqueue in the caller's tx, `FOR UPDATE SKIP LOCKED` claim, SENT, 2^n backoff capped at 5 min, FAILED after 20, 7-day purge, lag). `OutboxRelay` (250 ms poll, confirmed publishes, flushes its batch on stop, `aegispulse_outbox_lag_seconds` gauge). `withTransaction` / `withTenantTransaction` (`SET LOCAL app.tenant_id`) / `withPlatformTransaction` (`app.bypass_rls`) | §6.6, §7.0, ADR-0004, NFR-06 |
| `amqp` | `createAmqpClient` on rxjs-rabbitmq 3.0.0 (`topology: 'verify'`, confirms, `nack-requeue`, contract prefetch, traceparent hook, raw-JSON serializer). `AmqpPublisher` (§6.4 properties and headers, mandatory). `consumeEnvelopes` (validates the envelope against the contract schema, log/trace context, one handler, then retry → `aegispulse.retry` / `{queue}.retry.{tier}` with `x-retry-count+1`, or DLQ → `aegispulse.dlx` / `{queue}` with `x-aegis-error-code` and `x-aegis-original-queue`, confirm-then-ack). Queue policy is read from `aegispulse.topology.json`. `aegispulse_consumer_processed_total{queue,outcome}` | §6.4, §6.5, FR-MSG-01, FR-EVT-01 (poison) |

## Runtime Completion Gate (§11.0), applied to this slice
- [ ] 1. Source merged: no, the working tree is uncommitted.
- [x] 2. Clean-state startup: each integration run starts from empty containers. Postgres is initialised by the compose init script and migrated by the real migrate image.
- [x] 3. Real dependencies only: PostgreSQL 18.7 and RabbitMQ 4.4.1. No DB or broker mocks. The HTTP client tests use a real local HTTP server.
- [x] 4. Async infrastructure: confirmed publish, routing through the contract topology, retry through the real 1 s TTL queue, DLQ fan-in to `{queue}.dlq` and `events.deadletter.q`, graceful drain. Two concurrent relays publish each outbox row exactly once.
- [x] 5. Security:
  - The broker runtime users have configure `^$`, so the kit declares nothing.
  - DB access runs as the `svc_files` role.
  - The idempotency table fails closed without tenant context, and RLS blocks cross-tenant reads and writes.
  - JWT alg confusion, foreign keys, wrong audience (dev token in prod) and expired tokens are rejected.
  - Config errors never echo values, and logs redact credentials and bodies.
- [ ] 6. Observability: log fields and trace continuation are proven in tests (the consumer continued the producer's `traceId`). **OTLP export to OpenObserve is not exercised here.** It is verified when the first service runs in compose (1e).

## Commands & output

### Lint, format, types, build
```text
$ pnpm exec eslint packages/ts-platform            → no problems
$ pnpm exec prettier --check packages/ts-platform  → All matched files use Prettier code style!
$ pnpm -r --if-present run typecheck               → tests, packages/contracts, packages/ts-platform: Done
$ pnpm --filter @aegispulse/ts-platform build      → tsc -p tsconfig.build.json (dist/ for 10 modules)
```
ESM smoke test of the built output (each subpath imported by package name):
```text
config 11 exports · logging 6 · telemetry 7 · errors 16 · http-client 5 · auth 5 · amqp 10 · outbox 9 · health 6 · idempotency 3
policy {"queue":"orchestrator.txn.q","prefetch":20,"retryTiers":["1s","5s","30s"],"deadLetter":true}
poison ok: ENVELOPE_INVALID
```

### Unit (`pnpm --filter @aegispulse/ts-platform test`)
```text
amqp 9 · auth 6 · config 4 · errors 4 · health 7 · http-client 7 · logging 3 · outbox 4 · telemetry 2
Test Files  9 passed (9)
     Tests  46 passed (46)
```

### Integration (`pnpm --filter @aegispulse/ts-platform test:integration`)
```text
✓ consumer > delivers a valid envelope with log/trace context and acks it
✓ consumer > retries a TRANSIENT failure through the real 1 s TTL queue with x-retry-count, then succeeds
✓ consumer > dead-letters PERMANENT failures immediately with error headers (DLQ + registry queue)
✓ consumer > dead-letters poison (non-JSON and schema-invalid) as ENVELOPE_INVALID without calling the handler
✓ consumer > dead-letters a TRANSIENT failure once the retry budget is spent
✓ consumer > passes replay headers to the handler for dedup (NFR-02)
✓ consumer > close() cancels the consumer, waits for the in-flight handler, and the message is acked not redelivered (NFR-11)
✓ outbox > only persists rows whose transaction commits; duplicate eventIds are no-ops
✓ outbox > publishes PENDING rows with confirms and §6.4 properties, then marks them SENT
✓ outbox > two relays never publish the same row twice (FOR UPDATE SKIP LOCKED)
✓ outbox > backs off failed publishes and marks FAILED after 20 attempts
✓ outbox > purges SENT rows only after the retention window
✓ processed_messages > detects redelivery but treats a replay generation as new
✓ processed_messages > a rolled-back mark is not remembered (crash before commit retries cleanly)
✓ idempotency > fails closed without tenant context
✓ idempotency > stores the response, replays it for the same body, and rejects a different body
✓ idempotency > isolates tenants: the same key in another tenant is independent and invisible
✓ idempotency > serializes concurrent requests with the same key: the second sees the first's response
✓ idempotency > purges expired keys across tenants only inside a platform transaction
Test Files  2 passed (2)
     Tests  19 passed (19)
  Duration  20.83s
```

## Decisions and deviations
- **Release-age exception.** `rxjs-rabbitmq@3.0.0` was installed inside pnpm's minimum-release-age window, by explicit owner decision on 2026-11-23 (the library is the owner's own and was reviewed in [rxjs-rabbitmq-3.0.0-review](rxjs-rabbitmq-3.0.0-review.md)). It is scoped to that exact version in `pnpm-workspace.yaml` (`minimumReleaseAgeExclude`). Every other dependency was resolved under the default window. Remove the entry once the window has passed.
- **Breaker window.** opossum's window is time-based. §6.5's "20-call rolling window" is implemented as `volumeThreshold: 20` over a 60 s window.
- **Prefetch with several queues.** One consume channel carries one `basic.qos`, so a runtime consuming several queues gets the smallest contract prefetch.
- **No DLQ on `events.deadletter.q`.** Its failures are nack-requeued and bounded by the quorum `x-delivery-limit`, which avoids a DLX self-loop.

## Open items (carried forward)
- `typ` for SERVICE tokens is not specified in PROJECT.md (only `typ=user`). The verifier accepts a SERVICE token by `aud=aegispulse-internal` plus `act[]`, and rejects `typ=user`. Registry (Phase 2) should mint `typ=service`; this needs a PROJECT.md amendment.
- HTTP route adapters for `/livez`, `/readyz` and `/healthz`, the Kysely executor adapter, and the first OTLP export are done in 1e with the service skeletons.
- `@opentelemetry/*` and `opossum` are new dependencies, logged in `docs/steering/tech.md`.

## Amendment re-verification (2026-11-23: ADR-0016, token `typ` rules)
- **RLS bypass.** `withPlatformTransaction` is removed. `IdempotencyRepository.purgeExpired` now calls `{schema}.purge_expired_idempotency_records()`, the SECURITY DEFINER function owned by `{schema}_platform`. The outbox description above predates this change.
- **Token types.** `JwtVerifier.verifyTenant` accepts `typ=user|integration` on `JWT_AUDIENCE` (integration tokens must carry only the `INTEGRATION` role) and adds an `IntegrationPrincipal`. `verifyService` requires `typ=service`. `jti` is required for every token type.
- **New tests:**
  - an integration principal, and an integration token with an escalated role rejected;
  - a missing or unknown `typ` rejected, and a service token rejected on the public audience;
  - the old `app.bypass_rls` setting ignored;
  - the definer purge removing 3 expired keys across two tenants while a plain `DELETE` reaches 0 rows.
- **Result:** unit 48/48, integration 20/20, ESLint and tsc clean.

