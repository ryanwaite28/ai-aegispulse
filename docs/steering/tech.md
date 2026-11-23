# Steering — Technology

> The technology choices are set in `PROJECT.md` §6.3. This file pins **exact versions** and records every dependency added. Phase 0 fills in the "Pinned" column after checking current stable releases. Until then, the baseline major applies.

## Runtimes & platforms
Verified 2026-11-22 against the npm registry, PyPI, Maven Central, services.gradle.org, Docker Hub, and ghcr.io.

| Component | Baseline (PROJECT.md) | Pinned (Phase 0) | Notes |
|---|---|---|---|
| Node.js | 24 LTS | **24.22.3** | `.nvmrc`; `engines` `>=24.22.0 <25` |
| pnpm | via corepack | **12.21.0** | `packageManager` field; shim in `.tools/bin` (`make bootstrap`) |
| TypeScript | 6.x | **6.0.3** | TS 7.0.2 (native compiler) not adopted: `typescript-eslint@8.73` peer range is `>=4.8.4 <6.1.0`, and NestJS decorator metadata is unverified on TS 7. Revisit when typescript-eslint supports it. |
| NestJS (gateway) + `@nestjs/platform-fastify` | 12.x | **12.6.0** | ADR-0013 |
| `@nestjs/throttler` | — | **6.8.0** | |
| Fastify (gateway adapter + internal service adapters) | 5.x | **5.12.8** | |
| ESLint / typescript-eslint / Prettier | — | **10.15.0 / 8.73.0 / 3.10.1** | `@eslint/js` 10.0.1 |
| Vitest | — | **5.1.1** | |
| Java | 25 LTS | **25** (local: Homebrew openjdk@25 25.0.5.1; CI: `eclipse-temurin:25-jdk-noble`) | Gradle toolchain 25 |
| Gradle | wrapper | **9.9.2** | wrapper with `distributionSha256Sum` |
| Spring Boot | 4.x | **4.2.0** | Maven Central `maven-metadata.xml` (the search API index was stale) |
| Flyway | — | **11.20.3** (`flyway/flyway:11.20.3-alpine`) | |
| Testcontainers (Java) | — | **2.0.5** | |
| Python | 3.13 | **3.13** (uv-managed 3.13.18) | spaCy 3.8.18 supports <3.16 |
| uv | — | **0.13.9** | CI image `ghcr.io/astral-sh/uv:0.13.9-python3.13-trixie-slim` (no bookworm variant at this version) |
| Ruff / mypy / pytest / import-linter | — | **0.17.6 / 2.4.1 / 9.2.0 / 2.17** | root `pyproject.toml` dev group |
| FastAPI / Pydantic / pydantic-settings | — | **0.165.0 / 2.14.4 / 2.16.3** | pinned in service `pyproject.toml` files from Phase 1 |
| PostgreSQL | 18 | **`postgres:18.7-alpine`** | |
| MongoDB | 8.0 | **`mongo:8.0.38`** | |
| Redis | 8 | **`redis:8.10.3-alpine`** | |
| RabbitMQ | 4.x | **`rabbitmq:4.4.1-management-alpine`** | cluster broker version still to be verified in Phase 9 |
| Object store | S3-compatible (ADR-0011) | **SeaweedFS `chrislusf/seaweedfs:4.54`** (Apache-2.0) | ADR-0011 accepted; `minio/minio` is no longer on Docker Hub (404) |
| ClamAV | stable | **`clamav/clamav:1.5.5-debian13-slim`** | plain `1.5.5` tag is amd64-only |
| OpenObserve | current | **`openobserve/openobserve:v1.1.2`** | distroless image, so health is probed from the host |
| React / Vite | 19 / current | **19.3.1 / 8.3.8** | pinned in `apps/console` (Phase 19) |
| CI images | — | `node:24.22.3-alpine3.24`, `zricethezav/gitleaks:v8.30.1`, `koalaman/shellcheck-alpine:v0.11.0`, `gradle:9.9.2-jdk25` (wrapper generation) | |

