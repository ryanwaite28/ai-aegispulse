-- V4: webhook deliveries (PROJECT.md §7.2; FR-WHK-02/03/05/07) under tenant RLS, plus the pre-tenant source lookup the
-- public webhook path needs (ADR-0016). Rejected deliveries are never stored (no unauthenticated write amplification).
CREATE TABLE ingestion.webhook_deliveries (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  source_id         UUID NOT NULL REFERENCES ingestion.webhook_sources(id),
  delivery_id       TEXT NOT NULL,                  -- X-Aegis-Delivery-Id
  idempotency_key   TEXT NOT NULL,                  -- {sourceKey}:{externalId}:v{n}
  event_id          UUID,                           -- null when duplicate
  outcome           TEXT NOT NULL CHECK (outcome IN ('ACCEPTED','DUPLICATE')),
  external_id       TEXT NOT NULL,
  category          TEXT NOT NULL,
  raw_storage_key   TEXT NOT NULL,
  raw_sha256        TEXT NOT NULL,
  signature_slot    TEXT NOT NULL CHECK (signature_slot IN ('CURRENT','PREVIOUS')),
  attachment_notes  JSONB NOT NULL DEFAULT '[]',     -- rejected/registered attachments
  received_at       TIMESTAMPTZ NOT NULL,
  correlation_id    TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX ux_deliveries_source_delivery ON ingestion.webhook_deliveries (source_id, delivery_id);
CREATE UNIQUE INDEX ux_deliveries_accepted_idem ON ingestion.webhook_deliveries (tenant_id, idempotency_key) WHERE outcome = 'ACCEPTED';
CREATE INDEX ix_deliveries_tenant_received ON ingestion.webhook_deliveries (tenant_id, received_at DESC);
CREATE INDEX ix_deliveries_source_received ON ingestion.webhook_deliveries (source_id, received_at DESC, id);  -- listing
CREATE INDEX ix_deliveries_raw_key ON ingestion.webhook_deliveries (raw_storage_key);                         -- orphan sweep

ALTER TABLE ingestion.webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ingestion.webhook_deliveries
  USING (tenant_id = ingestion.current_tenant())
  WITH CHECK (tenant_id = ingestion.current_tenant());

GRANT SELECT ON ingestion.webhook_sources, ingestion.webhook_secrets TO ingestion_platform;

-- FR-WHK-02 step 1: resolve a public sourceKey before any tenant context. Returns the active (non-deleted) source with
-- one row per secret slot; the service checks status, expiry and signatures and then works under the tenant's RLS.
CREATE FUNCTION ingestion.webhook_source_for_delivery(p_source_key text)
  RETURNS TABLE (source_id uuid, tenant_id uuid, source_key text, status text, trust_level text, payload_profile text,
                 allowed_attachment_hosts text[], slot text, ciphertext bytea, wrapped_data_key bytea, nonce bytea,
                 kek_version int, expires_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.id, s.tenant_id, s.source_key, s.status, s.trust_level, s.payload_profile, s.allowed_attachment_hosts,
         k.slot, k.ciphertext, k.wrapped_data_key, k.nonce, k.kek_version, k.expires_at
    FROM ingestion.webhook_sources s
    JOIN ingestion.webhook_secrets k ON k.source_id = s.id
   WHERE s.source_key = p_source_key AND s.deleted_at IS NULL
$$;
ALTER FUNCTION ingestion.webhook_source_for_delivery(text) OWNER TO ingestion_platform;
REVOKE ALL ON FUNCTION ingestion.webhook_source_for_delivery(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.webhook_source_for_delivery(text) TO svc_ingestion;
