# Spec — FR-CASE-05 / 06 / 07 / 08 — Analyst case work

| | |
|---|---|
| Phase | 08 — slice 8g (`PROJECT.md` §11) |
| Owner runtime(s) | `services/cases` (`CaseWorkService`); gateway `/v1/cases*` |
| Status | RUNTIME-VERIFIED locally |
| Personas | Priya: find, understand, act, decide defensibly. Marcus: second reviewer. Elena: every action is audited |

## Behavior
- **Reads** (VIEWER, ANALYST, TA; PA with `X-Aegis-Tenant`):
  - `listCases` filters by status, type, severity, assignee and entity (`primary_entity_ids @>`); newest first, keyset `(created_at, id)`, limit ≤ 100.
  - `getCase` returns the case plus `latestPolicyEvaluation` with its factor breakdown, as `[{name, value, contribution}]`.
  - `getCaseTimeline` returns transitions, evidence, notes and dispositions.
  - Another tenant's case is `404 CASE_NOT_FOUND`.
- **Writes** (ANALYST, TA, PA; people only). Each runs in one tenant transaction with its audit entry (actor USER, `actingAs PLATFORM_ADMIN` when applicable):
  - `assignCase`: `expectedVersion` must match, else `409 CASE_CONFLICT`. Version + 1; audit `CASE_ASSIGNED`.
  - `addCaseNote`: 1–4,000 characters; `locked_at = created + 15 min`. There is no edit action, so notes are immutable. Audit `CASE_NOTE_ADDED` records the note id and length, not the text.
  - `recordDisposition`: rationale ≥ 20 characters; only on ESCALATED or CLEARED (else `409 CASE_INVALID_TRANSITION`).
    - `NEEDS_REVIEW` keeps the status and sets `pending_disposition` and `pending_reviewer_id`.
    - TRUE_POSITIVE / FALSE_POSITIVE clear the pending flag and resolve the case (`disposition:{id}`, which emits `case.resolved`). The analyst who recorded NEEDS_REVIEW gets `409 CASE_FOUR_EYES_REQUIRED`.
    - Records the model versions of the case's risk evaluations and the policy versions of its policy evaluations, and emits `case.disposition.recorded`.
    - Idempotent by `Idempotency-Key`, or else by a key derived from case + analyst + disposition + rationale.
  - `requestReevaluation`: ESCALATED/CLEARED → ENRICHING (`reeval:{Idempotency-Key | actor:version}`), then the policy runs immediately (this phase has no async enrichment source). Audit `CASE_REEVALUATION_REQUESTED` carries the reason.
- **`attachEvidence`** (SERVICE; sagas from Phase 14):
  - Idempotent per (case, type, ref); each new item emits `case.evidence.attached`.
  - New evidence on ESCALATED/CLEARED re-runs the policy (`evidence:v{n}` → ENRICHING → policy).
  - On RESOLVED it opens a `CORRELATED` case (`previousCaseId`, open key `correlated:{caseId}:{type}:{ref}`) holding the evidence, and evaluates it.
- **Concurrency (FR-CASE-07):** every status change goes through the optimistic, keyed `transition`. When two final dispositions race, one commits and the other's transaction rolls back entirely (409), so there is no duplicate disposition, transition or audit entry.

## Layer placement
| Piece | File |
|---|---|
| Domain read models | `cases/domain/CaseWork.java` |
| Service | `cases/service/CaseWorkService.java`; events `CaseEvents.dispositionRecorded/evidenceAttached` |
| Repository | `cases/db/CaseWorkRepository.java` (+ `CaseRepository.pendingReviewer`) |
| HTTP adapter | `cases/adapters/http/CaseWorkController.java` |
| Gateway | `gateway/nest-http/src/modules/cases/cases.controller.ts` |

## Tests
| Level | Test | Proves |
|---|---|---|
| Integration | `CasesIT.listGetTimelineAssignAndNotesAreTenantScopedAndVersioned…` | filters and paging, detail factors, a 4-transition timeline, cross-tenant 404, stale-version 409, viewer 403, 15-min lock, 4,001 chars → 422, auditor 403 |
| Integration | `CasesIT.dispositionsEnforceFourEyesAreIdempotentAndResolve_FR_CASE_06` | 422 short rationale; NEEDS_REVIEW keeps ESCALATED; same analyst 409; second analyst → RESOLVED with model/rule versions; repeat → same disposition; events counted |
| Integration | `CasesIT.concurrentFinalDispositionsOneWinsNoDuplicateAudit_FR_CASE_07` | 201 + 409; one disposition, one audit entry, one RESOLVED transition |
| Integration | `CasesIT.reevaluationAndEvidenceRerunPolicyAndResolvedCasesSpawnCorrelated_FR_CASE_08` | manual re-evaluation → policy revision 2; CRITICAL evidence on CLEARED 72 → ESCALATED CRITICAL 97; duplicate attach is a no-op; evidence on RESOLVED → CORRELATED with previousCaseId; non-saga 403 |
| Gateway unit | `files.test.ts` "case routes" | forwarding, status codes, Idempotency-Key, local 404 |
| E2E | `tests/e2e/cases.e2e.test.ts` + role matrix (7 routes × every role) | the full analyst loop on a saga-opened case, through the gateway |
