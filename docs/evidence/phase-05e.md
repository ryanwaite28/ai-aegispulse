# Phase 05 (slice 5e) — Orphan sweep, retention purge, delete — Exit Evidence

| | |
|---|---|
| Commit SHA | base `560e4e2` + uncommitted slice 5e |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers PostgreSQL 18.7, Redis 8.10.3 (files ACL), SeaweedFS 4.54; compose stack |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 5e `RUNTIME-VERIFIED` locally |

## Scope
Spec: [FR-FILE-01-13-files](../specs/FR-FILE-01-13-files.md) §2 "Sweeps, retention, delete". Migration `V5__file_maintenance`.

## Commands and results
```
services/files: test:integration → 19/19 (uploads 7, validation 4, lifecycle 5, maintenance 3):
  FR-FILE-10 orphan flood: 100 real inits (25 also PUT, never completed), backdated 2 h + 1 young init
             → sweepOrphans: 100 EXPIRED, 1 INITIATED; 100 file.status.changed (ORPHAN_TIMEOUT); objects under
               raw/{tenant}/: 25 → 0 (no leaks); sessions released, the young session kept; re-run no-op; user → 403
  FR-FILE-12 purge (retentionDays 30): PROCESSED+artifact (40 d) and QUARANTINED (45 d) → raw, quarantine and
             artifact objects deleted; tombstones purged+deleted, artifact rows 0; 10-day file kept; unknown tenant
             skipped; re-run processedCount 0; purged file → getFile 404
  FR-FILE-12 delete: ANALYST 403; TA → file:status + file:dlurl:* dropped; getFile/getDownloadUrl 404; list excludes;
             object retained; history DELETED by user:{id}; repeat 404
workers/scheduler-trigger: vitest → 4/4 (+ files jobs mapped and on the allowlist)
gateway: vitest → 17/17 · files unit 15/15
make lint (0) · make typecheck (0) · make check (0) · make test-unit (0)
```

### Compose stack (2026-11-24, run by Claude Code)
```
make migrate → files V5 file maintenance: Success
recreate config-render + objectstore (files artifacts write grant); rebuild + recreate files, gateway
make test-e2e → Test Files 5 passed · Tests 239 passed (twice in a row)
  files E2E: + ANALYST DELETE 403; TENANT_ADMIN DELETE 200 → GET 404 → DELETE again 404; role matrix + deleteFile
make trigger JOB=files-orphan-sweep      → job succeeded {processedCount 0}
make trigger JOB=files-retention         → job succeeded {processedCount 0}
make trigger JOB=ingestion-secret-expiry → job succeeded {processedCount 0}
```
`processedCount 0` on the stack is expected: the E2E uploads are minutes old, and every tenant keeps the default 400-day retention. The integration suite drives both paths with backdated rows.

### Amendment: `ops.audit.file_deleted` (owner-approved 2026-11-24)
```
make contracts → ✓ events: 42 payload schemas with valid examples · ✓ asyncapi valid · generate: 42 event types
gradle :java-platform:test :registry:test → 81 tests, 0 failures (event-type count follows the contracts)
files maintenance.integration → 3/3 (+ delete enqueues exactly one ops.audit.file_deleted {fileId, actorId} on
                                   aegispulse.intelligence)
compose: rebuild files → make test-e2e 239/239 → files.outbox_events ops.audit.file_deleted: SENT 1 (publisher confirm;
         routed by ops.audit.* to cases.audit-ingest.q, whose consumer arrives with the cases phase)
```

### Defect found during the slice
The first E2E run failed the 4b `+301 s` skew probe (202): it floored the host clock (up to 0.999 s of the 1 s margin), and request latency landed it inside ±300 s. The probes now round away from now; two clean runs since.

## Pending (at the time of this slice)
> Superseded: every item below was completed later in the phase; see [phase-05.md](phase-05.md) for what remains.

- 5b multipart (FR-FILE-13) and the Phase 5 exit (`scripts/demo/upload.ts`, EICAR evidence, orphan-sweep logs).
