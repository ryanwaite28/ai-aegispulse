# Spec — FR-TXN-03 (+ FR-TEN-08 propagation) — ScoreTransactionSaga

| | |
|---|---|
| Phase | 08 — slice 8e (`PROJECT.md` §11) |
| Owner runtime(s) | `services/orchestrator` (saga), callees registry, risk-scoring, cases |
| Status | RUNTIME-VERIFIED locally (compose E2E + outage drill) |
| Personas | Priya (one queue of explainable cases); Dev (submit and poll); Sam (outages lose nothing) |

## Requirement (verbatim)
> **FR-TXN-03**: The `ScoreTransactionSaga` (orchestrator) consumes `txn.submitted`: (1) `checkWatchlists` for the counterparty, (2) `scoreTransaction` on Risk Scoring (2 s timeout, circuit breaker), (3) `recordRiskEvaluation` on Cases with `idempotencyKey = risk-eval:{eventId}`. Any step failure → retry tiers (§6.5); exhausted → DLQ. Saga steps are individually idempotent; no saga state is persisted.

## Behavior
- **Consumer:** `orchestrator.txn.q` uses the kit's `consumeEnvelopes`, then `ScoreTransactionSaga.run`.
- **Steps**, each through a typed `InternalServiceClient` carrying the orchestrator's SERVICE token (`svc-orchestrator` act[], §5.7.4):
  1. Tenant settings: `registry.getTenantSettings` via the kit's `TenantSettingsCache` (TTL ≤ 60 s, FR-TEN-08). Clarification: this step precedes the watchlist check because scoring needs the settings, and cases needs the status for suppression.
  2. `registry.checkWatchlists` with `counterpartyRefs: [{counterpartyId, counterpartyName}]` (1 s timeout).
  3. `riskScoring.score` with the transaction, `watchlistHit`, `metadata` (demo scenario) and `tenantSettings` (2 s timeout, kit circuit breaker).
  4. `cases.recordRiskEvaluation` with `idempotencyKey risk-eval:{eventId}`, the hits (counterparty filled in) and `tenantStatus` (3 s timeout).
- **Failure classes** (kit `HttpClient`): timeouts, connection errors, 5xx, 408/429 and an open breaker are TransientError → 1 s / 5 s / 30 s retries → DLQ. Other 4xx are PermanentError → DLQ. A wrong event type, a missing tenant or a missing payload field is PoisonMessageError → DLQ.
- **Idempotency without saga state:** a redelivery re-runs the steps. Scoring returns the first delivery's features (FR-TXN-04), and cases returns the stored evaluation (FR-TXN-05), so one evaluation and at most one case per transaction.
- **Config:** compose sets `SERVICE_CLIENT_ID svc-orchestrator`, `SERVICE_CLIENT_SECRET` (`SERVICE_CLIENT_SECRET_ORCHESTRATOR`, reconciled by the registry, ADR-0017), `REGISTRY_URL`, `JWT_*`, `RISK_SCORING_URL` (default `http://risk-scoring:8086`) and `CASES_URL`.

## Layer placement
| Piece | File |
|---|---|
| Saga (service) | `services/orchestrator/src/service/orchestrators/score-transaction.saga.ts` (ports interface) |
| Typed clients | `services/orchestrator/src/clients/saga-clients.ts` |
| Consumer adapter | `services/orchestrator/src/adapters/amqp/txn.consumer.ts` |
| Wiring | `services/orchestrator/src/main.ts`, `src/config.ts` |

## Tests
| Level | Test | Proves |
|---|---|---|
| Unit | `score-transaction.saga.test.ts` (4) | step order and contract payloads; suspended status passed through; poison inputs; a transient failure stops before recording |
| E2E | `tests/e2e/saga.e2e.test.ts` "three transactions score 65 … the fourth opens a TRANSACTION_RISK case" | the real path over the broker. Factors amount 40 / geo 15 / new counterparty 10 / velocity 5 → 70 HIGH → `CASE_OPENED` with a case id |
| E2E | `saga.e2e.test.ts` "a tenant settings change reaches scoring within 60 s" (FR-TEN-08, moved from Phase 2) | after `PATCH /v1/tenants/{id}` `highRiskCountries: [BR]`, a BR transaction gets geo 15 within ≤ 65 s |
| Runtime | outage drill (`docs/evidence/phase-08e.md`) | risk-scoring stopped → retries 1 s/5 s/30 s → DLQ after 36 s (`DEPENDENCY_UNAVAILABLE`) → transaction stays ACCEPTED → restart → replay → SCORED with one evaluation |
