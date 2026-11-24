# Spec — FR-FILE-01..10, 12, 13 — Files subsystem (Phase 5)

| | |
|---|---|
| Phase | 05 — Files Subsystem (`PROJECT.md` §11). FR-FILE-11 (remote fetch with SSRF guard) is Phase 11 |
| Owner runtime(s) | `services/files` (TS/Fastify); gateway `/v1/files*` |
| Status | 5a RUNTIME-VERIFIED locally (2026-11-24, E2E 213/213); 5b, 5c, 5d, 5e RUNTIME-VERIFIED locally (2026-11-24); Phase 5 exit captured |
| Slices | **5a** init, dedup, quotas, complete/abort (FR-FILE-01..04) · **5c** validation consumer (FR-FILE-05) · **5d** processing lifecycle + reads/downloads (FR-FILE-06..09) · **5e** sweeps, retention, delete (FR-FILE-10/12) · **5b** multipart (FR-FILE-13, named "Phase 5b" in §2.7, delivered last behind `MULTIPART_UPLOADS_ENABLED`) |
| Related | ADR-0002, ADR-0004 (outbox), ADR-0009 (pointers only), ADR-0011 (object store), ADR-0016 (RLS); NFR-02, NFR-08 |

## 1. Requirement
`PROJECT.md` §2.7 FR-FILE-01..13 (verbatim there). Migrations are **V3/V4**: V2 is ADR-0016's `enforced_rls_bypass`, so §11's `V2__files` / `V3__file_artifacts` move up by one (clarification, as for Phases 2–4).

## 2. Behavior
### Authorization (all actions)
- **Roles:** the files service re-checks the contract's `x-aegis-roles` for each operation, read from the generated `gateway-routes.json`, so the gateway and service can't drift.
- **Acting tenant:** this uses the kit's `tenantAccess` (the TS twin of the registry's `TenantAccess`).
  - Tenant roles act on their own tenant.
  - `PLATFORM_ADMIN` must send `X-Aegis-Tenant` (otherwise 403), and the platform tenant is a 404.
  - Anyone else sending the header gets 403.
  - SERVICE tokens are refused.
- **Actor:** recorded as `user:{id}` or `integration:{clientId}` in `file_status_history.actor` and in the upload session. `files.uploaded_by` is the user id, and null for INTEGRATION accounts.
- **"ANALYST+":** means ANALYST, TENANT_ADMIN or PLATFORM_ADMIN.

### initUpload (FR-FILE-01..03; 5a)
Steps, in order:
1. Authorize.
2. `allowDuplicate` requires ANALYST+.
3. Content-type allowlist → `422 FILE_TYPE_NOT_ALLOWED`. Size: a single PUT is at most 64 MiB, otherwise `413 FILE_TOO_LARGE` (multipart is 5b).
4. Tenant status from the registry (`getTenantSettings`, kit cache ≤ 60 s): not ACTIVE → `403 TENANT_SUSPENDED`. An unknown tenant surfaces the registry's 404.
5. One tenant transaction:
   - Idempotency-Key replay or conflict (NFR-02).
   - **Rate:** Redis token bucket `quota:files:{tenantId}`, capacity 60 refilling at 1/s, hash with 120 s TTL; over → `429 UPLOAD_RATE_LIMITED`. The bucket uses the caller's clock, because the files ACL user may not run `TIME`.
   - **Dedup** (unless `allowDuplicate`): the Redis pointer `file:dedup:{tenantId}:{sha256}` (24 h), verified against a live row. Otherwise the `ix_files_tenant_sha` live-row lookup, which re-seeds the pointer. A hit returns `200 {fileId, status, deduplicated: true}` with no URL.
   - **Storage quota:** `sum(size_bytes)` over files not EXPIRED and not purged, plus this file's size, may not exceed 10 GiB; otherwise `413 STORAGE_QUOTA_EXCEEDED`.
   - Insert the row as `INITIATED`, plus a history row.
6. **Presigned PUT** (10 min):
   - Signed by a client whose endpoint is `PUBLIC_OBJECTS_URL`, so the signed host is the one clients use.
   - `Content-Type` and `Content-Length` are signed headers; a different type or length gets a 403 from the object store.
   - Checksum query parameters are disabled (`requestChecksumCalculation: WHEN_REQUIRED`), so a plain PUT works.
