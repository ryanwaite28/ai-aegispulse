# CLAUDE.md — AegisPulse

## Project Summary
AegisPulse is a multi-tenant, event-driven risk, regulatory and market-intelligence platform (portfolio-grade). It ingests verified webhooks, connector feeds, transactions and file uploads; archives every routed event in MongoDB with sensitivity and severity lineage (`publisher_stated_severity` → `algorithm_severity` → `final_severity`); scores risk; runs case workflows with an immutable audit log; and feeds analyst dispositions back into data-intelligence metrics.
Stack: Node.js 24/TypeScript (NestJS-on-Fastify gateway; Fastify ingestion/files/events/orchestrator services) · Java 25/Spring Boot 4 (registry, cases) · Python 3.13/FastAPI (risk-scoring, sensitivity-scanner, doc-extraction, data-intel) · RabbitMQ · PostgreSQL 18 · MongoDB 8 · Redis 8 · S3-compatible object storage · homelab k3s · GitLab CI.
**`PROJECT.md` is the single source of truth.** Read the sections relevant to your task before writing code. When something isn't specified there, propose an amendment. Don't invent it.

## Quick Start
```bash
make bootstrap        # toolchains + gitleaks pre-commit hook (once)
make env              # .env from Infisical env=local (or cp .env.example .env)
make up               # docker compose: infra + all services
make migrate          # Flyway (5 schemas) + migrate-mongo + RabbitMQ topology
make seed             # demo tenants/users/entities/watchlists/sources
make dev SERVICE=cases   # run one service natively with hot reload
make demo             # end-to-end scenario
```

## Where Things Are Decided
| Need | Look in |
|---|---|
| What to build (FRs, acceptance) | `PROJECT.md` §2 |
| Cross-cutting policy (idempotency, security, startup, observability) | `PROJECT.md` §3 |
| Flows, layering rule | `PROJECT.md` §4 |
| Workloads, queues, principals, network policy | `PROJECT.md` §5 |
| Repo layout, ServiceAction contract, envelope, event catalog | `PROJECT.md` §6 |
| DDL / Mongo / Redis / object keys | `PROJECT.md` §7 |
| HTTP routes, error codes | `PROJECT.md` §8 |
| Pipeline, deploy, migrations | `PROJECT.md` §9 |
| Current phase + checklist + status ledger | `PROJECT.md` §11 |
| Why a decision was made | `docs/adr/` |
| Manual steps (credentials/access the agent never holds) | `docs/runbooks/manual-bootstrap.md` (🛑 MANUAL MB-xx); Infisical: `docs/runbooks/infisical.md` |
| Pinned versions, conventions, quality bar | `docs/steering/` |
| Per-FR implementation specs | `docs/specs/` |

## Architecture Rules
- External HTTP, SSE and webhook traffic enters only through **`gateway/nest-http/`** (NestJS on `@nestjs/platform-fastify`, ADR-0013). Controllers, guards, pipes, and interceptors are transport only. Gateway `@Injectable` providers are typed clients and mappers only, and there are no `*.service.ts` files in the gateway.
- Gateway code only parses transport input, validates its shape, authenticates and derives auth context, invokes typed service clients (`src/clients/`), and maps output.
- ALL business logic lives in named `services/<bounded-context>/` runtimes: `src/service/` + `src/domain/` (TS), `..service`/`..domain` (Java), `service/`/`domain/` (Python). Domain orchestration, repositories, DB access, transactions, and outbox publication stay in services.
- Dispatch-layer components (gateway handlers, `src/adapters/http`, `src/adapters/amqp` consumers, `workers/scheduler-trigger` CronJobs, the webhook receiver) are transport adapters only: parse → call ONE service action → map/ack.
- Multi-step orchestration belongs to service-layer use cases (`src/service/orchestrators/`); cross-service sagas live in `services/orchestrator`. Never in handlers or consumers.
- ALL DB access goes through typed repositories/query adapters in the owning service (`src/db/`). No gateway or worker direct DB access. No service touches another service's schema, collection, Redis keyspace, or bucket prefix.
- Worker applications and transport adapters never open direct PostgreSQL/MongoDB/Redis/object-store connections; they call service APIs/contracts.
- NEVER put domain logic, DB queries, or side effects in gateway handlers or consumer adapters.
- Every message uses the canonical envelope (`PROJECT.md` §6.4). Binaries never go on RabbitMQ (pointers only: `fileId`, `storageKey`, `sha256`). Publish via the transactional outbox. Topology is declared in `packages/contracts/topology/` and never at runtime.
- Automated classification is **elevate-only**. Only an analyst override, with justification, can lower severity (`PROJECT.md` §1.4.3).
- Contracts come first: edit `packages/contracts` (OpenAPI/AsyncAPI/JSON Schema), run `make contracts`, then implement. Never hand-edit `generated/`.

