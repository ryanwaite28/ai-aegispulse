# Phase 08g — Analyst case work (FR-CASE-05..08)

| | |
|---|---|
| Commit SHA | `52c2203` + uncommitted 8g |
| Date (UTC) | 2026-11-25 |
| Verified by | Claude Code (Opus) |
| Result | RUNTIME-VERIFIED locally |

| Check | Result |
|---|---|
| `:cases:test` / `:cases:integrationTest` | BUILD SUCCESSFUL; `CasesIT` 13/13 |
| gateway unit | 24 passed |
| `make test-e2e` | 11 files · **367 passed**: `cases.e2e.test.ts`, a saga-opened ESCALATED case through find → detail → timeline (OPEN, ENRICHING, POLICY_EVALUATED, ESCALATED) → stale-assign 409 → assign → note 201 → NEEDS_REVIEW → four-eyes 409 → tenant admin resolves → viewer 403, other tenant 404; role matrix for the 7 case routes |

Test-only defect fixed: an older assertion ordered outbox rows by `event_id`. UUIDv7 ids created in the same millisecond are not strictly ordered, so it now compares the set of events.