## Key libraries
| Concern | Node | Java | Python |
|---|---|---|---|
| HTTP server | NestJS on Fastify (gateway); Fastify (service internal adapters) | Spring Web MVC (virtual threads) | FastAPI + uvicorn |
| Validation | Zod | Bean Validation | Pydantic v2 |
| SQL | `pg` + Kysely | `JdbcClient` | SQLAlchemy 2 Core + psycopg 3 |
| Mongo | `mongodb` 6 | — | — |
| Redis | `ioredis` | Spring Data Redis (registry only) | `redis-py` |
| AMQP | `rxjs-rabbitmq` on `amqplib` (via `ts-platform/amqp`) | Spring AMQP | `aio-pika` |
| HTTP client | `undici` + `opossum` | `RestClient` + Resilience4j | `httpx` + `pybreaker` |
| JWT | `jose` | Spring Security resource server / Nimbus | `pyjwt[crypto]` |
| Logging | `pino` | Logback JSON encoder | `structlog` |
| Telemetry | OpenTelemetry JS | OTel Java agent + Micrometer | OpenTelemetry Python |
| Architecture tests | `dependency-cruiser` | ArchUnit | `import-linter` |
| Tests | Vitest, Testcontainers | JUnit Jupiter, AssertJ, jqwik, Testcontainers | pytest, hypothesis, testcontainers |

## Dependency policy
- A new dependency needs a row in the log below and a line in the MR description: purpose, license, maintenance signal, and alternatives considered.
- Licenses: MIT, Apache-2.0, BSD, ISC, MPL-2.0 are fine. LGPL is fine only for unmodified libraries used as-is (dynamically imported/linked), e.g. psycopg 3 (mandated by PROJECT.md §6.3); never vendor or patch LGPL code. AGPL/SSPL/BSL only for separately deployed infrastructure, never linked into our code, and with an ADR.
- No dependency for trivial code (left-pad rule). Prefer the standard library.
- Lockfiles are always committed: `pnpm-lock.yaml`, `gradle.lockfile`, `uv.lock`.
- Pin images by digest in `deploy/k8s/overlays/*`.

