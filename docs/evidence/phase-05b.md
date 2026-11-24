# Phase 05 (slice 5b) — Multipart uploads — Exit Evidence

| | |
|---|---|
| Commit SHA | base `1ed508a` + uncommitted slice 5b |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers PostgreSQL 18.7, Redis 8.10.3, SeaweedFS 4.54; compose stack (multipart on, clamd 520M) |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 5b `RUNTIME-VERIFIED` locally |

## Scope
Spec: [FR-FILE-01-13-files](../specs/FR-FILE-01-13-files.md) §2 "Multipart uploads".

## Commands and results
```
services/files: vitest (unit) → 17/17 (+ upload mode, part sizes, part-list rules)
services/files: test:integration → 21/21 (uploads 9 incl. 2 multipart, validation 4, lifecycle 5, maintenance 3):
  70 MiB → multipart 5 parts (16 MiB, last 6 MiB), URLs without the filename; part 1 with a 1 KiB body → 403;
  complete with 4 parts → 422; with an unuploaded part 5 → 409 UPLOAD_NOT_FOUND_IN_STORAGE; all 5 in reverse
  order → UPLOADED, file.uploaded + file.status.changed; parts on a single-PUT file → 422
  65 MiB → one part uploaded → abort → EXPIRED, ListParts → NoSuchUpload; flag off → 413 FILE_TOO_LARGE
make lint (0) · make typecheck (0) · make check (0) · make test-unit (0)
```

### Compose stack (2026-11-24, run by Claude Code)
```
clamd.conf: StreamMaxLength 520M, MaxFileSize 520M, MaxScanSize 520M · files MULTIPART_UPLOADS_ENABLED=true
make test-e2e → Test Files 5 passed · Tests 240 passed
  FR-FILE-13: 200 MiB text file → 13 parts (each request < 100,000,000 bytes) PUT to http://localhost:9000 →
              complete with ETags via the gateway → UPLOADED (sizeBytes 209715200) → VALIDATED (full SHA-256 +
              clamd INSTREAM of 200 MiB)
  size above the contract maximum (512 MiB + 1) → 422 VALIDATION_ERROR (FILE_TOO_LARGE 413 is for > 64 MiB with
  multipart off; integration-tested)
```
