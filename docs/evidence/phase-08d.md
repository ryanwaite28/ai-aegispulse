# Phase 08d — Audit ingest, list, verify (FR-AUD-02, FR-AUD-03)

| | |
|---|---|
| Commit SHA | `4871632` + uncommitted 8d |
| Date (UTC) | 2026-11-25 |
| Verified by | Claude Code (Opus) |
| Result | RUNTIME-VERIFIED locally |

| Check | Result |
|---|---|
| `:cases:test` / `:cases:integrationTest` | BUILD SUCCESSFUL; `CasesIT` 8/8, including the tamper detection (`firstBrokenSeq` 2) and nightly N-06 |
| gateway unit | 23 passed |
| scheduler-trigger unit | 4 passed (allowlist covers `cases.verifyAuditChain`) |
| `make migrate` | `cases: V6 audit verification — Success` → 12 runtimes `/readyz` |
| `make test-e2e` | Test Files 9 · **322 passed** (audit E2E + role matrix `listAuditEntries`/`verifyAuditChain` × every role) |
| `make trigger JOB=cases-audit-verify` | `job succeeded`, summary `{"processedCount":1014,"valid":true}` |

Defect found while testing: the nightly path's tenant-transaction helper rejected the `null` its void steps returned (an NPE caught by the integration test as a 500). It now has a void variant.
