# Spec — FR-CASE-04 (+ FR-CASE-02 timers) — Policy evaluation, enrichment timeouts, auto-resolve

| | |
|---|---|
| Phase | 08 — slice 8f (`PROJECT.md` §11) |
| Owner runtime(s) | `services/cases`; `workers/scheduler-trigger` jobs `cases-enrichment-timeouts` (*/5) and `cases-auto-resolve` (daily) |
| Status | RUNTIME-VERIFIED locally |
| Personas | Priya (cases arrive already triaged, with factors); Sam (timers recover stuck cases without database surgery) |

## Behavior
- **`PolicyV1`** (domain, pure, §1.4.5):
  - Base: the risk score for TRANSACTION_RISK, 50 for DOCUMENT_RISK, otherwise 0.
  - Plus min(30, 15 × HIGH correlated evidence); plus 25 if any CRITICAL; plus 20 for a watchlist hit not already in the base (a TRANSACTION_RISK risk score already carries the §1.4.4 watchlist factor); plus min(30, 10 × red-flag clauses). Capped at 100.
  - Outcome ESCALATED at ≥ 75, else CLEARED; severity = band(score).
- **`PolicyEvaluationService.evaluate`**, on an ENRICHING case inside its tenant transaction:
  1. Read the evidence facts (`RISK_EVALUATION` summary score; `EVENT` HIGH/CRITICAL counts; `WATCHLIST_HIT`; `EXTRACTION` `redFlags`).
  2. Insert `policy_evaluations` revision n, with the factor breakdown.
  3. ENRICHING → POLICY_EVALUATED (`policy:n`), writing policy score, version and severity.
  4. → ESCALATED | CLEARED (`outcome:n`).
  5. An escalation with severity ≥ HIGH emits `correlation.requested` (≤ 50 entities, lookback 30 d); CRITICAL also emits `notification.requested` N-01 (key `case-escalated:{caseId}:{n}`).
  - A case that is no longer ENRICHING is returned as is (concurrent or duplicate triggers add nothing).
- **When it runs:**
  - **At open for TRANSACTION_RISK.** Clarification: the enrichment of such a case is its risk evaluation and watchlist-hit evidence, attached in the opening transaction, so enrichment is complete at open (FR-CASE-02 "enrichment complete"). Correlation (FR-COR-01, Phase 14) runs after escalation and re-evaluates through `attachEvidence`.
  - **On timeout.** `runEnrichmentTimeouts` (SERVICE, every 5 min) evaluates ENRICHING cases whose `enrichment_deadline` (open + 10 min) has passed. They are found by the V7 SECURITY DEFINER `cases.enrichment_overdue(limit)`, in batches of 500, one tenant transaction each, trigger type TIMER.
  - The delayed self-message on `cases.enrichment-timer.q` is **carried to Phase 14**: it needs an event type that is not in the §6.7 catalog. Until then the sweep bounds the timeout at ≤ 15 min.
- **`autoResolveCleared`** (SERVICE, daily): CLEARED cases with no change and no new evidence for 7 days → RESOLVED (`auto-resolve:v{version}`, TIMER). They are found by V7 `cases.cleared_without_new_evidence(days, limit)`.

## Data
- `V7__case_sweeps.sql`: the two finders, owned by `cases_platform`, which is granted SELECT on cases and case_evidence. `/readyz` requires Flyway ≥ 7.
- **Fault isolation** (review fix, 2026-11-26): each case runs in its own transaction inside a try/catch. A failing case is logged (tenant id, case id, error type only) and counted in an additive `failedCount` on `JobRunSummary`; the sweep continues with the rest. The scheduler exits non-zero when `failedCount > 0`, so CronJob alerting fires.
- `V8__cases_previous_case_index.sql`: index on `cases.previous_case_id` (FK without a leading index). `/readyz` requires Flyway ≥ 8.
- `CaseRepository.updateStatus` writes policy score, version and severity together with the status change, inside the same optimistic-locked update.

## Tests
| Level | Test | Proves |
|---|---|---|
| Unit | `PolicyV1Test` (11 factor combinations + invariants across about 26,000 inputs) | caps, watchlist-in-base rule, bands, threshold; score ∈ [0, 100]; outcome ⇔ score ≥ 75; more evidence never lowers the score |
| Integration | `CasesIT` (9) | score 82 → transitions `open, enrich:open, policy:1, outcome:1`, ESCALATED HIGH v3, policy row, `case.escalated` + `correlation.requested`; score 90 → CRITICAL + N-01 (8 outbox events, 5 audit entries, idempotent under 6 deliveries); 72 → CLEARED HIGH, no correlation; DOCUMENT_RISK opened without enrichment stays ENRICHING until its deadline, then the sweep → CLEARED MEDIUM 50 with trigger TIMER; backdated CLEARED → auto-resolved RESOLVED, a recent one untouched; non-scheduler 403 |
| E2E | full suite 324/324 | the saga path still ends in `CASE_OPENED` with the policy run |
| Runtime | `make trigger` | `cases-enrichment-timeouts` processedCount 1 (a pre-8f case) · `cases-auto-resolve` 0 · `cases-audit-verify` 320 valid |