7. Redis session `upload:session:{fileId}` (hash: tenantId, uploader, size, sha256, key; 900 s), written by one script because the ACL has no MULTI/EXEC. Set the dedup pointer (NX).
8. Return `201`.

**Filename.** The contract pattern rejects separators, control characters and a leading dot (`422 VALIDATION_ERROR`). This is the §11 "`../../etc/passwd`" case: it is refused outright rather than accepted. Behind that, `sanitizeFilename` (NFC, last segment, controls removed, leading dots stripped) stores a display-only name. The object key is `raw/{tenantId}/{yyyy}/{mm}/{dd}/{fileId}` and never contains the filename.

### completeUpload (FR-FILE-04; 5a)
1. A missing or deleted file → 404.
2. Status other than INITIATED → `200` with the current file (idempotent; it never revives an EXPIRED file).
3. No session → `409 UPLOAD_SESSION_EXPIRED`.
4. Caller must be the uploader or ANALYST+, otherwise 403.
5. `HEAD` object: missing → `409 UPLOAD_NOT_FOUND_IN_STORAGE`; size different from the declared size → `409 UPLOAD_SIZE_MISMATCH`.
6. Optimistic transition `INITIATED → UPLOADED` (`version`). A concurrent complete that loses re-reads and returns the winner's result, so there is exactly one transition and one pair of events.
7. Outbox: `file.uploaded` on `aegispulse.ingress` (ids, key, sha256, size, type, purpose, source; never the filename or content), plus `file.status.changed` on `aegispulse.enrichment`.
8. After commit: delete the session and invalidate `file:status:{fileId}`.

`parts` (multipart) is refused until 5b.

### abortUpload (5a)
- `INITIATED → EXPIRED` (reason `aborted`), by the uploader or ANALYST+, and emits `file.status.changed`.
- After commit: delete any landed object, the session, and the dedup pointer (compare-and-delete). Then invalidate the status cache.
- EXPIRED again → 200 (idempotent). Any other status → `409 CONFLICT`.

### Validation consumer (FR-FILE-05; 5c)
`files.validation.q` (on `file.uploaded`, prefetch 4, retries 1 s / 5 s / 30 s, then the DLQ). The adapter parses the envelope; a non-`file.uploaded` or malformed payload is a poison message. Then `FileValidationService.validateFile`:
1. **Load** the file under the envelope's tenant (RLS); an unknown file is a PermanentError (DLQ). Status `QUARANTINED` → finish an interrupted move (delete the raw key from the event) and ack. Any other status except `UPLOADED` → ack without action.
2. **One streaming pass** over the object:
   - SHA-256 and byte count; reading stops once the object exceeds its declared size.
   - The first 8 KiB are kept for sniffing.
   - Every chunk goes to clamd `zINSTREAM` (4-byte length framing, ≤ 1 MiB frames) when `FILES_AV_ENABLED`.
   - clamd errors or timeouts are TransientError (retry, then the DLQ); a verdict is never guessed.
   - Compose sets `StreamMaxLength`/`MaxFileSize` to 65M (the default was 25M).
3. **Sniff** (`domain/validation.ts`):
   - `%PDF-` magic → PDF.
   - zip/PE/ELF/PNG/JPEG/GIF/gzip/OLE magic, NULs, C0 controls or invalid UTF-8 → binary. A multi-byte character cut at the window edge is tolerated.
   - Text is then classified as HTML (doctype, `<html`, `<head`/`<body`), JSON (`{`/`[`), CSV (consistent comma counts over the first lines) or plain.
   - **Compatibility:** PDF needs PDF; HTML needs HTML; JSON needs JSON; CSV accepts CSV or plain; plain accepts any text.
4. **Verdict** (`decide`), in this order:
   - malware → `QUARANTINED` (`MALWARE:{signature}`);
   - size → `FAILED` (`SIZE_MISMATCH`); checksum → `FAILED` (`CHECKSUM_MISMATCH`); object gone → `FAILED` (`OBJECT_MISSING`);
   - type → `QUARANTINED` (`TYPE_MISMATCH:{detected}`);
   - otherwise `VALIDATED`.
