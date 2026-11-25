# Phase 08f — Policy evaluation and case sweeps (FR-CASE-04, FR-CASE-02 timers)

| | |
|---|---|
| Commit SHA | `e55bff4` + uncommitted 8f |
| Date (UTC) | 2026-11-25 |
| Verified by | Claude Code (Opus) |
| Result | RUNTIME-VERIFIED locally |

| Check | Result |
|---|---|
| `:cases:test` | BUILD SUCCESSFUL (PolicyV1Test: factor table + invariants; state machine; audit hash; ArchUnit) |
| `:cases:integrationTest` | `CasesIT` 9/9 |
| scheduler-trigger unit | 4 passed (allowlist covers the new actions) |
| `make migrate` | `cases: V7 case sweeps — Success`; 12 runtimes `/readyz` |
| `make test-e2e` | 10 files · **324 passed** |
| `make trigger JOB=cases-enrichment-timeouts` | `processedCount 1`: a case opened before 8f, ENRICHING past its deadline, got its policy evaluation |
| `make trigger JOB=cases-auto-resolve` | `processedCount 0`: nothing CLEARED for 7 days yet |
| `make trigger JOB=cases-audit-verify` | `processedCount 320, valid true`: the new transitions chain correctly |
| DLQs | all empty |

Defect caught while testing: the sweep routes were missing (an edit that silently did not apply against the formatted source); the integration test caught it as a 404 / `NoResourceFoundException`.

Carry-over: the delayed self-message on `cases.enrichment-timer.q` moves to Phase 14 (needs a catalog event type); the */5 sweep covers the timeout meanwhile.
