-- V2: enforced RLS bypass (PROJECT.md §7.0, §5.7.2, ADR-0016). Replaces the settable app.bypass_rls convention:
-- policies admit only the current tenant; cross-tenant work happens solely through SECURITY DEFINER functions owned by
-- the NOLOGIN BYPASSRLS role registry_platform, each defined here with a fixed search_path and EXECUTE granted to svc_registry only.
-- Requires registry_platform from the init/bootstrap script (local volumes created before this change: `make reset`).

ALTER POLICY tenant_isolation ON registry.idempotency_records
  USING (tenant_id = registry.current_tenant())
  WITH CHECK (tenant_id = registry.current_tenant());

DROP FUNCTION registry.rls_bypassed();

-- Cross-tenant retention purge of expired Idempotency-Key records (NFR-02, 24 h).
CREATE FUNCTION registry.purge_expired_idempotency_records() RETURNS integer
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  WITH deleted AS (DELETE FROM registry.idempotency_records WHERE expires_at <= now() RETURNING 1)
  SELECT count(*)::integer FROM deleted
$$;
GRANT SELECT, DELETE ON registry.idempotency_records TO registry_platform;
ALTER FUNCTION registry.purge_expired_idempotency_records() OWNER TO registry_platform;
REVOKE ALL ON FUNCTION registry.purge_expired_idempotency_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION registry.purge_expired_idempotency_records() TO svc_registry;
