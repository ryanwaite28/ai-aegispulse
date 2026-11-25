# Spec — FR-AUD-01 / FR-AUD-02 / FR-AUD-03 — Immutable audit log: append, ingest, list, verify

| | |
|---|---|
| Phase | 08 — slices 8c (append) + 8d (ingest, list, verify) (`PROJECT.md` §11) |
| Owner runtime(s) | `services/cases`; gateway `AuditController`; `workers/scheduler-trigger` job `cases-audit-verify` |
| Status | RUNTIME-VERIFIED locally (Testcontainers + compose E2E + nightly job run) |
| Personas | Elena (COMPLIANCE_AUDITOR): prove who did what, when and why; Marcus (TENANT_ADMIN) reads the trail |

## Behavior
- **Append (8c):** see `FR-TXN-05-CASE-01-03-cases-core.md`. A per-tenant chain under an advisory lock; `hash = SHA-256(canonicalJSON(entry) ‖ prevHash)`.
- **Ingest (FR-AUD-02)**, consumer `cases.audit-ingest.q`, bound to `registry.#`, `classification.overridden`, `ops.audit.*` and `ops.replay.*`:
  - `AuditSubjects` maps each event:
    - action = the event type in upper snake case (e.g. `REGISTRY_USER_CHANGED`);
    - subject = per family: USER, TENANT, SERVICE_ACCOUNT, WATCHLIST, ENTITY, EVENT, FILE, DEAD_LETTER, WEBHOOK_SOURCE, REPLAY_JOB;
    - actor = `USER` with payload `actorId`, otherwise `SERVICE` with the producing runtime.
  - `after` = the payload, which producers keep free of secrets and bodies (§6.7); `sourceEventId` = the envelope eventId.
  - Idempotent: the source event is checked **under the chain lock**, and the unique index `(tenant, source_event_id)` backs that up.
  - Tenantless (platform) events chain under the reserved platform tenant.
  - Events outside the mapping are logged and acked, not dead-lettered.
- **List** (`listAuditEntries`; COMPLIANCE_AUDITOR or TENANT_ADMIN, PA with `X-Aegis-Tenant` per the §6.2 rule):
  - filters `subjectType`, `subjectId`, `actorId`, `action`, `from`/`to`;
  - newest first, keyset cursor on `seq`, `limit` ≤ 100 (default 50).
- **Verify** (`verifyAuditChain`):
  - A COMPLIANCE_AUDITOR verifies the own tenant over `[fromSeq, toSeq]`, defaulting to the whole chain.
  - In chunks of 1,000, it checks seq continuity, the `prevHash` link (from the row before `fromSeq`, or 64 zeros) and the recomputed hash.
  - Returns `{valid, checked, firstBrokenSeq?, code: AUDIT_CHAIN_BROKEN}` with HTTP 200, never as an error.
  - SERVICE callers may name `tenantId`.
- **Nightly job** (`cases-audit-verify`, a SERVICE call without `tenantId`), modelled on the FR-AUD-03 "last 24 h" rule:
  - Every chain with unverified entries comes from the SECURITY DEFINER `cases.audit_chains_to_verify()` (V6, owner `cases_platform`, ADR-0016) and is verified from `verified_seq + 1`.
  - A valid chain advances `verified_seq`.
  - A broken one emits `notification.requested` **N-06** (CRITICAL, key `N-06:{tenant}:{seq}`) and stays unverified, so it fails again until resolved.
  - `vars.tenantSlug` carries the tenant id: cases does not hold slugs.
  - The job's summary is `processedCount = checked`, plus `valid`.

## Data
`V6__audit_verification.sql` adds `cases.audit_chains_to_verify()` and grants `cases_platform` SELECT on `audit_chain_heads`. Cases `/readyz` requires Flyway ≥ 6.

## Tests
| Level | Test | Proves |
|---|---|---|
| Integration | `CasesIT.auditIngestChainsOtherServicesEventsOnceEachIncludingPlatformEvents_FR_AUD_02` | events from the real broker are chained once each (a redelivered duplicate is ignored); SERVICE vs USER actor; valid chain; platform-tenant chain for a tenantless event |
| Integration | `CasesIT.listAndVerifyOverHttpDetectTamperingAndTheNightlyJobRaisesN06_FR_AUD_03` | paging and filters; ANALYST 403, TENANT_ADMIN verify 403; valid then **tampered via superuser (trigger disabled) → `firstBrokenSeq` 2**; partial range after the break is valid; nightly run → N-06 in the outbox, `verified_seq` stays 0; a healthy tenant advances |
| Integration | `CasesIT.auditLogRejectsUpdateDeleteForTheRoleAndTheTrigger_FR_AUD_01` | svc_cases UPDATE/DELETE denied; superuser UPDATE/TRUNCATE hit the trigger |
| Gateway unit | `files.test.ts` "audit routes" | PA 403 at the gateway; forwarding; integer seq validation |
| Worker unit | `jobs.test.ts` | `cases.verifyAuditChain` is on svc-scheduler-trigger's allowlist |
| E2E | `tests/e2e/audit.e2e.test.ts`, role matrix | registry user events of the E2E world appear as `REGISTRY_USER_CHANGED` / USER, newest first; chain valid; 422 on a bad seq; tenants see disjoint chains |
| Runtime | `make trigger JOB=cases-audit-verify` | `processedCount 1014, valid true` on the local stack |
