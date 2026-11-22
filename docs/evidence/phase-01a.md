# Phase 01 (slice 1a) — Contracts & Data Foundations — Exit Evidence

| | |
|---|---|
| Commit SHA | base `b62f4eb` (Phase 0 commit) + uncommitted Phase 1a working tree |
| Date (UTC) | 2026-11-22 16:55 |
| Environment(s) | local (macOS arm64, Docker 29.4.3), Testcontainers (PostgreSQL 18.7, MongoDB 8.0.38, RabbitMQ 4.4.1) |
| Pipeline | pending: the first GitLab pipeline with the `contract` stage runs after commit + push |
| Verified by | Claude Code (Opus), with two Sonnet subagents writing the OpenAPI and AsyncAPI/event contracts, independently re-validated by `make contracts` |
| Resulting status | Slice 1a `INTEGRATION-VERIFIED`; Phase 1 overall `IN PROGRESS` (1b–1e pending) |

## Scope of this slice
PROJECT.md §11 Phase 1: **Workstream Contracts** (except Java records and the Java envelope suite, which move to 1c with `java-platform`) and **Workstream Data foundations**. The platform kits (1b–1d) and service skeletons (1e) are not part of this slice.

## Runtime Completion Gate (§11.0), applied to this slice
- [ ] 1. Source merged: no, the working tree is uncommitted. `make contracts`: validation clean and generation deterministic (two runs byte-identical). The drift gate flags `generated/` until it is committed, as intended.
- [x] 2. Clean-state startup: `make reset && make env && make up && make migrate` passes; re-running `make migrate` is a no-op.
- [x] 3. Real dependencies only: Testcontainers PostgreSQL 18, MongoDB 8, and RabbitMQ 4. No mocks.
- [x] 4. Async infrastructure: topology asserted; routing to the consumer and archive queues; the DLX fans in to both the DLQ and the registry queue; redeclaration drift rejected. (Consumer redelivery and outbox behavior belong to the kits in 1b–1d.)
- [x] 5. Security: cross-schema denial, DDL denial, read-only migration history, RLS fail-closed, read-only backup role, `svc_events` without `dbAdmin`, Mongo validator enforcement, Gitleaks clean (Phase 0).
- [ ] 6. Observability: n/a until the kits exist (1b–1d).

## Commands & output

### make contracts
```text
✓ topology: 6 exchanges, 58 queues, 71 bindings
✓ envelope: schema compiles; valid/invalid examples behave
✓ events: 38 payload schemas with valid examples; all topology keys covered
✓ asyncapi: document valid; every event has a channel and vice versa
✓ openapi: redocly clean; 115 §6.2 actions ↔ contract operations match
contracts: all checks passed
generate: 38 event types, 115 service actions, topology unions, python models
generation deterministic: identical output across runs
```
The generated TypeScript passes `tsc --noEmit` under the full strict base config, and all 42 generated Python modules import.

### Contract unit tests (TypeScript and Python)
```text
@aegispulse/contracts   Test Files 2 passed (2) · Tests 15 passed (15)
pytest (envelope)       9 passed in 0.10s
```

### Integration tests (`make test-integration`)
```text
packages/contracts  topology.integration   Tests 4 passed (4)    RabbitMQ 4.4.1
tests/migrations    postgres + mongo       Tests 25 passed (25)  PostgreSQL 18.7 + migrate image, MongoDB 8.0.38
```

### make migrate (local compose stack)
```text
aegis-migrate: migrate schema=ingestion|files|registry|cases|analytics  (V1 baseline, Success)
aegis-migrate: done
MIGRATED UP: 20261122000001-baseline.cjs
topology-assert: asserted 6 exchanges, 58 queues, 71 bindings
second run: no Flyway versions applied, no Mongo migration, topology re-asserted (idempotent)
```

### Grant / RLS probes (compose stack, run as each service role)
```text
svc_files reads schema version: 1 · svc_files delete flyway_schema_history → permission denied
RLS: own-tenant insert OK · other tenant sees rows=0 · cross-tenant insert → violates row-level security · no tenant context → rows=0
Mongo: invalid archive document rejected by validator · svc_events collMod → Unauthorized
```

## Issues found and fixed during the slice
- **Duplicate retry queue.** `doc.extraction.q`'s 5s/30s/30s plan produced two `.retry.30s` queues; caught by the topology invariant test. There is now one retry queue per distinct delay.
- **`aegispulse.dlx` must be a topic exchange**, so the registry can bind `#`. PROJECT.md §6.5 amended.
- **migrate-mongo `useFileHash: true` re-ran an edited migration.** Disabled: immutability is enforced by the guard hook and `ci/check-migrations.sh`, never by re-execution. The local `schema_meta` holds one extra entry from that run; this is harmless, and a fresh environment has one.
- **Supply chain.** pnpm 12 silently added a minimum-release-age bypass for `amqplib@2.4.1`, published hours earlier. I removed the bypass and pinned 2.4.0. Only `esbuild` is allowed to run install scripts.
- **Contract gaps found while writing the specs**, resolved in PROJECT.md: added `registry.listServiceAccounts` and `cases.getTransactionEvaluation`; defined the gateway SERVICE-token cases; made `issueClientCredentialsToken` unauthenticated; added `/v1/openapi.json`.
- **Validator regex bug.** It missed the column-aligned `scanner` action in §6.2. Fixed.

## Known gaps / follow-ups
- Java records and the Java envelope conformance suite (slice 1c).
- `datamodel-code-generator` cannot enforce the `https` pattern on URL fields in Pydantic, and numbers some class names. Address when py-platform consumes the models (1d).
- The only remaining contract gap is `getStream`, a gateway-local transport route with no backing action, by design.
- Commit and push, then the first GitLab pipeline (also still open from Phase 0).
