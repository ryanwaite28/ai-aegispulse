# ADR-0013 — Gateway framework: NestJS on the Fastify adapter

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Ryan M. Waite (evaluated with the `systems-architect` skill)
- **PROJECT.md sections affected:** §1.2, §4.1, §6.1, §6.3, §10.3, §11 (Phases 0, 1, 17), §12; NFR-04, NFR-14
- **Related:** ADR-0002 (gateway/service separation), ADR-0010 (JWT everywhere)

## Context
The v1.0 baseline specified a plain Fastify 5 gateway at `gateway/fastify-http`. The owner wants NestJS for the gateway's module structure, guards, interceptors, pipes, and DI, while keeping Fastify's performance. NestJS supports Fastify as its HTTP platform through `@nestjs/platform-fastify`.

## Decision
- The single external gateway is **NestJS on `@nestjs/platform-fastify`**, located at **`gateway/nest-http/`**. Every reference to `gateway/fastify-http` is renamed.
- Scope is **gateways only**. Internal HTTP adapters of the Node services (`ingestion`, `files`, `events`, `orchestrator`) stay on plain Fastify 5 (`src/adapters/http/`). They are not gateways, and their thin adapters gain nothing from Nest.
- Nest building blocks are mapped to the existing layering:

| Nest construct | Allowed role in the gateway |
|---|---|
| Module | feature grouping (`auth`, `cases`, `files`, `webhooks`, `stream`, …) |
| Controller | transport handler: parse → call **one** typed client method → map (ADR-0002) |
| Guard | JWT verification (JWKS via `jose`) and coarse role pre-checks (the service layer still enforces RBAC and tenant ownership) |
| Pipe | Zod validation of request shape, using schemas generated from `packages/contracts` |
| Interceptor | correlation/request ids, logging, error-envelope mapping (§8.2), timeouts |
| Provider (`@Injectable`) | **typed service clients and mappers only**, named `*.client.ts` / `*.mapper.ts`. No `*.service.ts` files in the gateway, so business services can't be confused with the service layer. |

## Guardrails (architecture-preserving constraints)
1. **No business logic or datastores:** gateway providers may not import `pg`, `mongodb`, `ioredis`, or `@aws-sdk/*`, and may not hold business rules. Enforced by `ci/check-boundaries.sh` and dependency-cruiser rules on `gateway/nest-http/src/**`.
2. **Contracts first:** the public OpenAPI stays hand-authored in `packages/contracts/openapi/gateway.public.yaml` and is served from that file at `/v1/openapi.json`. `@nestjs/swagger` decorator generation is **not** used as a source of truth. A contract test asserts that every controller route exists in the spec, and the reverse.
3. **Webhook raw body:** `NestFactory.create(AppModule, new FastifyAdapter({ bodyLimit }), { rawBody: true })`. The webhook controller forwards `req.rawBody` (bytes, never re-serialized JSON) to ingestion. The 1 MiB limit applies on the webhook route.
4. **Rate limiting:** `@nestjs/throttler` with in-memory storage only (per-pod defense). Distributed quotas remain in owning services, so the gateway stays datastore-free.
5. **SSE:** `@Sse()` controllers return RxJS `Observable`s fed by the broker subscription (`rxjs-rabbitmq`), so the projection pipeline stays reactive end to end. Ingress buffering stays off.
6. **TypeScript:** the gateway tsconfig adds `experimentalDecorators` + `emitDecoratorMetadata` (required by Nest DI). All strict flags stay on and `any` stays banned (NFR-14 exception scoped to these two flags in `gateway/nest-http` only).
7. **Capacity:** NestJS adds roughly 20–40 MiB RSS. The gateway's requests/limits (128Mi / 384Mi) stay and get revalidated in the Phase 18 soak. Raise them only with evidence.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| NestJS + Fastify adapter (chosen) | structured modules, guards, pipes, and interceptors suit a large route surface (~80 public routes); native SSE with RxJS; Fastify throughput | decorator metadata, a slightly larger footprint, and DI that could tempt logic into the gateway (mitigated by guardrails 1 and 6) |
| Plain Fastify (v1.0 baseline) | minimal and fast | hand-rolled structure for many routes and cross-cutting concerns |
| NestJS on Express | most common Nest setup | slower; diverges from the Fastify used by the internal adapters |

## Consequences
- The gateway's file conventions change (controllers, guards, pipes, interceptors, and modules instead of `handlers/` and `middleware/`).
- No change to services, contracts, topology, data ownership, capacity budget, or NetworkPolicies.
- Two Node HTTP frameworks coexist (NestJS at the edge, Fastify for internal adapters), separated by layer.

## Verification
Boundary check and dependency-cruiser on the gateway; a contract test covering controller routes against `gateway.public.yaml`; adversarial webhook suite (raw-body HMAC); SSE tenant-isolation test; Phase 18 soak memory metrics.
