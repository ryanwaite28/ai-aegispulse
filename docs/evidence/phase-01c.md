# Phase 01 (slice 1c) — `java-platform` Spring Boot starter — Exit Evidence

| | |
|---|---|
| Commit SHA | base `1b7a4ee` + uncommitted slices 1b–1c working tree |
| Date (UTC) | 2026-11-23 |
| Environment(s) | local (macOS arm64, OpenJDK 25.0.5.1, Gradle 9.9.2, Docker 29.4.3); Testcontainers PostgreSQL 18.7 (migrated by `aegispulse-migrate:test`, built from `deploy/docker/migrate.Dockerfile`) and RabbitMQ 4.4.1 (contract topology declared, configure-`^$` runtime user) |
| Pipeline | pending: first GitLab pipeline after commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 1c `INTEGRATION-VERIFIED`; Phase 1 overall `IN PROGRESS` (1d–1e pending) |

## Scope
PROJECT.md §11 Phase 1 covers three items here:
- the `java-platform` checklist item;
- the Java envelope JSON-Schema suite;
- Java records from `make contracts`.

It also adds the Java quality tooling that NFR-14 and `ci/lint-java.sh` deferred to the first Java project.

`packages/java-platform` (`io.aegispulse.platform`) is a Spring Boot 4.2 starter. It is auto-configured, and every default sits at the lowest precedence, so a service can override any of them.

