# Phase 08c — Evaluations, case core, audit append (FR-TXN-05/06, FR-CASE-01/02/03/07, FR-AUD-01)

| | |
|---|---|
| Commit SHA | `a0298d9` + uncommitted 8c |
| Date (UTC) | 2026-11-25 |
| Verified by | Claude Code (Opus) |
| Result | INTEGRATION-VERIFIED; runtime: migrations applied, `/readyz`, E2E composition |

| Check | Result |
|---|---|
| `make contracts` | OK (additive `RecordRiskEvaluationInput.tenantStatus`) |
| `:cases:test` | BUILD SUCCESSFUL (CaseStateMachineTest: 36 pairs; AuditHashTest; ArchitectureTest, which caught adapters reading repository types, now fixed by domain records) |
| `:cases:integrationTest` | 6/6 `CasesIT` (see spec §Tests) |
| gateway unit | 22 passed |
| `make migrate` | `cases: V3 risk evaluations · V4 cases · V5 audit log — Success` → 12 runtimes `/readyz` (cases requires Flyway ≥ 5) |
| `make test-e2e` | Test Files 8 · **308 passed** (role matrix `getTransaction` × every role; transaction detail ACCEPTED/null; cross-tenant 404) |

Not yet: the saga that calls `recordRiskEvaluation` (8e), policy evaluation and enrichment timeouts (8f), and audit ingest/list/verify (8d).
