# Changelog

All notable changes to AegisPulse are documented here.
The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Rules**
- Every merge request adds at least one line under `[Unreleased]` in the matching category.
- Reference FR/NFR ids and the phase, e.g. `- FR-WHK-02: constant-time HMAC verification with dual-key rotation (Phase 4)`.
- Status changes (e.g., a phase reaching `RUNTIME-VERIFIED`) go under **Status**, with a link to the evidence file.
- Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Docs`, `Status`.
- The release job moves `[Unreleased]` into a dated version section when a `vX.Y.Z` tag is pushed.

## [Unreleased]

### Added
- Phase 1e: 12 runtime skeletons (gateway, ingestion, files, events, registry, cases, risk-scoring, sensitivity-scanner, doc-extraction, data-intel, orchestrator, console). Each has:
  - config validation, JSON logs and traces;
  - `/livez`, and a `/readyz` that checks only its own dependencies;
  - a non-root, read-only-root image.
  The gateway is NestJS 12 on the platform Fastify instance, with request/correlation ids, body limits, §8.2 envelopes, a global JWKS guard and `/v1/openapi.json`. Also added: shared Dockerfiles per runtime family, compose wiring with per-runtime credentials, `make images`, `make migrate` bootstrap and readiness wait, and a root `.dockerignore`.
- Phase 1d `packages/py-platform` (`aegis_platform`, no business logic):
  - Pydantic Settings with redacted `ConfigError`, and structlog JSON logs (NFR-07 fields, key redaction)
  - OTel OTLP/HTTP and W3C header helpers
  - errors and failure classes
  - JWT verifier with the `typ` rules, act[] authorization and a service-token provider
  - FastAPI health router (`/livez` `/readyz` `/healthz`), ordered SIGTERM lifecycle and `connect_with_retry`
  - psycopg 3 tenant transactions and readiness checks
  - outbox relay (SKIP LOCKED, confirms), `processed_messages` dedup hook
  - aio-pika consumer kit: passive topology, confirmed and mandatory publishes, per-queue prefetch, retry-tier and DLX republish (confirm-then-ack), graceful drain
  - import-linter contracts
  FR-MSG-01, NFR-02/04/06/07/11.
- `aegis_contracts` is now an installable uv workspace package. `make contracts` also emits `aegis_contracts.topology` (`QueueName`/`ExchangeName` StrEnums, `WORK_QUEUES`) and bundles the envelope schema and topology as package resources.
- Phase 1c `packages/java-platform` (Spring Boot 4.2 starter, no business logic). It is auto-configured, with lowest-precedence defaults:
  - structured JSON logs (NFR-07 fields, key redaction) and correlation ids
  - §8.2 error envelopes over a sealed `DomainException`
  - RS256/JWKS resource server with the user/SERVICE token rules and an `act[]` authorizer
  - `/livez` `/readyz` `/healthz` health groups (db, rabbit, Flyway schema version) and graceful shutdown
  - `TenantScope` (RLS `SET LOCAL`)
  - JdbcClient outbox with a SKIP LOCKED relay, `processed_messages` dedup, and the Idempotency-Key store
  - AMQP kit: envelope codec validated against the contract, confirmed and mandatory publisher, manual-ack listener with the contract prefetch, retry-tier and DLX republish (confirm-then-ack), no runtime declaration
  - ArchUnit layering rules
  FR-MSG-01, NFR-02/04/06/07/09/11.
- Java topology enums `QueueName` / `ExchangeName` (wire names appear once; `Topology.WORK_QUEUES` keyed by enum; java-platform listener API takes `QueueName`).
- Java records from `make contracts` (`packages/contracts/scripts/java-records.ts`: envelope, 38 payloads, `EventTypes`, `Topology`; JSpecify nullability); the Java envelope JSON-Schema suite (Phase 1 contracts workstream).
- Java build conventions (NFR-14): `-Xlint:all -Werror`, Error Prone 2.53.0 + NullAway (JSpecify mode), Spotless with google-java-format 2.0.0, Maven Central as the only repository (`FAIL_ON_PROJECT_REPOS`); `ci/lint-java.sh` runs `spotlessCheck`; `make test-integration` runs Gradle `integrationTest`.
- Phase 1b `packages/ts-platform` (`@aegispulse/ts-platform`), the Node platform kit with no business logic:
  - `config` (Zod; one redacted error listing every problem)
  - `logging` (pino with the NFR-07 fields and redaction)
  - `telemetry` (OTel OTLP/HTTP, AMQP `traceparent` helpers)
  - `errors` (Result type, §8.4 codes, Transient/Permanent/Poison classes)
  - `http-client` (undici, idempotent-only retries, opossum breaker, typed `InternalServiceClient.invoke`)
  - `auth` (RS256 JWKS verifier, `act[]` internal authorization, service-token provider)
  - `health` (livez/readyz/healthz, Flyway-version check, ordered SIGTERM lifecycle, `connectWithRetry`)
  - `idempotency` (`processed_messages` dedup, Idempotency-Key store)
  - `outbox` (SKIP LOCKED relay with confirms, backoff, FAILED after 20, lag gauge; tenant and platform transactions)
  - `amqp` (rxjs-rabbitmq 3.0.0 in verify mode; confirmed publisher; envelope consumer with retry-tier and DLX republish). FR-MSG-01, NFR-02/07/10/11.
- ADR-0015 node roles: `deploy/bootstrap/10-storage-node-disk.sh` (formats and mounts the storage node's data SSD, bind-mounts it over the local-path directory, makes `k3s-agent` require the mount; the wipe step needs typed confirmation) and `deploy/bootstrap/20-node-roles.sh` (idempotent label and taint swap, `CHECK_ONLY=1` audit mode).
- Phase 1a (contracts + data foundations): canonical envelope v1.1 schema + examples; RabbitMQ topology contract (6 exchanges, 58 queues, 71 bindings) + `topology-assert` CLI; 38 event payload schemas + AsyncAPI 3.0; OpenAPI 3.1 public gateway (79 ops) + 8 internal service specs (103 HTTP ops + consumer actions); `make contracts` (validate → deterministic TS/Pydantic codegen → drift gate, `ci/contract.sh`, CI `contract` stage); V1 baseline migrations for 5 schemas + Flyway runner image + `make migrate`; Events Service Mongo migrations; `tests/` system-test workspace (25 migration integration tests).
- Phase 0 scaffold: Node workspace (pnpm 12, TS 6.0.3, ESLint 10, Prettier, Vitest), uv workspace (Ruff, mypy strict, pytest), Gradle 9.9.2 wrapper (Java 25, checksum-pinned), `Makefile` (§9.5 targets; later-phase targets fail loudly).
- Local compose infrastructure: PostgreSQL 18 (schema-per-service roles), MongoDB 8 rs0 (keyFile, scoped users), Redis 8 (per-service ACLs), RabbitMQ 4 (least-privilege users), SeaweedFS 4.54, ClamAV, OpenObserve; `scripts/dev/gen-local-secrets.sh`, `scripts/dev/compose-wait.sh`, `make env|up|down|reset`.
- CI guardrails: `ci/check-boundaries.sh`, `ci/check-migrations.sh`, `ci/check-resource-budget.sh`, `ci/check-layer-sizes.sh`, plus `ci/tests/run.sh` (10 self-tests); lint/test runners; `.gitlab-ci.yml` skeleton (.pre/lint/test); Gitleaks pre-commit hook.
- `scripts/dev/objectstore_compat.py` / `make objectstore-compat` (ADR-0011 S3 checks).
- Model routing policy in `CLAUDE.md`; review agents pinned to models (architecture-reviewer → sonnet, security-reviewer → opus, spec-tracer → haiku).

### Fixed
- java-platform: idle outbox-relay polling (every 250 ms) flooded traces, about 240 spans per 30 s from registry and cases. Polls now run under an unsampled parent context, giving 0 spans when idle; request traces are unchanged (NFR-07).
- `ci/check-layer-sizes.sh` measured uncompressed layer size, which no Node or JVM base layer can meet. It now measures the gzip-compressed size that registry pushes actually upload (the Cloudflare 100 MB cap), with the same 95 MB limit.
- ts-platform telemetry dropped `@opentelemetry/sdk-node` (unused gRPC, protobuf, Zipkin and Prometheus exporters) for `sdk-trace` + `sdk-metrics` + OTLP/HTTP, which keeps service images under the layer cap.
- CI: "Pipeline cannot be run … review the workflow:rules". `workflow:rules` (PROJECT.md §9.2) only admitted MR events, `main` and `vX.Y.Z` tags, so pushes to `feature/project` (no MR open) matched no rule and GitLab refused to create a pipeline. Branch pushes now run, except when the branch has an open MR (then only the MR pipeline runs, so there are no duplicates); deploy and release jobs will carry their own `main`/tag rules. §9.2 is amended to match. Also reworded an evidence line that tripped gitleaks' generic-api-key rule (a false positive that would have failed the `.pre` stage after commit).
- PROJECT.md §5.7.2 and §10.4 named data-intel's database role `svc_data_intel`, but the init script, migrations and the `svc_{schema}` convention use `svc_analytics`. The docs now say `svc_analytics`; the broker user stays `svc_data_intel`.
- Contracts: both valid envelope examples carried payloads that didn't match their event schemas. Fixed, and `make contracts` now validates envelope example payloads against their eventType schema (Phase 1c).

### Security
- ADR-0016: RLS can no longer be lifted by a session setting. The `app.bypass_rls` / `rls_bypassed()` convention is removed (`V2__enforced_rls_bypass.sql` in every schema). Cross-tenant operations are now `SECURITY DEFINER` functions owned by new `NOLOGIN BYPASSRLS` `{schema}_platform` roles (the first is `purge_expired_idempotency_records()`). The kits drop their bypass helpers. Local volumes need `make reset`.
- Token `typ` rules (ADR-0010 amended): `user`/`integration` only on `JWT_AUDIENCE`, `service` only on `aegispulse-internal`, `jti` required, unknown or missing `typ` rejected. INTEGRATION tokens are now defined (FR-AUTH-04) and accepted by both kits as tenant principals with only the `INTEGRATION` role. Before this, the 1b/1c verifiers would have rejected every integration-account call.

### Docs
- PROJECT.md amendments (2026-11-23): FR-TEN-07 (SERVICE claims), FR-AUTH-04 (INTEGRATION claims), §8 JWT `typ` rule, §7.0 enforced RLS bypass, §5.7.2 `{schema}_platform` roles, §11 Phase 1 data-foundations item; ADR-0016 added; ADR-0010 amended.
- `PROJECT.md` v1.0: authoritative master document, built from `docs/AEGIS_PULSE.md` and `docs/PROJECT_TEMPLATE_GUIDE.md` and adapted to the homelab k3s and GitLab target in `docs/K3S_CONTEXT.md`. It defines 117 functional requirements across 21 domains, NFR-01–NFR-18, 21 implementation phases, full DDL, API and error contracts, messaging topology, and the event catalog.
- AI governance: `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` (12 role skills and 5 workflow skills), `.claude/agents/` (3 review agents), `.claude/hooks/` (migration, generated-code, and secret-file guards), and the GitLab merge request template.
- Session recorder hook (`.claude/hooks/session_log.py`) logs prompts, responses, tool and file summaries, compaction summaries, and timestamps to `docs/sessions/`.
- Steering documents: `docs/steering/{product,tech,structure,quality}.md`.
- ADR-0001 through ADR-0012, plus spec and evidence templates.

### Changed
- Dependencies: `rxjs-rabbitmq` 3.0.0 adopted inside pnpm's minimum-release-age window by explicit owner decision. The exception is scoped to that single version in `pnpm-workspace.yaml` and is removed once the window passes. `docs/libs/RXJS_RABBITMQ.md` now carries the 3.0.0 README; the temporary upgrade brief was deleted on adoption.
- Cluster topology (ADR-0015): the storage node is now `optiplex-tower` (8 vCPU / 30 GiB / 1 TB data SSD); `optiplex` becomes the app-compute worker; NFR-03 and §5.4 budgets are expressed per tier (compute/storage) with unchanged numbers. PROJECT.md §1.5, NFR-03, NFR-12, §4.3, §5.3, §5.4, §9.3, Phase 9, §13.1, and A18 are amended. K3S_CONTEXT, CLAUDE.md, the kubernetes-platform skill (which gains a troubleshooting-access section) and the systems-architect skill are updated.
- PROJECT.md (Phase 1a): uniform internal RPC route `POST /internal/v1/{action}`; `aegispulse.dlx` is a topic exchange; one retry queue per distinct delay; enrichment-timer delay queue; `mig_events` Mongo principal; RLS helpers + history-protection callback; added actions `registry.listServiceAccounts`, `cases.getTransactionEvaluation`; gateway SERVICE-token cases and unauthenticated `issueClientCredentialsToken`; `/v1/openapi.json` route.
- Dependencies: `amqplib` pinned to 2.4.0 (2.4.1 was hours old and tripped pnpm's minimum-release-age policy; the auto-added bypass was removed); pnpm build scripts allowed for `esbuild` only.
- ADR-0011 accepted: SeaweedFS 4.54 (MinIO community image no longer published). Version baselines updated: NestJS 12, TypeScript 6.0.3 (TS 7 deferred, typescript-eslint peer range <6.1), pnpm 12, Spring Boot 4.2.
- ADR-0013: the gateway is now NestJS on `@nestjs/platform-fastify`, renamed `gateway/fastify-http` → `gateway/nest-http` everywhere (PROJECT.md §6.1/§6.3/§12, CLAUDE.md, AGENTS.md, steering, skills, agents, ADR-0001/0002). Internal service adapters stay plain Fastify.
- `docs/PROJECT_TEMPLATE_GUIDE.md`: new "AI Governance & Consistency Constructs" section, plus checklist and quality-bar items.

- ADR-0014: `dev` (`aegispulse-dev`, `*.rmwhs-dev.space`) and `prod` (`aegispulse`, `*.rmwhs.com`) environments on the same cluster and Cloudflare tunnel. `main` auto-deploys to dev, and prod receives the same digests by manual or tag promotion. Active DAST, chaos, and resets are dev only. Applied across PROJECT.md, CLAUDE.md, ADR-0006/0007/0012, skills, and evidence templates.

### Status
- Phase 1 slice 1b (`ts-platform`) `INTEGRATION-VERIFIED`: 46 unit + 19 Testcontainers integration tests against PostgreSQL 18.7 (as `svc_files`, under RLS) and RabbitMQ 4.4.1 (configure-`^$` runtime user) — [evidence](docs/evidence/phase-01b.md). It was briefly paused on `rxjs-rabbitmq` 2.2.3; the owner's 3.0.0 was reviewed and accepted ([review](docs/evidence/rxjs-rabbitmq-3.0.0-review.md)).
- Platform: ADR-0015 node roles applied on the cluster and runtime-verified (data SSD mounted under the local-path directory on `optiplex-tower`, storage taint moved, `optiplex` relabelled worker, PVC smoke test on the SSD) — [evidence](docs/evidence/platform-node-roles.md).
- Phase 1 slice 1e `INTEGRATION-VERIFIED`: all 12 runtimes reach `/readyz` 200 under `make up` + `make migrate` — [evidence](docs/evidence/phase-01e.md). Health-request traces are verified in OpenObserve; Phase 1 exit now needs only the commit and a green first GitLab pipeline.
- Phase 1 slice 1d (`py-platform`) `INTEGRATION-VERIFIED`: 33 unit + 11 Testcontainers integration tests (PostgreSQL 18.7 as `svc_analytics`, RabbitMQ 4.4.1 with a configure-`^$` user) — [evidence](docs/evidence/phase-01d.md).
- Phase 1 slice 1c (`java-platform`) `INTEGRATION-VERIFIED`: 29 unit + 11 Testcontainers integration tests (Spring context against PostgreSQL 18.7 as `svc_cases` and RabbitMQ 4.4.1 with a configure-`^$` user) — [evidence](docs/evidence/phase-01c.md).
- Phase 1: slice 1a `INTEGRATION-VERIFIED` (contracts + data foundations) — [evidence](docs/evidence/phase-01a.md); slices 1b–1e `INTEGRATION-VERIFIED`.
- Phase 0: `SOURCE-IMPLEMENTED`, local runtime verified on macOS. First GitLab pipeline and a Linux `make up` run are pending ([evidence](docs/evidence/phase-00.md)). All FRs: `PENDING`.
