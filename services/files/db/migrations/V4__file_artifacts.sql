-- V4: extraction artifacts (PROJECT.md §7.3; FR-FILE-06) under tenant RLS, plus the pre-tenant lookup the
-- doc-extraction lifecycle actions need: SERVICE callers name only a fileId, so files resolves its tenant through a
-- SECURITY DEFINER function owned by files_platform (ADR-0016) and then works under that tenant's RLS.
-- §11 names this V3__file_artifacts; V2 is ADR-0016's enforced_rls_bypass, so the numbering moves up by one.
CREATE TABLE files.file_artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  file_id            UUID NOT NULL REFERENCES files.files(id),
  extractor_version  TEXT NOT NULL,
  result_status      TEXT NOT NULL CHECK (result_status IN ('COMPLETED','REVIEW_REQUIRED')),
  confidence         NUMERIC(4,3) NOT NULL,
  text_key           TEXT,
  chunks_key         TEXT,
  extraction_key     TEXT NOT NULL,
  row_errors_key     TEXT,                          -- TRANSACTION_BATCH only
  rows_accepted      INT,
  rows_rejected      INT,
  summary            JSONB NOT NULL,                -- eventTypeGuess, entity count, red flags
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_artifacts_file_version ON files.file_artifacts (file_id, extractor_version);

ALTER TABLE files.file_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE files.file_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON files.file_artifacts
  USING (tenant_id = files.current_tenant())
  WITH CHECK (tenant_id = files.current_tenant());

GRANT SELECT ON files.files TO files_platform;

-- The tenant of a file (null when unknown). Returns no other column.
CREATE FUNCTION files.file_tenant(p_file_id uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT tenant_id FROM files.files WHERE id = p_file_id
$$;
ALTER FUNCTION files.file_tenant(uuid) OWNER TO files_platform;
REVOKE ALL ON FUNCTION files.file_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files.file_tenant(uuid) TO svc_files;
