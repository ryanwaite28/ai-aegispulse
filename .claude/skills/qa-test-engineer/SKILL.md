---
name: qa-test-engineer
description: AegisPulse QA/test-engineering role. Use when planning or writing unit, integration (Testcontainers), contract, E2E, security, load (k6), chaos, accessibility, or Playwright tests; when defining FR acceptance criteria; or when collecting phase-exit evidence and deciding verification status.
---

# QA / Test Engineer — AegisPulse

Source of truth: `PROJECT.md` §14 (testing plan), §11.0 (completion gate), each FR in §2 (acceptance), `docs/steering/quality.md`.

## Test pyramid per FR
| Level | Location | Tools | Must cover |
|---|---|---|---|
| Unit | next to the code | Vitest / JUnit + jqwik / pytest + hypothesis | domain rules (table + property tests), service logic with fake ports, error mapping |
| Integration | `services/{svc}/tests/integration/` | Testcontainers (PG18, Mongo8, Redis8, RabbitMQ4, object store, ClamAV) | repositories, RLS, grants, outbox relay, consumers (redelivery, retry, DLQ), internal routes |
| Contract | `tests/contract/` | schema conformance, OpenAPI/AsyncAPI validation | every request, response, and event matches `packages/contracts` |
| E2E | `tests/e2e/` | Vitest + undici against compose, dev (full), or prod (smoke subset) | FR journeys through the gateway and broker |
| Security | `tests/security/` | Vitest, shell | adversarial webhooks, cross-tenant, SSRF, netpol |
| Load / chaos | `tests/load/`, `tests/chaos/` | k6, scripts | NFR-01 latency, NFR-02/10 zero loss and zero duplicates |
| UI | `apps/console/tests/` | Playwright + axe-core | FR-FE flows, a11y |

## Naming & traceability
- Every test that proves acceptance includes the FR id: `test('FR-CASE-07 concurrent transitions produce one audit entry')`.
- `make test-report` (Phase 1+) lists FR ids with no test, and CI warns on gaps.

## Standard cases to always include
1. Happy path.
2. Validation (each constraint in the FR → 422 with `details`).
3. AuthZ matrix (each role in §1.4.6) and cross-tenant → 404.
4. Idempotency: same key and body → same result; same key with a different body → 409.
5. Redelivery ×3 and replay generation → single effect.
6. Dependency failure: timeout or 5xx → retry → DLQ; circuit open → degradation per NFR-10.
7. State conflicts: optimistic lock and invalid transitions.
8. Limits: max sizes, rate limits, pagination bounds.

## Determinism
Inject clocks and id generators. Seed the generators (`--seed 20261122`). No sleeps: poll with timeouts (`waitFor(condition, 10s)`). Synthetic PII lives under `tests/fixtures/secrets-synthetic/` only.

## Status discipline
- Unit green → at most `UNIT-VERIFIED`. Testcontainers green → `INTEGRATION-VERIFIED`. Compose **and** dev runtime, plus a prod smoke test after promotion, with evidence → `RUNTIME-VERIFIED`. Chaos, load, and destructive tests target dev only.
- Evidence: real commands and output in `docs/evidence/phase-NN.md` (`/phase-exit-evidence`). A flaky test is a failing test. Fix it or quarantine it with an issue, and never "retry until green" in evidence.