## Key Commands
- `make build`: build all workspaces (pnpm/tsc/vite, Gradle, uv)
- `make test-unit`: Vitest / JUnit / pytest unit suites
- `make test-integration`: Testcontainers suites (requires Docker)
- `make test-e2e`: E2E against the compose stack
- `make lint` / `make typecheck` / `make format`
- `make contracts`: validate and regenerate contract types
- `make migrate`: run pending migrations locally
- `make eval`: golden-dataset evaluation (Python model changes)
- `make images`: build all container images locally
- `make k3d-up`: optional parity cluster
- Deployment happens only through the GitLab pipeline: `main` → dev automatically, then manual/tag promotion → prod. Never `kubectl apply` by hand except for the bootstrap scripts.

## File Conventions
- Gateway module + controller: `gateway/nest-http/src/modules/{domain}/{domain}.module.ts`, `{domain}.controller.ts`
- Gateway typed client: `gateway/nest-http/src/clients/{service}.client.ts`
- Gateway cross-cutting: `gateway/nest-http/src/common/{guards,pipes,interceptors,mappers}/`
- Gateway SSE: `gateway/nest-http/src/stream/stream.controller.ts`
- Node service: `services/{svc}/src/service/{domain}.service.ts`; use cases in `src/service/orchestrators/{name}.usecase.ts` / `{name}.saga.ts`
- Node domain (pure): `services/{svc}/src/domain/{concept}.ts`
- Node repositories: `services/{svc}/src/db/{domain}.repository.ts`; migrations `services/{svc}/db/migrations/V{n}__{desc}.sql`
- Node adapters: `services/{svc}/src/adapters/http/{domain}.routes.ts`, `src/adapters/amqp/{queue}.consumer.ts`
- Java: `services/{svc}/src/main/java/io/aegispulse/{svc}/{domain,service,db,adapters/http,adapters/amqp,config}/`; migrations `src/main/resources/db/migration/V{n}__{desc}.sql`
- Python: `services/{svc}/src/aegis_{pkg}/{domain,service,adapters/http,adapters/amqp}/`; migrations `services/{svc}/db/migrations/V{n}__{desc}.sql`
- Mongo migrations: `services/events/src/db/mongo-migrations/{timestamp}-{desc}.js`
- Tests: unit co-located `{file}.test.ts` / `src/test/java/...` / `tests/unit/`; integration in `tests/integration/`; cross-service E2E in root `tests/e2e/`. Test names include FR ids.
- K8s: `deploy/k8s/base/{component}/`, overlays in `deploy/k8s/overlays/{dev,prod,k3d-local}/`
- CI logic: `ci/{verb}-{thing}.sh` (keep `.gitlab-ci.yml` declarative)

## Workflow for Any Change
1. Identify the FR ids and phase (`PROJECT.md` §2, §11). If there is no FR, stop and ask, or propose an amendment.
2. Write or update the spec in `docs/specs/` (`/write-spec`), and update contracts first.
3. Implement with tests (`/implement-fr`). Migrations are new files only.
4. Run lint, typecheck, unit, and integration tests. Don't claim more verification than you ran.
5. Update the §11 checklist and status ledger honestly, add a `CHANGELOG.md` entry under `[Unreleased]`, and attach evidence for phase exits (`/phase-exit-evidence`).
6. Architectural decision? Add an ADR (`/new-adr`) and amend `PROJECT.md` in the same MR.
7. Work depends on a 🛑 MANUAL step that isn't DONE in `docs/runbooks/manual-bootstrap.md`? Stop, give the operator that step's exact directions and what to report back (names, IDs, "done", never secret values), and resume only after verifying it read-only (PROJECT.md §12 rule 19).