5. **Quarantine move:** a server-side `CopyObject` to the quarantine bucket at `quarantine/{tenantId}/{fileId}` (files identity: raw read, quarantine write), before the transaction.
6. **Tenant transaction:**
   - `processed_messages` (consumer `files.validation.q`, eventId, replay generation) → duplicate ack.
   - Optimistic `UPLOADED → …` transition with `detected_type`, `verified_sha256`, and the new bucket/key when quarantined.
   - Outbox `file.status.changed`, plus `doc.file.ready` (VALIDATED, enrichment → `doc.extraction.q`) or `notification.requested` N-03 (QUARANTINED, enrichment → `orchestrator.notify.q`; severity HIGH for malware, MEDIUM for type; `notificationKey N-03:{fileId}`; vars `fileId, reason, tenantSlug` from the registry cache).
7. **After commit:** delete the raw object (QUARANTINED) and invalidate `file:status:{fileId}`. A crash between commit and delete is finished by the redelivery (step 1).

### Processing lifecycle for doc-extraction (FR-FILE-06; 5d)
- **Callers:** SERVICE tokens only. The route's `authorizeInternal` checks `act[]`; the service refuses user and INTEGRATION tokens (403).
- **Tenant lookup:** callers name only a `fileId`. The tenant comes from the definer `files.file_tenant(uuid)` (V4, owned by `files_platform`, ADR-0016), then the work runs under that tenant's RLS. An unknown file → 404.
- **`markProcessing`:** `VALIDATED → PROCESSING` and sets `extractor_version`; PROCESSING or PROCESSED → returns the current file (redelivery); anything else → `409 CONFLICT`.
- **`recordExtractionResult`:**
  - Requires PROCESSING; PROCESSED → returns the current file.
  - Inserts `file_artifacts`; `ON CONFLICT (file_id, extractor_version)` makes a replay a no-op with no second event.
  - Transitions to `PROCESSED` and emits `file.status.changed` plus `doc.extraction.completed|review_required` on `aegispulse.enrichment`. That event is CONFIDENTIAL; its payload is `fileId, extractorVersion, eventTypeGuess, mentionedEntities, redFlags, confidence, textExcerpt (≤ 2,000), artifactKeys`.
  - Row counts are allowed only for `TRANSACTION_BATCH` (otherwise 422).
  - Artifact keys must match `artifacts/{uuid}/{uuid}/{version}/{name}`.
- **`recordProcessingFailure`:** retryable → logged, status unchanged; not retryable → `PROCESSING → FAILED` (reason ≤ 500); FAILED again → idempotent.
- **`getInternalDownloadUrl`:** presigned GET on the in-cluster endpoint (5 min, attachment) for VALIDATED, PROCESSING or PROCESSED; otherwise `409 FILE_NOT_DOWNLOADABLE`.

### Reads and downloads (FR-FILE-07..09; 5d)
- **`getFile`:**
  - Returns `FileDetail`: the File view plus `artifacts[]` (extractorVersion, resultStatus, confidence, row counts, summary, createdAt).
  - Cached in `file:status:{fileId}` for 30 s and deleted on every transition (upload, validation, processing). A cache entry is served only to the tenant recorded in it; any other tenant falls through to RLS → 404.
- **`listFiles`:** filters `status, purpose, uploadedBy, from, to`; keyset `(created_at, id)` newest first; soft-deleted files are excluded; `limit` 1–100 (default 25).
- **`getDownloadUrl`:**
  - Presigned GET for `PUBLIC_OBJECTS_URL` (5 min).
  - `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<encoded>` from the sanitized name.
  - VALIDATED, PROCESSING or PROCESSED → URL, cached 240 s in `file:dlurl:{fileId}:{actor}`.
  - QUARANTINED → only a TENANT_ADMIN user with `acknowledgeQuarantine=true` (otherwise `403 FILE_QUARANTINED`). The URL points at the quarantine bucket, is never cached, and every call emits `ops.audit.quarantine_download {fileId, actorId}` (intelligence) with a warning log.
  - Other statuses → `409 FILE_NOT_DOWNLOADABLE`.

### Sweeps, retention, delete (FR-FILE-10/12; 5e)
- **Discovery:** cross-tenant discovery uses the V5 definers `files.orphan_candidates(cutoff, limit)` and `files.retention_tenants()` (ADR-0016). Every change runs per tenant under RLS.
- **`sweepOrphans`** (scheduler-trigger `files-orphan-sweep`, every 15 min; SERVICE only):
  - INITIATED files with `created_at` more than 1 h ago → optimistic `INITIATED → EXPIRED` (reason `ORPHAN_TIMEOUT`) plus `file.status.changed`.
  - After commit: delete any object that landed without a complete, abort a multipart upload (FR-FILE-13), delete the session, release the dedup pointer, invalidate the status cache.
  - Batches of 500, at most 20 per run; re-running is a no-op.
