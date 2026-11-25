-- V5: immutable compliance audit log (PROJECT.md §7.4; FR-AUD-01). Per-tenant hash chain: seq assigned under
-- pg_advisory_xact_lock(tenant), hash = sha256(canonical_json(entry) || prev_hash). The service role may only SELECT
-- and INSERT; triggers reject UPDATE/DELETE/TRUNCATE for everyone (including owners).
CREATE TABLE cases.audit_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  seq               BIGINT NOT NULL CHECK (seq >= 1),
  occurred_at       TIMESTAMPTZ NOT NULL,
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('USER','SERVICE','SYSTEM')),
  actor_id          TEXT NOT NULL,
  acting_as         TEXT,
  action            TEXT NOT NULL,
  subject_type      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  trigger_event_id  UUID,
  trigger_file_id   UUID,
  model_version     TEXT,
  rule_version      TEXT,
  before_state      JSONB,
  after_state       JSONB,
  source_event_id   UUID,
  prev_hash         CHAR(64) NOT NULL,
  hash              CHAR(64) NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_audit_tenant_seq ON cases.audit_log (tenant_id, seq);
CREATE UNIQUE INDEX ux_audit_source_event ON cases.audit_log (tenant_id, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE INDEX ix_audit_subject ON cases.audit_log (tenant_id, subject_type, subject_id, occurred_at DESC);
CREATE INDEX ix_audit_actor ON cases.audit_log (tenant_id, actor_id, occurred_at DESC);

CREATE FUNCTION cases.reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_log is append-only'; END $$;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON cases.audit_log
  FOR EACH ROW EXECUTE FUNCTION cases.reject_audit_mutation();
CREATE TRIGGER trg_audit_no_truncate BEFORE TRUNCATE ON cases.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION cases.reject_audit_mutation();

CREATE TABLE cases.audit_chain_heads (
  tenant_id     UUID PRIMARY KEY,
  last_seq      BIGINT NOT NULL,
  last_hash     CHAR(64) NOT NULL,
  verified_seq  BIGINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_audit_heads_updated_at BEFORE UPDATE ON cases.audit_chain_heads
  FOR EACH ROW EXECUTE FUNCTION cases.set_updated_at();

ALTER TABLE cases.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cases.audit_log
  USING (tenant_id = cases.current_tenant()) WITH CHECK (tenant_id = cases.current_tenant());
ALTER TABLE cases.audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE cases.audit_chain_heads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cases.audit_chain_heads
  USING (tenant_id = cases.current_tenant()) WITH CHECK (tenant_id = cases.current_tenant());

REVOKE UPDATE, DELETE, TRUNCATE ON cases.audit_log FROM svc_cases;
REVOKE DELETE, TRUNCATE ON cases.audit_chain_heads FROM svc_cases;
