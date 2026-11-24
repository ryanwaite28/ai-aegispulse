-- V3: webhook sources + encrypted signing secrets (PROJECT.md §7.2; FR-WHK-01/07) under tenant RLS (§7.0, ADR-0016).
-- source_key is globally unique (it is the public URL), so the unique index spans tenants; deleted sources keep their
-- key reserved. Secret material is AES-256-GCM ciphertext with an AES-KW-wrapped data key (spec FR-WHK-01-08).
CREATE TABLE ingestion.webhook_sources (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL,                -- registry tenant (no cross-schema FK by design)
  source_key                TEXT NOT NULL CHECK (source_key ~ '^[a-z0-9-]{3,60}$'),
  display_name              TEXT NOT NULL,
  trust_level               TEXT NOT NULL DEFAULT 'UNTRUSTED' CHECK (trust_level IN ('TRUSTED','UNTRUSTED')),
  payload_profile           TEXT NOT NULL DEFAULT 'AEGIS_MARKET_EVENT_V1',
  allowed_attachment_hosts  TEXT[] NOT NULL DEFAULT '{}',
  status                    TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','DISABLED')),
  deleted_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_webhook_sources_key ON ingestion.webhook_sources (source_key);
CREATE INDEX ix_webhook_sources_tenant ON ingestion.webhook_sources (tenant_id, status);
CREATE INDEX ix_webhook_sources_tenant_created ON ingestion.webhook_sources (tenant_id, created_at, id);  -- keyset list
CREATE TRIGGER trg_webhook_sources_updated_at BEFORE UPDATE ON ingestion.webhook_sources
  FOR EACH ROW EXECUTE FUNCTION ingestion.set_updated_at();

CREATE TABLE ingestion.webhook_secrets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  source_id        UUID NOT NULL REFERENCES ingestion.webhook_sources(id),
  slot             TEXT NOT NULL CHECK (slot IN ('CURRENT','PREVIOUS')),
  ciphertext       BYTEA NOT NULL,                  -- AES-256-GCM(secret) ‖ tag, per-row data key
  wrapped_data_key BYTEA NOT NULL,                  -- data key wrapped (AES-KW, RFC 3394) by INGESTION_KEK
  nonce            BYTEA NOT NULL,                  -- GCM nonce (12 bytes)
  kek_version      INT NOT NULL,
  expires_at       TIMESTAMPTZ,                     -- PREVIOUS slot: rotation time + 72 h
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_webhook_secret_slot ON ingestion.webhook_secrets (source_id, slot);

ALTER TABLE ingestion.webhook_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.webhook_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingestion.webhook_sources
  USING (tenant_id = ingestion.current_tenant())
  WITH CHECK (tenant_id = ingestion.current_tenant());
ALTER TABLE ingestion.webhook_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.webhook_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingestion.webhook_secrets
  USING (tenant_id = ingestion.current_tenant())
  WITH CHECK (tenant_id = ingestion.current_tenant());