| Package | What it provides | PROJECT.md |
|---|---|---|
| `config` | `AegisPlatformProperties` (validated `aegis.*`: service, version, env, security, readiness, outbox). `PlatformDefaults` env post-processor covers: structured logs; virtual threads; graceful shutdown with 20 s phases; health groups `/livez` (liveness only), `/readyz` (db, rabbit, flywaySchema), `/healthz` (components, no details); publisher confirms, returns and mandatory; manual ack; `spring.rabbitmq.dynamic=false` (no runtime declaration); fatal on missing queues | §6.9, NFR-07, NFR-11, §6.5 |
| `logging` | `AegisJsonFormatter`: NFR-07 fields (traceId/spanId from the OTel agent's `trace_id`/`span_id` or Micrometer's keys), key/value pairs, key-name redaction, stack traces reduced to class + message. `LogContext` MDC scope | NFR-07 |
| `web` | `CorrelationIdFilter` (validates or mints `corr-<uuid>` and the request id, and echoes both). `ErrorEnvelopeAdvice` returns the §8.2 envelope with §8.4 codes; unhandled errors are 500 `INTERNAL_ERROR` with no stack | §8.2, §8.4 |
| `errors` | Sealed `DomainException` (Validation 422, Unauthorized 401, Forbidden 403, NotFound 404, Conflict 409, PayloadTooLarge 413, RateLimited 429). `ConsumerFailure` Transient/Permanent/Poison classes plus `classify` (transient data-access errors count as TRANSIENT) | §6.8, steering/quality.md |
| `security` | RS256-only decoder over the registry JWKS: iss, 60 s leeway, user = `typ=user` + `aud=JWT_AUDIENCE` + tid/tslug/roles/jti; service = `aud=aegispulse-internal` + `act[]`. `AegisPrincipal` (User/Service). Stateless resource-server chain with the probe paths open and 401/403 as §8.2 envelopes. `ServiceActionAuthorizer.requireAction` | FR-AUTH-05, §5.7.4 |
| `db` | `TenantScope` (`SET LOCAL app.tenant_id`; refused outside a transaction; no bypass, see the amendment below). Schema identifiers are validated | §7.0, NFR-06 |
| `health` | `FlywaySchemaVersionHealthIndicator` (numeric version compare) | NFR-11 (c) |
| `outbox` | `OutboxRepository` (JdbcClient; enqueue joins the caller's tx; `FOR UPDATE SKIP LOCKED`; 2^n backoff capped at 5 min; FAILED after 20; purge; lag). `OutboxRelay` (SmartLifecycle on a virtual thread; stops before the pools after finishing its batch; `aegispulse_outbox_lag_seconds`) | §6.6, ADR-0004 |
| `idempotency` | `ProcessedMessagesRepository`, `IdempotencyRepository` (24 h, SHA-256, replay, `IDEMPOTENCY_KEY_REUSED`) | NFR-02 |
| `amqp` | `EnvelopeCodec` (networknt 3 on Jackson 3 against the contract schema → POISON `ENVELOPE_INVALID`; encode omits null optional members). `AmqpEnvelopePublisher` (correlated confirms, mandatory returns, §6.4 properties and headers; confirm-then-ack republish). `EnvelopeListener` / `EnvelopeListeners`: manual-ack container per work queue with the contract prefetch, passive queue check only and a 20 s drain; retry → `aegispulse.retry` / `{queue}.retry.{tier}` with `x-retry-count+1`; DLQ → `aegispulse.dlx` / `{queue}` with `x-aegis-error-code` and `x-aegis-original-queue`; `aegispulse_consumer_processed_total{queue,outcome}` | §6.4, §6.5, FR-MSG-01, FR-EVT-01 |
| `archunit` | `AegisArchitectureRules`: service/domain code transport-free; domain code pure; JDBC only in `..db..`; adapters never call repositories directly | NFR-04, NFR-09 |

**Contracts:**
- `packages/contracts/scripts/java-records.ts` emits 55 dependency-free records and enums (envelope + 38 payloads + `EventTypes` + `Topology`) with JSpecify nullability into `generated/java`. Output is deterministic and the drift gate covers it.
- `validate.ts` now also checks that every valid envelope example's payload matches its eventType schema. Both existing examples failed that check and were fixed.

## Runtime Completion Gate (§11.0), applied to this slice
- [ ] 1. Source merged: no, the working tree is uncommitted.
- [x] 2. Clean-state startup: empty containers each run. PostgreSQL is initialised by the compose init script and migrated by the real migrate image; the Spring context boots against them.
- [x] 3. Real dependencies only. No DB or broker mocks; JWKS is served over real HTTP.
- [x] 4. Async infrastructure:
  - outbox → confirmed publish → consumer kit, end to end;
  - retry through the real 1 s TTL queue;
  - DLQ with error headers, and fan-in to `events.deadletter.q`;
  - two relays never publish a row twice;
  - the listener stops gracefully: the in-flight message is acked and not redelivered.
- [x] 5. Security:
  - The runtime broker user has configure `^$`.
  - DB access runs as `svc_cases`.
  - RLS fails closed without tenant scope and isolates tenants.
  - JWTs are rejected for wrong audience (dev token in prod), foreign key, HS256, expiry, and missing act[].
  - 401/403 return §8.2 envelopes.
  - Logs redact by key.
- [ ] 6. Observability: log fields and the readiness components are proven. **Trace export through the OTel Java agent is not exercised here**; that happens in 1e with the registry and cases skeletons.

## Commands & output
```text
$ ci/lint-java.sh      → spotlessCheck + assemble (-Xlint:all -Werror, Error Prone 2.53.0, NullAway 0.14.4 JSpecify mode): lint-java: OK
$ ci/test-java.sh      → unit tests=29 failed=0 (9 classes): consumer failures, failure routes, Java envelope suite
                          (2 valid / 6 invalid examples + non-JSON), generated records + encode round-trip, JWT rules,
                          act[] authorizer, log formatter, correlation ids, platform defaults, ArchUnit rules
$ ./gradlew :java-platform:integrationTest → integration tests=11 failed=0:
  probes /livez /readyz /healthz (db, rabbit, flywaySchema up)
  internal route: 401 envelope + correlation id, user 200, service with act 200, without act 403, dev audience 401, NotFound 404
  outbox commit/rollback/duplicate → relay → consumer + archive queue (§6.4 properties)
  two relays, 150 rows, each published once
  backoff + FAILED after 20 + purge
  TRANSIENT → 1 s TTL retry → success (retryCount 0 → 1)
  PERMANENT / poison / exhausted retries → DLQ with x-aegis-error-code
  replay headers + DUPLICATE acked
  processed_messages redelivery vs replay generation
  idempotency: RLS fail-closed, replay, IDEMPOTENCY_KEY_REUSED, cross-tenant isolation, platform purge
  graceful listener stop drains and acks
$ ci/contract.sh       → all checks passed; generate: … 55 java types (deterministic across runs)
$ pnpm run lint; pnpm -r typecheck; contracts 15/15, ts-platform 46/46 unit tests; ci/check-boundaries.sh OK
```

## Problems found and fixed during verification
- **Envelope null handling (real defect, fixed before it shipped).** Jackson serialised absent optional members as `null`, which the closed envelope schema rejects, so every Java-published envelope would have been dead-lettered as POISON. `EnvelopeCodec.encode` now omits null optional members, and a unit round-trip test guards it.
- **Contract examples.** The two valid envelope examples carried payloads that didn't match their event schemas (only the envelope schema had ever been checked). Both are fixed, and `make contracts` now enforces it.
- **Tooling.** Testcontainers `ImageFromDockerfile` deadlocked streaming the build context, so the migrate image is now built by a Gradle `Exec` task that `integrationTest` depends on. google-java-format 1.37 fails on JDK 25, so the pin is 2.0.0.

## Decisions and deviations
- **Java codegen (PROJECT.md §6.3 amended).** Records for the envelope, events and topology come from `java-records.ts` inside `make contracts`, which keeps one generator pipeline and one drift gate. OpenAPI Generator stays reserved for Java internal DTOs when Phase 2 needs them.
- **Prefetch.** The contract prefetch applies per listener container, so each queue gets its own value (unlike the single-channel TS kit).
- **Lint.** `-Xlint:-try` allows the `try (LogContext ignored = …)` MDC idiom.
- **Trace propagation** on AMQP relies on the OTel Java agent's Spring Rabbit instrumentation (§6.3); the platform adds no manual propagation.

## Open items (carried forward)
- ~~SERVICE-token `typ` unspecified~~: resolved by the token-`typ` amendment (see below).
- ~~RLS bypass is only a convention~~: resolved by ADR-0016 (see the amendment below).
- **Deferred to 1e:** wiring into `services/registry` and `services/cases`, ArchUnit rules applied to those services, and the agent/OTLP trace check.

## Amendment re-verification (2026-11-23: ADR-0016, token `typ` rules, queue-name enums)
- **RLS bypass.** `TenantScope.bypassForPlatformJob` is removed. `IdempotencyRepository.purgeExpired` calls the SECURITY DEFINER function.
- **Token types.** The JWT validator enforces `typ` per audience (user or integration on `JWT_AUDIENCE`; service on `aegispulse-internal`), with `jti` required. An `AegisPrincipal.Integration` is added.
- **Queue names.** The generated contracts now include `QueueName` (58) and `ExchangeName` (6) enums with `wireName()` and `fromWireName()`. `Topology.WORK_QUEUES` is keyed by `QueueName`, and every topology literal appears exactly once. The starter's listener API takes the enum (`EnvelopeListeners.container(QueueName, …)`, `Topology.policy(QueueName)`), so an unknown queue fails at compile time.
- **New tests:**
  - integration principal, and escalated integration roles rejected;
  - a missing `typ`, a service token on the public audience, and an internal token without `typ=service` all rejected;
  - enum lookups;
  - the old setting ignored, and the definer purge removing 2 keys across two tenants.
- **Result:** `ci/lint-java.sh` OK; unit 31/31; integration 11/11 against the migrate image with V2 applied.

