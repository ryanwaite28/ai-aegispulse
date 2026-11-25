# Spec — FR-TXN-05 / FR-TXN-06 / FR-CASE-01 / 02 / 03 / 07 / FR-AUD-01 — Evaluations, case core, audit append

| | |
|---|---|
| Phase | 08 — slice 8c (`PROJECT.md` §11) |
| Owner runtime(s) | `services/cases` (Java 25 / Spring Boot); gateway `TransactionsController` (GET) |
| Status | INTEGRATION-VERIFIED (Testcontainers) + runtime on the stack (migrations V3–V5, `/readyz`, E2E GET composition) |
| Related | §7.4 DDL, §1.4.4 bands, ADR-0004 (outbox), ADR-0016 (RLS) |

## Behavior
- **`cases.recordRiskEvaluation`** (SERVICE token with `cases.recordRiskEvaluation`, i.e. the saga):
  1. Under the tenant's RLS, idempotent by `(tenant, risk-eval:{eventId})`.
  2. When `score ≥ 70` and the tenant is ACTIVE, open a `TRANSACTION_RISK` case.
     - Its open key is `txn-risk:{transactionEventId}`.
     - Severity is HIGH, or CRITICAL from 85 up.
     - Its entities are the watchlist hits' entity ids.
  3. Attach `RISK_EVALUATION` evidence and one `WATCHLIST_HIT` per hit.
  4. Insert the evaluation, carrying `case_id`.
  5. Append audit `RISK_EVALUATION_RECORDED` (model version) and enqueue `risk.evaluation.recorded`. Everything commits in one transaction.
  - **Suppression:** when the saga reports a non-ACTIVE `tenantStatus` (an additive contract field: cases has no callees to read tenant status itself, §5.7.4), the evaluation is recorded with `suppressedReason = TENANT_SUSPENDED` and no case is opened (FR-TEN-02 "sagas skip case creation").
  - **Duplicates:** a repeat (redelivery, replay, concurrent duplicate) returns the stored evaluation with no new rows, audit entries or events.
- **`CaseService.open`:**
  - Idempotent by `(tenant, openIdempotencyKey)`.
  - The number `AP-{yyyy}-{n}` comes from `case_number_sequences` under a row lock, so numbers are gapless.
  - Steps: insert OPEN; transition row `open`; audit `CASE_OPENED`; `case.opened`; then the automatic OPEN → ENRICHING (`enrich:open`, SYSTEM) with `enrichment_deadline = now + 10 min`.
- **`CaseService.transition`:**
  - A transition key already applied is a no-op returning the current case (FR-CASE-07).
  - `CaseStateMachine` rejects anything outside FR-CASE-02 with `409 CASE_INVALID_TRANSITION`.
  - An optimistic `UPDATE … WHERE version = ?` gives version + 1. A lost race re-reads, up to 3×, then `409 CASE_CONFLICT`.
  - In the same transaction: the transition row, audit `CASE_TRANSITION` (before/after state), `case.transitioned`, and `case.escalated`/`case.resolved` when those states are reached.
- **`AuditService.append`** (FR-AUD-01), always inside the caller's tenant transaction:
  1. `pg_advisory_xact_lock(hashtextextended('cases.audit:'||tenant, 0))`.
  2. Read the chain head; `seq = last + 1`, `prev = last hash` (or 64 zeros).
  3. `hash = SHA-256(canonicalJSON(entry) ‖ prev)`, where the entry is every stored column except id/hash/created_at, with timestamps at microsecond precision and the JSON states parsed back.
  4. Insert, then upsert the head.
  - Canonical JSON follows RFC 8785 for this value space: sorted keys, minimal escapes, and numbers in the shortest exact decimal, so JSONB read-back hashes the same.
- **`cases.openCase`** (orchestrator): one tenant transaction around `open` (used by later sagas).
- **`cases.getTransactionEvaluation`** (gateway, user/integration token; roles INTEGRATION, VIEWER, ANALYST, TA, PA with `X-Aegis-Tenant`): the latest evaluation of the transaction in the tenant, else `404 NOT_FOUND`.
- **Gateway `GET /v1/transactions/{id}`** (FR-TXN-06): calls `ingestion.getTransaction`, then `cases.getTransactionEvaluation`.
  - `processingStatus` is ACCEPTED (cases 404), SCORED (evaluation without a case) or CASE_OPENED.
  - `FAILED` is not derivable from these two reads; it is left to the dead-letter registry view.

## Data & grants
- Migrations `V3__risk_evaluations.sql`, `V4__cases.sql` and `V5__audit_log.sql`, following §7.4. The numbers shift from the §11 plan because cases already had V1/V2. All tables use `FORCE ROW LEVEL SECURITY`.
- Grants for `svc_cases`, per §5.7.2:
  - no DELETE or TRUNCATE on any cases table;
  - no UPDATE on `case_transitions`, `policy_evaluations`, `case_evidence` and `case_dispositions`;
  - `audit_log` is SELECT/INSERT only, and triggers reject UPDATE/DELETE/TRUNCATE for every role.
- `/readyz` requires Flyway ≥ 5.

## Layer placement
| Piece | File |
|---|---|
| Domain | `cases/domain/{CaseStateMachine,CaseStatus,CaseNumbers,AuditHash,AccessPolicy,CaseRecord,RiskEvaluation}.java` |
| Services | `cases/service/{RiskEvaluationService,CaseService,CaseOpening,AuditService,CaseEvents,Actor,Commands}.java` |
| Repositories | `cases/db/{RiskEvaluationRepository,CaseRepository,AuditRepository}.java` |
| HTTP adapter | `cases/adapters/http/CasesController.java` |
| Gateway | `clients/cases.client.ts`, `modules/transactions/transactions.controller.ts` (`CASES_URL`, default `http://cases:8085`) |

## Tests
| Level | Test | Proves |
|---|---|---|
| Unit | `CaseStateMachineTest` | all 36 from × to pairs; case number format |
| Unit | `AuditHashTest` | canonical JSON (key order, escapes, number normalization); chain sensitivity |
| Unit | `ArchitectureTest` | adapters only call services (domain records, not repository types) |
| Integration | `CasesIT` (6, PostgreSQL 18 as svc_cases + RabbitMQ) | case opened ENRICHING v1 with `AP-yyyy-000001`, transitions `open`/`enrich:open`, 2 evidence rows, 3 audit entries with a recomputed valid chain, 3 outbox events in order; 5 concurrent + 1 repeat → 1 evaluation/1 case/3 audit/3 events; score 65 → no case, SUSPENDED → suppressed; invalid transition 409, duplicate key no-op; tenant/role scope of getTransactionEvaluation (viewer 200, other tenant 404, auditor 403, PA with header 200, saga 403, user cannot record); audit UPDATE/DELETE denied for svc_cases, and superuser UPDATE/TRUNCATE hit the append-only trigger |
| Gateway unit | `files.test.ts` "transaction detail over the gateway" | CASE_OPENED composition; ACCEPTED on cases 404; local 404 |
| E2E | `transactions.e2e.test.ts`, role matrix `getTransaction` | submission read back with ACCEPTED/null; cross-tenant 404 |
