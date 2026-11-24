# Phase 05 (slice 5d) — Processing lifecycle, reads and downloads — Exit Evidence

| | |
|---|---|
| Commit SHA | base `0fde521` + uncommitted slices 5c + 5d |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers PostgreSQL 18.7, Redis 8.10.3 (files ACL), SeaweedFS 4.54; compose stack (real clamd) |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 5d `RUNTIME-VERIFIED` locally |

## Scope
Spec: [FR-FILE-01-13-files](../specs/FR-FILE-01-13-files.md) §2 "Processing lifecycle" and "Reads and downloads". Migration `V4__file_artifacts`.

## Commands and results
```
services/files: vitest (unit) → 15/15 (+ attachmentDisposition)
services/files: test:integration → 16/16 (uploads 7, validation 4, lifecycle 5):
  FR-FILE-06 VALIDATED → PROCESSING (extractor_version) → PROCESSED; one artifact, one CONFIDENTIAL doc.extraction.completed
             with artifactKeys; markProcessing/recordExtractionResult replays idempotent; REVIEW_REQUIRED event;
             retryable failure keeps PROCESSING, final failure → FAILED (idempotent); UPLOADED markProcessing → 409;
             VALIDATED result → 409; user token → 403; unknown → 404; row counts on FILING → 422;
             internal presigned GET fetched (attachment)
  FR-FILE-07 getFile cached (file:status present), deleted by the next transition, cached entry never served to another
             tenant (404)
  FR-FILE-09 status filter + keyset pages (2 + 1, no overlap); other tenant sees none
  FR-FILE-08 URL fetched with filename*=UTF-8''R%C3%A9sum%C3%A9…; same URL on the second call (cached); UPLOADED → 409;
             quarantined: ANALYST + ack → 403 FILE_QUARANTINED, TA without ack → 403, TA + ack → 200 from the
             quarantine bucket; two calls → two ops.audit.quarantine_download {fileId, actorId}; other tenant → 404
gateway: vitest → 17/17 (+ GET routes: filters pass through, acknowledgeQuarantine true/false only)
make lint (0) · make typecheck (0) · make check (0) · make test-unit (0)
```

### Compose stack (2026-11-24, run by Claude Code)
```
make migrate → files V4 file artifacts: Success
compose build + recreate files, gateway
make test-e2e → Test Files 5 passed (5) · Tests 232 passed (232)
  files E2E: clean PDF → VALIDATED (detectedType application/pdf, artifacts []) → download URL fetched (attachment);
             EICAR → QUARANTINED MALWARE:… (real clamd); PDF-as-CSV → QUARANTINED TYPE_MISMATCH:application/pdf;
             ANALYST + ack → 403 FILE_QUARANTINED; TA without ack → 403; TA + ack → 200 and the URL downloads;
             list ?status=QUARANTINED contains both; tenant B GET → 404
  role matrix: + listFiles, getFile, getFileDownloadUrl × 6 roles
```

## Pending
- 5e (orphan sweep, retention purge, soft delete), 5b (multipart), Phase 5 exit (`scripts/demo/upload.ts`).
