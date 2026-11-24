# Phase 05 (slice 5a) — Upload init, dedup, quotas, complete/abort — Exit Evidence

| | |
|---|---|
| Commit SHA | base `54d6359` + uncommitted slice 5a working tree |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers PostgreSQL 18.7 (svc_files, RLS), Redis 8.10.3 (files ACL), SeaweedFS 4.54 (files identity) |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 5a `RUNTIME-VERIFIED` locally (integration + E2E 213/213) |

## Scope
Spec: [FR-FILE-01-13-files](../specs/FR-FILE-01-13-files.md) §2 initUpload / completeUpload / abortUpload / Gateway. Migration `V3__files`.

## Commands and results
```
services/files: vitest (unit) → 7/7   (key shape, filename rule + sanitizer, allowlist, size bound, transitions; config)
services/files: test:integration → 7/7 (real PG as svc_files, Redis ACL user files, SeaweedFS files identity):
  FR-FILE-01/04 init → presigned PUT: wrong Content-Type → 403, correct → 200 → complete → UPLOADED,
                file.uploaded + file.status.changed in the outbox, session deleted, double complete idempotent,
                history actors integration:int-feed
  FR-FILE-04    no PUT → 409 UPLOAD_NOT_FOUND_IN_STORAGE; short body via URL → 403 (signed length);
                direct short object → 409 UPLOAD_SIZE_MISMATCH; 5 concurrent completes → one transition, 2 events
  FR-FILE-02    second init → 200 same id, no URL; Redis pointer lost → DB finds it; other tenant → new file;
                allowDuplicate ANALYST+ only (INTEGRATION → 403); abort releases the pointer
  FR-FILE-03    66 concurrent inits → ≥ 1 × 429, accepted ≤ 60 + elapsed s; per-tenant bucket; 10 GiB → 413;
                suspended → 403
  FR-FILE-01    zip → 422 FILE_TYPE_NOT_ALLOWED; 64 MiB + 1 → 413; "..\0passwd" stored as "passwd", key = ids only;
                PA without X-Aegis-Tenant → 403, with it → 201; VIEWER → 403
  FR-FILE-04    other INTEGRATION → 403; other tenant → 404; abort deletes the landed object; aborted stays EXPIRED
  NFR-02        Idempotency-Key replay returns the same file; different body → 409 IDEMPOTENCY_KEY_REUSED
ts-platform unit 62/62 (+ tenantAccess 3) · gateway 16/16 (+ files routes 2)
docker build files image → check-layer-sizes OK
make lint (0) · make typecheck (0) · make check (0) · make test-unit (0)
```

### Defects found and fixed during the slice
- The files Redis ACL user may not run `TIME` in scripts, nor `MULTI`/`EXEC`. The token bucket now takes the caller's clock, and the session write is a single script (atomic). The ACL was not widened.

### Compose stack (2026-11-24, run by Claude Code)
```
make migrate → files V3 files: Success
compose build + recreate files, gateway → files /readyz ready (schema up, clamav up)
make test-e2e → Test Files 5 passed (5) · Tests 213 passed (213)
  e2e/files (3): ANALYST init 201 → PUT to http://localhost:9000 presigned URL → complete UPLOADED → same content 200 dedup;
                 INTEGRATION complete without PUT → 409, tenant B abort → 404, abort → EXPIRED;
                 zip 422, ../../etc/passwd 422, 64 MiB+1 413, PA with X-Aegis-Tenant 201 / without 403
  role matrix: + initUpload, completeUpload, abortUpload × 6 roles
```

## Pending (at the time of this slice)
> Superseded: every item below was completed later in the phase; see [phase-05.md](phase-05.md) for what remains.

- Slices 5c, 5d, 5e, 5b.