## Dependency log
| Date | Runtime | Package | Version | Purpose | License | Added by (MR) |
|---|---|---|---|---|---|---|
| 2026-11-22 | root (Node) | eslint, @eslint/js, typescript-eslint, prettier, typescript, vitest | see table | lint/format/typecheck/test tooling | MIT / Apache-2.0 | Phase 0 |
| 2026-11-22 | root (Python dev) | ruff, mypy, pytest, import-linter, boto3, requests, pyyaml, types-PyYAML | see table / 2.34.2 / 6.0.4 | lint, types, tests, object-store compat check, budget check | MIT / Apache-2.0 / BSD | Phase 0 |
| 2026-11-22 | infra | SeaweedFS 4.54 | 4.54 | S3-compatible object store (ADR-0011) | Apache-2.0 | Phase 0 |
| 2026-11-23 | Node (ts-platform) | rxjs-rabbitmq (+ peers amqplib 2.4.0, rxjs 7.8.2) | 3.0.0 | AMQP client (owner's library; [review](../evidence/rxjs-rabbitmq-3.0.0-review.md); release-age exception, single version) | ISC | Phase 1b |
| 2026-11-23 | Node (ts-platform) | zod, pino, undici, opossum, jose, ajv + ajv-formats | 4.6.7 / 10.4.0 / 8.13.1 / 10.0.0 / 6.2.18 / 8.20.0 + 3.0.1 | config validation, logging, HTTP client, circuit breaker, JWT, envelope validation | MIT / Apache-2.0 (opossum) | Phase 1b |
| 2026-11-23 | Node (ts-platform) | @opentelemetry/{api 1.10.0, sdk-node 0.301.2, exporter-trace/metrics-otlp-http 0.301.2, instrumentation(-http) 0.301.2, instrumentation-undici 0.35.1, sdk-metrics/resources/core/context-async-hooks 3.1.1, semantic-conventions 1.45.0} | see list | traces + metrics over OTLP/HTTP, propagation | Apache-2.0 | Phase 1b |
| 2026-11-23 | Node (ts-platform dev) | pg + @types/pg, @types/opossum, @testcontainers/{postgresql,rabbitmq} | 8.23.1 / 8.1.9 / 12.2.2 | integration tests (real PostgreSQL/RabbitMQ) | MIT | Phase 1b |
| 2026-11-23 | Java (java-platform) | Spring Boot 4.2.0 BOM starters: webmvc, validation, actuator, security-oauth2-resource-server, rabbitmq, jdbc, jackson; postgresql 42.7.14 | BOM 4.2.0 | platform starter (Spring AMQP 4.2, Security 7.2, Jackson 3.1) | Apache-2.0 / BSD-2 | Phase 1c |
| 2026-11-23 | Java (java-platform) | com.networknt:json-schema-validator, org.jspecify:jspecify, com.tngtech.archunit | 3.0.9 / 1.0.1 / 1.5.1 | envelope validation (Jackson 3), nullness annotations, layering rules | Apache-2.0 | Phase 1c |
| 2026-11-23 | Java (build) | Error Prone + NullAway (net.ltgt.errorprone 5.2.0), Spotless 8.12.0 + google-java-format | 2.53.0 / 0.14.4 / 1.37.0 | NFR-14 static analysis and formatting | Apache-2.0 / MIT | Phase 1c |
| 2026-11-23 | Java (test) | Testcontainers 2.0.5 (postgresql, rabbitmq, junit-jupiter) via Boot BOM | 2.0.5 | integration tests against real PostgreSQL/RabbitMQ | MIT | Phase 1c |
| 2026-11-23 | Python (py-platform) | pydantic-settings, structlog, aio-pika, pyjwt[crypto], psycopg[binary] + psycopg-pool, jsonschema[format], fastapi | 2.16.3 / 26.1.0 / 10.2.3 / 2.15.1 / 3.3.9 + 3.3.3 / 4.26.0 / 0.165.0 | settings, JSON logs, AMQP kit, JWT, outbox/dedup, envelope validation, health router | MIT / Apache-2.0 / LGPL-3.0 (psycopg, linked as a library) | Phase 1d |
| 2026-11-23 | Python (py-platform) | opentelemetry-api/sdk/exporter-otlp-proto-http, opentelemetry-instrumentation-fastapi | 1.45.2 / 0.66b2 | traces + metrics over OTLP/HTTP | Apache-2.0 | Phase 1d |
| 2026-11-23 | Python (dev) | pytest-asyncio, testcontainers[postgres,rabbitmq], uvicorn; hatchling (build) | 1.5.0 / 4.15.0 / 0.54.0 / 1.33.0 | async tests against real PostgreSQL/RabbitMQ; packaging | Apache-2.0 / BSD / MIT | Phase 1d |
| 2026-11-23 | Node (services, gateway) | fastify (ts-platform http adapter), ioredis, @aws-sdk/client-s3, pg, @nestjs/{common,core,platform-fastify} + reflect-metadata, @opentelemetry/sdk-trace (replaces sdk-node) | 5.12.8 / 6.1.0 / 3.1175.0 / 8.23.1 / 12.6.0 + 0.2.2 / 3.1.1 | HTTP adapters, owned infra clients, gateway (ADR-0013), lighter OTel SDK (image layer cap) | MIT / Apache-2.0 | Phase 1e |
| 2026-11-23 | Java (services) | spring-boot-starter-data-redis (registry), io.opentelemetry.javaagent:opentelemetry-javaagent | BOM 4.2.0 / 2.34.0 | registry Redis client; tracing agent (§6.3) | Apache-2.0 | Phase 1e |
| 2026-11-23 | Python (services) | uvicorn, redis (risk-scoring; 8.2.0 skipped: released the same day), boto3 (data-intel) | 0.54.0 / 8.1.0 / 1.44.9 | ASGI server, owned infra clients | BSD / MIT / Apache-2.0 | Phase 1e |
| 2026-11-23 | images | nginxinc/nginx-unprivileged (console), python:3.13.18-slim-trixie, eclipse-temurin:25-jre-noble, node:24.22.3-alpine3.24 | 1.31.7-alpine3.24 | runtime bases (non-root, read-only FS) | various OSS | Phase 1e |
