# Steering — Structure ("where does this code go?")

> Authoritative tree: `PROJECT.md` §6.1. Use this decision table before creating any file.

## Decision table
| You are writing… | It goes in… | It may import… | It must NOT import… |
|---|---|---|---|
| A public HTTP route / webhook receiver / SSE projection | `gateway/nest-http/src/modules/{domain}/` (controller + module) or `src/stream/` (`@Sse`); guards, pipes, interceptors in `src/common/` | `src/clients/*`, `src/common/*`, `@nestjs/*`, `ts-platform` (http, auth, logging), generated contract types | `pg`, `mongodb`, `ioredis`, `@aws-sdk/*`, any `services/*` source |
| A typed client for a service | `gateway/nest-http/src/clients/{svc}.client.ts` (`@Injectable`) or `services/orchestrator/src/clients/` | generated types, `ts-platform/http-client` | business rules |
| An internal route of a service | `services/{svc}/src/adapters/http/` | that service's `src/service/*`, framework types | repositories directly, other services' code |
| A queue consumer | `services/{svc}/src/adapters/amqp/{queue}.consumer.ts` (Java/Python equivalents) | consumer kit, that service's service action | repositories, DB clients, business conditionals |
| A business rule or calculation | `services/{svc}/src/domain/` (pure, no I/O) | other domain modules, contract types | framework types, clients, repositories |
| A use case that changes state | `services/{svc}/src/service/` (single-aggregate) or `src/service/orchestrators/` (multi-step) | domain, repositories, outbox repository, typed clients, infra ports | HTTP/AMQP framework types |
| A cross-service saga | `services/orchestrator/src/service/orchestrators/{name}.saga.ts` | typed clients, domain helpers | any datastore client |
| SQL / Mongo queries | `services/{svc}/src/db/{domain}.repository.ts` | DB driver, query builder | service or domain logic |
| Object store / Redis / ClamAV access | `services/{svc}/src/storage/` (ports implemented here) | SDKs | business decisions |
| A PostgreSQL migration | `services/{svc}/db/migrations/V{n}__{desc}.sql` (Java: `src/main/resources/db/migration/`) | — | edits to existing files |
| A Mongo index/collection change | `services/events/src/db/mongo-migrations/` | — | runtime `createIndex` calls in app code |
| A wire contract (route, event, envelope) | `packages/contracts/{openapi,asyncapi,events,envelope,topology}/` | — | hand edits to `generated/` |
| A shared technical helper | `packages/{ts,java,py}-platform/` | infra libraries | business vocabulary (case, tenant rules, scoring) |
| A scheduled job | `workers/scheduler-trigger` job entry (calls one internal action) + CronJob manifest | `ts-platform/http-client`, auth | DB clients, business logic |
| A K8s resource | `deploy/k8s/base/{component}/` + overlay patches | — | secrets, `:latest`, privileged |
| A CI step | `ci/{verb}-{thing}.sh` + one job line in `.gitlab-ci.yml` | — | inline multi-line shell in YAML |
| A test | unit: next to the code; integration: `services/{svc}/tests/integration/`; cross-service: `tests/e2e/`; security/chaos/load: `tests/{security,chaos,load}/` | Testcontainers | mocks for DB/broker in integration tests |
| A design rationale | `docs/adr/NNNN-*.md` | — | decisions not reflected in PROJECT.md |
| An FR implementation plan | `docs/specs/FR-XXX-NN-*.md` | — | — |
| Proof that something works | `docs/evidence/phase-NN.md` | — | claims without commands and output |

## Naming
- Gateway (NestJS) files are `{domain}.controller.ts`, `{domain}.module.ts`, `{name}.guard.ts`, `{name}.pipe.ts`, `{name}.interceptor.ts`, `{svc}.client.ts`, `{domain}.mapper.ts`. Never use `*.service.ts` in the gateway.
- Services and directories use kebab-case. TS files use `{domain}.{role}.ts` (`case.service.ts`, `webhook.handler.ts`, `txn.consumer.ts`, `files.repository.ts`, `score-transaction.saga.ts`).
- Java packages are `io.aegispulse.{svc}.{layer}`. Classes are `{Thing}Service`, `{Thing}Repository`, `{Thing}Controller` (adapter), `{Queue}Listener` (adapter).
- Python modules are snake_case and packages are `aegis_{svc}`.
- Queues are `{owner}.{purpose}.q`, routing keys are `{domain}.{entity}.{verb-past}`, and error codes are `UPPER_SNAKE` (`PROJECT.md` §8.4).
- Env vars are `UPPER_SNAKE` and every one must appear in `PROJECT.md` §10.4.