- **`purgeRetention`** (`files-retention`, daily; SERVICE only):
  - For each tenant with unpurged files, `retentionDays` comes from the registry (kit cache); a tenant the registry does not know is skipped with a warning.
  - Files created before `now − retentionDays` first lose their object (raw or quarantine bucket) and every recorded artifact object (idempotent deletes).
  - Then the tombstone: `purged_at` set, `deleted_at` set if unset, artifact rows removed, history `RETENTION_PURGE`. The `files` row stays. A crash between the deletes and the tombstone is finished by the next run.
- **`deleteFile`** (TENANT_ADMIN, contract roles):
  - Soft delete (`deleted_at`); the object stays until the purge.
  - The status cache and every cached download URL of the file (`SCAN file:dlurl:{fileId}:*`) are dropped. Afterwards get, list and download → 404.
  - Repeat → 404.
- **Audited** (FR-FILE-12, amended 2026-11-24): the soft delete enqueues `ops.audit.file_deleted {fileId, actorId}` on `aegispulse.intelligence` in the same transaction. It is bound to `cases.audit-ingest.q` by `ops.audit.*`, and FR-AUD-02 now lists file deletions. The file's history also records it (reason `DELETED`, actor `user:{id}`).
- **Object-store grant** (§5.7.3, clarification forced by FR-FILE-12): the `files` identity gains write (delete) on `artifacts/*` for the purge. It already had read; doc-extraction remains the writer of artifact contents.

### Multipart uploads (FR-FILE-13; 5b, behind `MULTIPART_UPLOADS_ENABLED`)
- **Size → mode** (`uploadMode`):
  - ≤ 64 MiB → single presigned PUT;
  - 64 MiB–512 MiB with the flag → multipart;
  - over 64 MiB without the flag → `413 FILE_TOO_LARGE`;
  - over 512 MiB → `422 VALIDATION_ERROR`, because it exceeds the contract maximum.
  - The flag defaults to false (§10.4). The local compose stack sets it so the 200 MiB E2E runs; dev and prod set it explicitly.
- **Init:**
  - `CreateMultipartUpload` (internal client) first, so the row records `multipart_upload_id`.
  - Then `multipart {uploadId, partSizeBytes: 16 MiB, parts[{partNumber, url}]}`: one presigned `UploadPart` URL per part (10 min, public host) with the part's exact length as a signed header (16 MiB; the last part holds the remainder).
  - At most 32 parts, so every request stays under Cloudflare's 100 MB edge cap.
  - An init that fails after the create leaves an unused multipart upload with no row (rare; object-store lifecycle cleanup).
- **Complete:**
  - Allowed `parts[{partNumber, etag}]` only for multipart files (otherwise 422), and it must be exactly 1..n, each once, any order (otherwise 422).
  - HEAD first: an already-assembled object (a retry after the store completed) skips assembly. Otherwise `CompleteMultipartUpload`; unknown or unuploaded parts / wrong ETags / no such upload → `409 UPLOAD_NOT_FOUND_IN_STORAGE`.
  - Then the usual size check, transition and events.
- **Abort and the orphan sweep:** both call `AbortMultipartUpload`.
- **Validation:** unchanged (streamed). clamd limits in compose are `StreamMaxLength`/`MaxFileSize`/`MaxScanSize` 520M (512 MiB uploads).

### Gateway (5a)
- `FilesClient` forwards the caller's token, `X-Aegis-Tenant` and `Idempotency-Key`.
- Init maps to `201` (new) or `200` (`deduplicated: true`), as the contract states.
- Complete and abort take the path id; a malformed id is a local 404 (`uuidParam` convention).

## 3. Data
- **`V3__files.sql`** (5a): `files.files` and `files.file_status_history` (§7.3) under RLS.
- **`V5__file_maintenance.sql`** (5e): the definers `files.orphan_candidates` and `files.retention_tenants` (no table changes).
- **`V4__file_artifacts.sql`** (5d): `files.file_artifacts` (§7.3) under RLS, plus the definer `files.file_tenant(uuid)` (EXECUTE for `svc_files` only).

