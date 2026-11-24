# Phase 05 (slice 5c) — File validation consumer — Exit Evidence

| | |
|---|---|
| Commit SHA | base `0fde521` + uncommitted slice 5c working tree |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers PostgreSQL 18.7 + SeaweedFS 4.54; compose stack with clamav/clamav:1.5.5 |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 5c `RUNTIME-VERIFIED` locally |

## Scope
Spec: [FR-FILE-01-13-files](../specs/FR-FILE-01-13-files.md) §2 "Validation consumer".

## Commands and results
```
services/files: vitest (unit) → 14/14  (+ sniffing/compatibility/verdict 5, clamd INSTREAM framing 2)
services/files: validation.integration → 4/4 (real PG as svc_files, SeaweedFS files identity; fake AV flags EICAR):
  clean PDF → VALIDATED (detected application/pdf, verified sha) + doc.file.ready + file.status.changed; same eventId → duplicate;
             new eventId → duplicate (not UPLOADED); still 2 events
  EICAR     → QUARANTINED MALWARE:Eicar-Test-Signature; object at quarantine/{tenant}/{file}; raw deleted;
             N-03 {severity HIGH, notificationKey N-03:{fileId}, vars {fileId, reason, tenantSlug}}
  PDF as CSV → QUARANTINED TYPE_MISMATCH:application/pdf (N-03 MEDIUM); checksum → FAILED CHECKSUM_MISMATCH (only a status
             event); longer than declared → FAILED SIZE_MISMATCH; no object → FAILED OBJECT_MISSING
  interrupted move (raw reappears after commit) → redelivery deletes it; wrong tenant → PermanentError NOT_FOUND
make lint (0) · make typecheck (0) · make check (0) · make test-unit (0)
```

### Compose stack with the real clamd (2026-11-24, run by Claude Code)
```
clamd.conf after CLAMD_CONF_*: StreamMaxLength 65M, MaxFileSize 65M (default was 25M)
make test-e2e → Test Files 5 passed · Tests 214 passed (files E2E uploads EICAR and a PDF declared as CSV)
files "file.validated" log lines over the run:
   1 QUARANTINED MALWARE:Eicar-Test-Signature    detected text/plain        ← real clamd verdict
   1 QUARANTINED TYPE_MISMATCH:application/pdf   detected application/pdf
   2 VALIDATED                                    detected application/pdf
rabbitmqctl list_queues: files.validation.q 0 (1 consumer) · files.validation.q.dlq 0 · doc.extraction.q 2 ·
                         orchestrator.notify.q 2
```
Since 5d, the files E2E asserts these outcomes through `GET /v1/files/{id}` ([phase-05d](phase-05d.md)).

## Pending
- 5d (lifecycle API + reads/downloads, incl. quarantine acknowledgement), 5e, 5b.
- k8s clamd config (Phase 9) needs the same `StreamMaxLength`/`MaxFileSize` 65M.
