-- V3: files + status history (PROJECT.md §7.3; FR-FILE-01..05) under tenant RLS (§7.0, ADR-0016). §11 names this
-- V2__files; V2 is ADR-0016's enforced_rls_bypass, so the file numbering moves up by one (as in Phase 4).
CREATE TABLE files.files (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),   -- fileId
  tenant_id          UUID NOT NULL,
  uploaded_by        UUID,                                         -- null for INTEGRATION uploads, WEBHOOK_ATTACHMENT, CONNECTOR_FETCH
  original_filename  TEXT NOT NULL,                                -- sanitized, display only
  storage_bucket     TEXT NOT NULL,
  storage_key        TEXT NOT NULL,                                -- raw/{tenantId}/{yyyy}/{mm}/{dd}/{fileId}
  content_type       TEXT NOT NULL CHECK (content_type IN ('application/pdf','text/html','text/csv','application/json','text/plain')),
  detected_type      TEXT,                                         -- magic-byte sniff result
  size_bytes         BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 536870912),
  sha256_checksum    CHAR(64) NOT NULL,                            -- declared at init
  verified_sha256    CHAR(64),                                     -- computed at validation
  source_type        TEXT NOT NULL CHECK (source_type IN ('AD_HOC_UPLOAD','WEBHOOK_ATTACHMENT','CONNECTOR_FETCH')),
  source_url         TEXT,                                         -- remote fetches only
  purpose            TEXT NOT NULL CHECK (purpose IN ('FILING','REGULATORY_DOCUMENT','TRANSACTION_BATCH','OTHER')),
  related_entity_ids UUID[] NOT NULL DEFAULT '{}',
  status             TEXT NOT NULL CHECK (status IN ('INITIATED','UPLOADED','VALIDATED','PROCESSING','PROCESSED','FAILED','QUARANTINED','EXPIRED')),
  failure_reason     TEXT,
  multipart_upload_id TEXT,
  extractor_version  TEXT,
  correlation_id     TEXT NOT NULL,
  version            INT NOT NULL DEFAULT 0,                       -- optimistic locking
  deleted_at         TIMESTAMPTZ,
  purged_at          TIMESTAMPTZ,                                  -- tombstone after retention purge
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_files_storage_key ON files.files (storage_bucket, storage_key);
CREATE INDEX ix_files_tenant_sha ON files.files (tenant_id, sha256_checksum) WHERE status NOT IN ('FAILED','EXPIRED') AND deleted_at IS NULL;
CREATE INDEX ix_files_tenant_status_created ON files.files (tenant_id, status, created_at DESC);
CREATE INDEX ix_files_initiated_age ON files.files (created_at) WHERE status = 'INITIATED';
CREATE TRIGGER trg_files_updated_at BEFORE UPDATE ON files.files
  FOR EACH ROW EXECUTE FUNCTION files.set_updated_at();

CREATE TABLE files.file_status_history (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  file_id     UUID NOT NULL REFERENCES files.files(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  reason      TEXT,
  actor       TEXT NOT NULL,                       -- user id, 'system', or service name
  event_id    UUID,                                -- triggering message, if any
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ix_file_status_history_file ON files.file_status_history (file_id, created_at);

ALTER TABLE files.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.files FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.files
  USING (tenant_id = files.current_tenant())
  WITH CHECK (tenant_id = files.current_tenant());
ALTER TABLE files.file_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.file_status_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.file_status_history
  USING (tenant_id = files.current_tenant())
  WITH CHECK (tenant_id = files.current_tenant());