## DO NOT
- Do not add business logic, DB/cache/storage clients, or transactions to gateway handlers, consumer adapters, or CronJob triggers.
- Do not import NestJS, Fastify, Spring Web, FastAPI, amqplib, Spring AMQP, or aio-pika types into `service/` or `domain/` code.
- Do not open database or cache connections in `gateway/` or `workers/`.
- Do not hardcode secrets, hostnames, bucket names, or environment-specific values. Use typed config from env.
- Do not create new architectural patterns, services, queues, exchanges, tables, routes, or env vars not defined in `PROJECT.md`.
- Do not modify existing migration files. Create new ones (expand/contract).
- Do not edit `packages/contracts/generated/` by hand.
- Do not use `any` (TS), raw types (Java), or untyped defs (Python).
- Do not name the external entrypoint ambiguously (`api-*`, `app-*`). The gateway is `gateway/nest-http/`.
- Do not place transport routing or HTTP-specific types inside `service/`/`domain/` code of service runtimes.
- Do not weaken signature checks, RLS, authz, SSRF guards, redaction, or rate limits to make tests pass.
- Do not mock Postgres, Mongo, RabbitMQ, or Redis in integration tests (use Testcontainers).
- Do not log secrets, raw webhook bodies, file contents, or unmasked PII.
- Do not use `:latest` images, `privileged: true`, or cluster-admin credentials.
- Do not point chaos, load, active DAST, or data-reset tooling at prod (`rmwhs.com` / namespace `aegispulse`). Use dev.
- Do not mark FRs, checklist items, or phases complete without evidence (`PROJECT.md` §11.0).

## Environment Notes
- **Local:** Docker Compose (`deploy/compose/`). Services reach infra by compose hostnames. Presigned URLs use `PUBLIC_OBJECTS_URL=http://localhost:9000`. OpenObserve UI: `http://localhost:5080`. RabbitMQ UI: `http://localhost:15672`.
- **Dev (homelab k3s):** namespace `aegispulse-dev`, hosts `aegispulse(.|-api.|-objects.)rmwhs-dev.space`. Auto-deployed from `main`. Active DAST, chaos, load, and data resets happen here only. Can be scaled to zero.
- **Prod (homelab k3s):** namespace `aegispulse`, hosts `aegispulse(.|-api.|-objects.)rmwhs.com`. Receives only dev-verified digests by manual promotion or `v*` tag. Never chaos-tested or reset (ADR-0014).
- **Secrets:** Infisical project **AegisPulse** (org HomeLab), envs Development → `aegispulse-dev`, Production → `aegispulse`; local `.env` is always generated (`make env`), never exported from Infisical. Never ask for, print, or store a secret value.
- **Both clusters:** ingress class `nginx-external`, plain HTTP behind the same Cloudflare Tunnel. Dev and prod share nothing above the platform layer and can't reach each other. Node roles (ADR-0015): data stores are pinned to the storage node `optiplex-tower` (1 TB data SSD), stateless pods prefer the worker `optiplex` and spill onto `elitedesk-800` (the control plane, which also runs GitLab and CI). Secrets come from the Infisical Operator. Images come from `registry.rmwhs.com` by digest. Use `KUBECONFIG=~/.kube/config` explicitly.
- Service code doesn't know which environment it runs in. Same code and images, different config.
- Cloudflare caps request bodies at 100 MB, so keep image layers under 95 MB and upload parts at 16 MiB.

## Model Routing (efficiency without losing quality)
Pick the cheapest model that can still meet the quality bar in `docs/steering/quality.md`. Use `/model` to switch the main session.
| Work | Model | Why |
|---|---|---|
| Architecture decisions, ADRs, `PROJECT.md` amendments, cross-service design, security-critical code (auth, webhooks, SSRF, RLS, audit chain), debugging hard failures | Opus | Judgment-heavy; mistakes are expensive and propagate |
| Routine FR implementation from an existing spec, tests, migrations, manifests, CI scripts, refactors | Sonnet | Well-specified work; spec and review agents carry the constraints |
| Mechanical tracing, grep and inventory, changelog and ledger updates, formatting, boilerplate | Haiku | Low reasoning, high volume |
Subagent defaults (frontmatter): `architecture-reviewer` → sonnet, `security-reviewer` → opus, `spec-tracer` → haiku. Never downgrade the model to save cost on security review or on `PROJECT.md` changes.

## Skills & Agents
Role skills live in `.claude/skills/`: `systems-architect`, `principal-engineer`, `devsecops`, `database-admin`, `cybersecurity`, `messaging-engineer`, `ml-ai-engineer`, `data-intel-engineer`, `sre-observability`, `kubernetes-platform`, `qa-test-engineer`, `frontend-engineer`.
Workflow skills: `/implement-fr`, `/write-spec`, `/phase-exit-evidence`, `/new-adr`, `/amend-project`.
Session trail: every prompt and response is recorded automatically to `docs/sessions/` by `.claude/hooks/session_log.py` (see `docs/sessions/README.md`).
Review agents live in `.claude/agents/`: `architecture-reviewer`, `security-reviewer`, `spec-tracer`. Use them before opening an MR.
