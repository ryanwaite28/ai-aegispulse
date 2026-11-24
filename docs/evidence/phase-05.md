# Phase 05 — Files Subsystem — Exit Evidence

| | |
|---|---|
| Commit SHA | slices `0fde521` (5a), `560e4e2` (5c+5d), `8ebe8d4` (5e), `1ed508a` (audit amendment) + uncommitted 5b and exit |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local compose stack (real clamd 1.5.5, SeaweedFS, RabbitMQ 4); Testcontainers suites per slice |
| Pipeline | pending |
| Verified by | Claude Code (Opus); every stack command below was run by Claude Code |
| Resulting status | `RUNTIME-VERIFIED` locally; the exit waits on green pipelines |

Slice evidence: [5a](phase-05a.md) · [5b](phase-05b.md) · [5c](phase-05c.md) · [5d](phase-05d.md) · [5e](phase-05e.md). Spec: [FR-FILE-01-13](../specs/FR-FILE-01-13-files.md).

## §11 exit items
### 1. `scripts/demo/upload.mts` (`make demo-upload`): init → PUT → complete → VALIDATED with `doc.file.ready` on the broker
```
demo-upload: q3-filing.pdf: init 201 → PUT 200 → complete → UPLOADED (fileId 63bbcfcb-65f2-4004-99e6-588498463504)
demo-upload: q3-filing.pdf: VALIDATED detectedType=application/pdf
demo-upload: eicar.txt: init 201 → PUT 200 → complete → UPLOADED (fileId 4cd0b29b-3465-4113-9ff1-5a230ff58e4d)
demo-upload: eicar.txt: QUARANTINED detectedType=text/plain reason=MALWARE:Eicar-Test-Signature
files.outbox_events for 63bbcfcb…: file.uploaded SENT (ingress) · file.status.changed SENT ×2 (enrichment) ·
                                   doc.file.ready SENT (enrichment)
rabbitmqctl list_queues: doc.extraction.q 19 ready (was 18; the consumer arrives in Phase 11)
```
(The demo runs as the bootstrap PLATFORM_ADMIN acting on `tenant-acme-capital` via `X-Aegis-Tenant`; its password goes from `.env` to the process only.)

### 2. EICAR quarantine evidence
- Real clamd verdict `MALWARE:Eicar-Test-Signature`. The object moved to `quarantine/{tenantId}/{fileId}`, and `notification.requested` N-03 went to `orchestrator.notify.q` ([5c](phase-05c.md)).
- An ANALYST download of the quarantined file → 403 `FILE_QUARANTINED`; TENANT_ADMIN + `acknowledgeQuarantine=true` → 200, audited as `ops.audit.quarantine_download` ([5d](phase-05d.md)).

### 3. Orphan sweep logs
14 INITIATED uploads left by the E2E runs were backdated 2 h (local database only), then:
```
make trigger JOB=files-orphan-sweep → files-orphan-sweep job succeeded {processedCount: 14}
files: {"job":"files.sweepOrphans","processedCount":14,"durationMs":74,"msg":"files maintenance run"}
after: INITIATED 0
```
The integration flood (100 inits, 25 with landed objects → 100 EXPIRED, zero objects left) is in [5e](phase-05e.md).

## Final sweep (2026-11-24)
```
make lint (0) · make typecheck (0) · make check (0) · make test-unit (0; files 17/17)
services/files test:integration → 21/21 · make test-e2e → 240/240
```


## Operations: OpenObserve (gate item 6; queried 2026-11-24 over the last 6 h, through the ingestion container's own OTLP credentials)
```
traces by service: gateway 10,683 · registry 16,917 · cases 1,491 · files 1,055 · events 666 · ingestion 666 · others
metric streams: aegispulse_classification_stage1_seconds(_bucket/_count/_sum/_min/_max), aegispulse_consumer_processed_total,
                aegispulse_outbox_lag_seconds, aegispulse_webhook_rejected_total
aegispulse_consumer_processed_total by queue/outcome: files.validation.q success · events.archive.q success ·
                events.archive.q dead_letter (the one historical platform-tenant event; a cumulative counter re-exported every 15 s)
```

## Pending
- ~~Green pipelines~~ green (owner-reported 2026-11-24).
- Gate 1: merge `feature/project` to `main`. Gate 2 passed 2026-11-24 ([clean-state-2026-11-24](clean-state-2026-11-24.md)).
- Phase 9: k8s CronJobs `aegispulse-cron-file-sweep` / `aegispulse-cron-retention`, and clamd StreamMaxLength/MaxFileSize/MaxScanSize 520M in the cluster config.