## 4. Tests
| Level | Test | Proves |
|---|---|---|
| Unit | `domain/file.test.ts` | key shape (ids + UTC day only); filename rule and sanitizer; type allowlist; 64 MiB bound; transitions |
| Unit | kit `auth.test.ts` (`tenantAccess`) | own tenant; header PA-only; PA needs a non-platform tenant; INTEGRATION actor; SERVICE refused |
| Unit | gateway `files.test.ts` | headers forwarded; 201 vs 200 dedup; path id only; malformed id local 404 |
| Integration (Testcontainers PG+Redis+SeaweedFS) | `uploads.integration.test.ts` | real presigned PUT (wrong type → 403, short body → 403, correct → 200); complete → UPLOADED + both events, idempotent; no PUT → 409; size mismatch → 409; 5 concurrent completes → one transition; dedup (Redis then DB, tenant-scoped, `allowDuplicate` ANALYST+, released by abort); 60/min → 429; quota → 413; suspended → 403; filename never in the key; PA via header only; uploader/ANALYST+ rule; abort deletes the landed object; Idempotency-Key replay and reuse |
| Unit | `domain/validation.test.ts`, `storage/clamav.test.ts` (5c) | sniffing incl. BOM, cut multi-byte, binaries; compatibility; verdict order (malware first); INSTREAM framing against a fake clamd (1 MiB split, FOUND, ERROR → TransientError, unreachable → TransientError) |
| Integration | `validation.integration.test.ts` (5c) | clean PDF → VALIDATED + doc.file.ready + status event, redelivery no-op; EICAR (fake AV) → quarantine copy, raw deleted, N-03 vars; PDF-as-CSV → TYPE_MISMATCH; checksum/size/missing → FAILED; interrupted move finished on redelivery; wrong tenant → PermanentError |
| Unit | `attachmentDisposition` (5d); gateway GET routes | ASCII fallback + RFC 5987 name, no quote break-out; filters pass through, `acknowledgeQuarantine` true/false only |
| Integration | `lifecycle.integration.test.ts` (5d) | VALIDATED → PROCESSING → PROCESSED + one artifact + one CONFIDENTIAL `doc.extraction.completed`; replays idempotent; REVIEW_REQUIRED; retryable vs final failure; illegal transitions → 409; user token → 403; unknown → 404; row counts only for batches; internal download fetched; getFile cache + invalidation + no cross-tenant hit; list filters + keyset pages; download URL fetched with UTF-8 disposition, cached per actor; quarantine: ANALYST 403, TA without ack 403, TA with ack 200 + one audit event per call; other tenant 404 |
| Unit | scheduler-trigger `jobs.test.ts` (5e) | `files-orphan-sweep` → files.sweepOrphans, `files-retention` → files.purgeRetention, both on the svc-scheduler-trigger allowlist |
| Integration | `maintenance.integration.test.ts` (5e) | orphan flood: 100 real inits (25 with a PUT) backdated 2 h → 100 EXPIRED + 100 events, zero objects left under the tenant, sessions released, a young upload kept; user token 403; purge: PROCESSED+artifact and QUARANTINED past 30 days → objects in raw/quarantine/artifacts deleted, tombstones (purged+deleted, no artifact rows), a 10-day file kept, an unknown tenant skipped, a re-run is a no-op; delete: ANALYST 403, TA → caches dropped, get/download 404, list excludes, object kept, history DELETED by `user:{id}`, repeat 404 |
| Unit | `domain/file.test.ts` (5b) | size → mode (64 MiB / 512 MiB / flag); 16 MiB parts with remainder, 32 at 512 MiB; part list exactly 1..n with ETags |
| Integration | `uploads.integration.test.ts` (5b) | real 70 MiB multipart on SeaweedFS: 5 part URLs without the filename; a short body → 403 (signed length); complete with a missing part → 422, with an unuploaded part → 409; all 5 (reversed order) → UPLOADED + events; parts on a single-PUT file → 422; abort → EXPIRED and ListParts → NoSuchUpload; flag off → 413 |
| E2E | `tests/e2e/files.e2e.test.ts` + role matrix Phase 5 (5b: 200 MiB in 13 parts, each request < 100 MB → UPLOADED → VALIDATED after a full SHA-256 + clamd scan) | the same flow through the gateway against compose, PUT to `PUBLIC_OBJECTS_URL`, tenant B → 404 |
