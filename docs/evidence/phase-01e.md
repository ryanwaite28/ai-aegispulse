# Phase 01 (slice 1e) — Service skeletons + gateway — Exit Evidence

| | |
|---|---|
| Commit SHA | base `1b7a4ee` + uncommitted slices 1b–1e working tree |
| Date (UTC) | 2026-11-23 |
| Environment(s) | local compose (macOS arm64, Docker 29.4.3): infrastructure + 12 application runtimes built from `deploy/docker/*.Dockerfile` |
| Pipeline | pending: the `workflow:rules` blocker is fixed (branch pipelines now run); first run after commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 1e `RUNTIME-VERIFIED` locally (all 12 `/readyz` 200; health-request traces in OpenObserve). Phase 1 exit still needs the commit and a green first GitLab pipeline |

## Scope
This slice covers the PROJECT.md §11 Phase 1 "Service skeletons" workstream. Every runtime has config validation, `/livez`, `/readyz` checking only its own dependencies, JSON logs, traces, and a multi-stage, non-root image with a read-only root FS. No business logic was added.

| Runtime | Stack | Port | Readiness checks (own dependencies only) |
|---|---|---|---|
| gateway | NestJS 12 on the platform Fastify instance | 8080 | none: transport only. Also serves request/correlation ids, the 256 KiB body limit, §8.2 envelopes, a global JWKS guard (`@Public()` opt-out) and `/v1/openapi.json` |
| ingestion | Fastify (ts-platform) | 8081 | postgres, Flyway ≥ V2, redis (ACL key prefix), object store (HEAD in its grant), rabbitmq |
| files | Fastify | 8082 | postgres, Flyway ≥ V2, redis, object store, clamav (`zPING`→`PONG`), rabbitmq (`files.validation.q` passive) |
| events | Fastify | 8083 | mongo ping, `schema_meta` baseline, object store, rabbitmq (3 queues passive) |
| registry | Spring Boot 4.2 + java-platform + OTel agent | 8084 | db, flywaySchema, rabbit, redisAcl (ACL-safe `auth:` key probe; Boot's PING/INFO indicator disabled) |
| cases | Spring Boot 4.2 + java-platform + OTel agent | 8085 | db, flywaySchema, rabbit |
| risk-scoring | FastAPI + py-platform | 8086 | redis (`feat:` key probe) |
| sensitivity-scanner | FastAPI | 8087 | none |
| doc-extraction | FastAPI | 8088 | rabbitmq (`doc.extraction.q` passive) |
| data-intel | FastAPI | 8089 | postgres, Flyway ≥ V2, object store, rabbitmq |
| orchestrator | Fastify | 8090 | rabbitmq (5 queues passive) |
| console | nginx-unprivileged placeholder (Phase 19 builds the app) | 8080 (host 8091) | static; CSP / nosniff / no-referrer / DENY headers |

**Supporting changes:**
- **ts-platform:**
  - a `http` adapter (`createHttpServer`, `registerHealthRoutes`, `toErrorResponse`, a `nestManaged` mode for the gateway);
  - `build-info`;
  - Redis, object-store and Mongo env schemas, and the auth schema split into verify vs. SERVICE credentials;
  - the OTel SDK composed from minimal parts instead of `sdk-node`.
- **py-platform:** `build_info` and `JwtVerifySettings`.
- **Packaging:** `aegis_contracts` resources and `@aegispulse/contracts/openapi/gateway.public.yaml` export.
- **Compose:** 12 services, each with only its own interpolated credentials, read-only root, tmpfs `/tmp`, `cap_drop: [ALL]`, `no-new-privileges`, and a localhost-only port.
- **Tooling:**
  - `make images` (`scripts/dev/build-images.sh`) and a root `.dockerignore`;
  - `make migrate` now runs `scripts/dev/pg-bootstrap.sh` (idempotent `{schema}_platform` roles for volumes created before ADR-0016) and finishes with a `/readyz` wait;
  - `make up` waits for `/livez`.

## Runtime Completion Gate (§11.0), applied to this slice
- [ ] 1. Source merged: no, the working tree is uncommitted.
- [x] 2. Clean-state startup: `make images`, then `make up` (all infra healthy, init jobs exit 0, 12 runtimes `/livez`), then `make migrate` (bootstrap, V2 on 5 schemas, Mongo, topology; 12 runtimes `/readyz` = 200). Re-running `make migrate` is a no-op.
- [x] 3. Real dependencies only, from the same compose infrastructure as dev/prod parity.
- [x] 4. Async infrastructure: every consumer queue is verified passively by its runtime user, and topology asserts 6 exchanges, 58 queues and 71 bindings.
- [x] 5. Security:
  - non-root users, read-only root FS, no capabilities, no-new-privileges;
  - per-runtime credentials only;
  - Redis readiness stays inside each ACL key prefix;
  - object-store probes stay inside each identity's grant;
  - startup without config fails fast, naming keys only.
- [x] 6. Observability: JSON logs, plus traces in OpenObserve. The gateway's `GET /healthz` is a server span with `url_path=/healthz`, status 200, `service.version=1b7a4ee`, `deployment.environment.name=local`, e.g. trace `ad5627e700d3f1765b5c3ded7d4be24d`. Registry `/healthz` traces include their readiness DB spans, and ingestion/risk-scoring spans also arrive. `/livez` and `/readyz` are intentionally untraced. (The first attempt got 401 because the header lacked its `Authorization=` key; the owner fixed `.env`.)

## Commands & output
```text
$ make images            → 12 images built; check-layer-sizes (compressed): largest layers registry 66 MB, cases 60 MB,
                           node services 56 MB, data-intel 40 MB, python 29 MB, console 17 MB — OK (12 images)
$ make up                → compose-wait: all services healthy, init jobs completed, 12 runtimes pass /livez
$ make migrate           → NOTICE: created {ingestion,files,registry,cases,analytics}_platform
                           5 schemas: Versioned 2 "enforced rls bypass" Success; topology-assert: 6 exchanges, 58 queues, 71 bindings
                           compose-wait: … 12 runtimes pass /readyz
$ make migrate (again)   → pg-bootstrap: platform roles present (nothing created); … 12 runtimes pass /readyz
```
Per-runtime readiness (`/healthz`):
```text
gateway              readyz=200
ingestion            readyz=200  postgres=up,schema=up,redis=up,objectstore=up,rabbitmq=up
files                readyz=200  postgres=up,schema=up,redis=up,objectstore=up,clamav=up,rabbitmq=up
events               readyz=200  mongo=up,schema=up,objectstore=up,rabbitmq=up
registry             readyz=200  db=UP,flywaySchema=UP,rabbit=UP,redisAcl=UP,readinessState=UP,…
cases                readyz=200  db=UP,flywaySchema=UP,rabbit=UP,readinessState=UP,…
risk-scoring         readyz=200  redis=up
sensitivity-scanner  readyz=200
doc-extraction       readyz=200  rabbitmq=up
data-intel           readyz=200  postgres=up,schema=up,objectstore=up,rabbitmq=up
orchestrator         readyz=200  rabbitmq=up
console              readyz=200
```
Fail-fast without configuration (read-only FS, no env):
```text
ingestion   {"level":"fatal","service":"ingestion","msg":"startup failed","issues":[{"key":"AEGIS_ENV",…},{"key":"AMQP_URL","problem":"required"},…]}  exit=1
data-intel  ConfigError: invalid configuration: PG_HOST (required); … S3_BUCKET_PREFIX (required)  → Application startup failed
registry    PlaceholderResolutionException: Could not resolve placeholder 'AEGIS_ENV'  (first missing key only; see deviations)
```
Gates: ci/lint-{node,python,java,shell}.sh OK; ci/test-{node,python,java}.sh OK (Node: contracts 15, ts-platform 51, 4 services × 2, gateway 4; Python 54; Java unit + ArchUnit), import-linter 4 contracts kept, ci/check-boundaries.sh OK.

## Trace verification (2026-11-23)
OpenObserve was queried from inside the gateway container with that container's own OTLP credentials, so no secret was handled outside it:
```text
aegispulse-gateway  GET  url_path=/healthz  http_response_status_code=200  span_kind=SERVER  service_version=1b7a4ee  env=local
                    trace_id=ad5627e700d3f1765b5c3ded7d4be24d (3.1 ms)  … 4 /healthz traces in 15 min
aegispulse-ingestion HEAD (object-store readiness probe) · aegispulse-risk-scoring GET /healthz + FastAPI internals
aegispulse-registry GET /healthz → SELECT "registry".flyway_schema_history (readiness check as child span)
```
**Fixed during verification: idle-poll trace flood.** The Java outbox relays poll every 250 ms, and the OTel agent recorded each poll's JDBC/AMQP calls as a new root trace: about 240 spans per 30 s from registry and cases while idle. `OutboxRelay` now runs each poll under a valid but unsampled parent context, so the parent-based sampler drops them. After the fix: **0 spans in 30 s while idle**, and request traces are unchanged (unit test `OutboxRelayTest`).

**Open item (NFR-07, needs an amendment when the first outbox flow exists):** a trace should span gateway → service → outbox → RabbitMQ → consumer. Today the relay publishes outside the original request's trace, because `outbox_events` has no column for the producing `traceparent`. Proposal: add `traceparent TEXT` to the outbox DDL (§6.6/§7.0), let `enqueue` capture the current context, and have the relay publish under it. To be decided in the phase that introduces the first outbox-producing FR.

## Problems found and fixed during verification
- **Image layer cap.** The first Node image had a 112 MB app layer, mostly `@opentelemetry/sdk-node`'s unused gRPC, protobuf, Zipkin and Prometheus exporters. ts-platform now composes the SDK from `sdk-trace` + `sdk-metrics` + OTLP/HTTP exporters, and the app layer dropped to 92.7 MB uncompressed.
- **The layer check measured the wrong thing.** `ci/check-layer-sizes.sh` summed uncompressed history sizes, so every Node base layer (161 MB uncompressed) failed. The Cloudflare limit applies to pushed, gzip-compressed blobs, so the check now measures compressed layer size, with the same 95 MB limit.
- **Redis readiness under ACLs.** Service ACL users lack `@connection` and `INFO`, so `PING` and Boot's Redis indicator would always report DOWN. Probes now use `EXISTS` inside each user's key prefix.
- **Existing local volumes and ADR-0016.** Volumes created before ADR-0016 lack the platform roles, and V2 would have failed on them. The idempotent `pg-bootstrap.sh` in `make migrate` creates them, so no `make reset` (data loss) is required.
- **Gateway.** The Nest Fastify adapter installs its own 404 and error handlers, so the platform server's `nestManaged` mode skips them and Nest's envelope filter maps both.

## Decisions and deviations
- **Dockerfile layout.** One parameterised Dockerfile per runtime family (`deploy/docker/`), built from the repo root. PROJECT.md §6.1 doesn't fix a location.
- **Version.** Build identity comes from `/app/build-info.json` or `.properties`, written from the `GIT_SHA` build arg, not from a new env var.
- **Java config errors** report the first unresolved placeholder only (Spring behaviour). The `aegis.*` properties are validated together. A failure analyser that lists all keys is a follow-up.
- **`make dev SERVICE=…`** is still unimplemented. Hot reload matters once services have code (Phase 2+).
- **Gateway SERVICE credentials** (`SERVICE_CLIENT_ID`/`SECRET`) are not required yet. The gateway first calls registry in Phase 2.
- **Console** publishes on host port 8091 locally (the gateway owns 8080); in the cluster it is port 8080 behind its own Service.
