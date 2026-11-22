# Spec — FR-XXX-NN[ / FR-XXX-NN] — <Title>

| | |
|---|---|
| Phase | NN — <phase name> (`PROJECT.md` §11) |
| Owner runtime(s) | `services/<svc>` (+ gateway handler, consumer adapter) |
| Status | PENDING · SCAFFOLDED · SOURCE-IMPLEMENTED · MIGRATION-ADDED · UNIT-VERIFIED · INTEGRATION-VERIFIED · RUNTIME-VERIFIED |
| Related NFRs | NFR-… |
| Related ADRs | ADR-… |

## 1. Requirement (verbatim from PROJECT.md §2)
> paste the FR bullet(s)

## 2. Behavior
- Happy path, step by step (service-layer use case).
- Alternate and forbidden paths: validation, authz (role × tenant), duplicates and idempotency, state conflicts, dependency failure.

## 3. Data & migrations
- Tables, columns, and indexes touched (`PROJECT.md` §7). New migration file name(s): `V{n}__….sql`.
- RLS and grants impact.

## 4. Contracts
- Internal action(s) (`PROJECT.md` §6.2) and the OpenAPI operationId.
- Public route(s) (`PROJECT.md` §8.3) and error codes (§8.4).
- Events emitted or consumed (§6.7), with schema file paths in `packages/contracts/events/`.

## 5. Layer placement
| Piece | File |
|---|---|
| Domain (pure) | |
| Service / use case | |
| Repository | |
| Internal route adapter | |
| Consumer adapter | |
| Gateway handler + client | |

## 6. Security & observability
- Authz rule, input limits, secrets and PII handling.
- Logs (fields), spans, metrics (names from NFR-07).

## 7. Test plan
| Level | Test name (includes FR id) | Proves |
|---|---|---|
| Unit | | |
| Integration (Testcontainers) | | |
| E2E / runtime | | |

## 8. Acceptance (runtime evidence required)
- [ ] …commands and expected outputs to paste into `docs/evidence/phase-NN.md`
