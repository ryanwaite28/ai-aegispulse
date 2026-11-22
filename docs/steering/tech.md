# Steering — Technology

> The technology choices are set in `PROJECT.md` §6.3. This file pins **exact versions** and records every dependency added. Phase 0 fills in the "Pinned" column after checking current stable releases. Until then, the baseline major applies.

## Runtimes & platforms
| Component | Baseline (PROJECT.md) | Pinned (Phase 0) | Verified on |
|---|---|---|---|
| Node.js | 24 LTS | _tbd_ | — |
| pnpm | 10.x | _tbd_ | — |
| TypeScript | 5.x | _tbd_ | — |
| NestJS (gateway) + `@nestjs/platform-fastify` | 11.x | _tbd_ | — |
| Fastify (gateway adapter + internal service adapters) | 5.x | _tbd_ | — |
| Java | 25 LTS (Temurin) | _tbd_ | — |
| Spring Boot | 4.x | _tbd_ | — |
| Gradle | wrapper, current | _tbd_ | — |
| Python | 3.13 | _tbd_ | — |
| uv | current | _tbd_ | — |
| FastAPI / Pydantic | current / v2 | _tbd_ | — |
| PostgreSQL | 18 | _tbd_ (image digest) | — |
| MongoDB | 8.0 | _tbd_ | — |
| Redis | 8 | _tbd_ | — |
| RabbitMQ | 4.x (cluster broker version: verify) | _tbd_ | — |
| Object store | S3-compatible (ADR-0011) | _tbd_ (image + license check) | — |
| ClamAV | stable | _tbd_ | — |
| OpenObserve | current | _tbd_ | — |
| React / Vite | 19 / current | _tbd_ | — |

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
| — | — | — | — | — | — | — |
