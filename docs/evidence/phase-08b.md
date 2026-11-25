# Phase 08b — Risk scoring (FR-TXN-04)

| | |
|---|---|
| Commit SHA | `6eba0c6` + uncommitted 8b |
| Date (UTC) | 2026-11-25 |
| Verified by | Claude Code (Opus) |
| Result | INTEGRATION-VERIFIED; on the stack: `/readyz` ready (redis up), unauthenticated score → 401 §8.2 envelope |

| Check | Result |
|---|---|
| `make contracts` | OK; Python OpenAPI models generated (`aegis_contracts.openapi.risk_scoring` etc.) |
| risk-scoring unit | 20 passed (factor table, route auth, idempotent redelivery) |
| py-platform unit | 41 passed, incl. `test_web.py` (§8.2 envelopes) |
| risk-scoring integration (Redis 8 + compose ACL) | 3 passed. The first run found that wall-clock window trimming erased backdated history; it now trims relative to `occurredAt` |
| Stack | rebuilt `risk-scoring`; compose-wait: 12 runtimes `/readyz`; `POST /internal/v1/score` with a bad token → `401 UNAUTHORIZED` before any body validation |

Not yet verified at runtime: a scored call from the orchestrator with a real SERVICE token, which arrives with the saga in 8e.
