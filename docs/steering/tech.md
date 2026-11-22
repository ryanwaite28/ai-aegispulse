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
- Licenses: MIT, Apache-2.0, BSD, ISC, MPL-2.0 are fine. AGPL/SSPL/BSL only for separately deployed infrastructure, never linked into our code, and with an ADR.
- No dependency for trivial code (left-pad rule). Prefer the standard library.
- Lockfiles are always committed: `pnpm-lock.yaml`, `gradle.lockfile`, `uv.lock`.
- Pin images by digest in `deploy/k8s/overlays/*`.

## Dependency log
| Date | Runtime | Package | Version | Purpose | License | Added by (MR) |
|---|---|---|---|---|---|---|
| 2026-11-22 | root (Node) | eslint, @eslint/js, typescript-eslint, prettier, typescript, vitest | see table | lint/format/typecheck/test tooling | MIT / Apache-2.0 | Phase 0 |
| 2026-11-22 | root (Python dev) | ruff, mypy, pytest, import-linter, boto3, requests, pyyaml, types-PyYAML | see table / 2.34.2 / 6.0.4 | lint, types, tests, object-store compat check, budget check | MIT / Apache-2.0 / BSD | Phase 0 |
| 2026-11-22 | infra | SeaweedFS 4.54 | 4.54 | S3-compatible object store (ADR-0011) | Apache-2.0 | Phase 0 |
