-- V5: cross-tenant maintenance for FR-WHK-08 (ADR-0016): SECURITY DEFINER functions owned by the NOLOGIN BYPASSRLS
-- role ingestion_platform, fixed search_path, EXECUTE for svc_ingestion only. No table changes.

GRANT DELETE ON ingestion.webhook_secrets TO ingestion_platform;
GRANT SELECT ON ingestion.webhook_deliveries TO ingestion_platform;

-- Deletes PREVIOUS secrets whose 72 h window has ended. CURRENT secrets are never touched; an expired PREVIOUS no
-- longer verifies anyway (FR-WHK-07), so this is storage hygiene, and an early call only shortens a rotation window.
CREATE FUNCTION ingestion.expire_previous_webhook_secrets(p_now timestamptz) RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH deleted AS (
    DELETE FROM ingestion.webhook_secrets
     WHERE slot = 'PREVIOUS' AND expires_at IS NOT NULL AND expires_at <= p_now
    RETURNING 1)
  SELECT count(*)::integer FROM deleted
$$;
ALTER FUNCTION ingestion.expire_previous_webhook_secrets(timestamptz) OWNER TO ingestion_platform;
REVOKE ALL ON FUNCTION ingestion.expire_previous_webhook_secrets(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.expire_previous_webhook_secrets(timestamptz) TO svc_ingestion;

-- Tenants whose raw webhook prefixes the orphan sweep lists (sources incl. soft-deleted ones: their objects remain).
CREATE FUNCTION ingestion.webhook_source_tenants() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT tenant_id FROM ingestion.webhook_sources ORDER BY 1
$$;
ALTER FUNCTION ingestion.webhook_source_tenants() OWNER TO ingestion_platform;
REVOKE ALL ON FUNCTION ingestion.webhook_source_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.webhook_source_tenants() TO svc_ingestion;

-- Of the given raw object keys, returns those no delivery row references (ix_deliveries_raw_key).
CREATE FUNCTION ingestion.unreferenced_raw_keys(p_keys text[]) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k FROM unnest(p_keys) AS k
   WHERE NOT EXISTS (SELECT 1 FROM ingestion.webhook_deliveries d WHERE d.raw_storage_key = k)
$$;
ALTER FUNCTION ingestion.unreferenced_raw_keys(text[]) OWNER TO ingestion_platform;
REVOKE ALL ON FUNCTION ingestion.unreferenced_raw_keys(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.unreferenced_raw_keys(text[]) TO svc_ingestion;
