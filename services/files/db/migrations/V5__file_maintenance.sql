-- V5: cross-tenant lookups for the scheduled maintenance actions (FR-FILE-10/12; ADR-0016). SECURITY DEFINER functions
-- owned by the NOLOGIN BYPASSRLS role files_platform, fixed search_path, EXECUTE for svc_files only. They return ids
-- and tenants only; the actual changes run per tenant under RLS. No table changes.

-- FR-FILE-10: INITIATED files created before the cutoff (ix_files_initiated_age), oldest first.
CREATE FUNCTION files.orphan_candidates(p_cutoff timestamptz, p_limit int)
  RETURNS TABLE (file_id uuid, tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT id, tenant_id FROM files.files
   WHERE status = 'INITIATED' AND created_at < p_cutoff
   ORDER BY created_at LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;
ALTER FUNCTION files.orphan_candidates(timestamptz, int) OWNER TO files_platform;
REVOKE ALL ON FUNCTION files.orphan_candidates(timestamptz, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files.orphan_candidates(timestamptz, int) TO svc_files;

-- FR-FILE-12: tenants that still hold unpurged files (each tenant's retentionDays comes from the registry).
CREATE FUNCTION files.retention_tenants() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT DISTINCT tenant_id FROM files.files WHERE purged_at IS NULL ORDER BY 1
$$;
ALTER FUNCTION files.retention_tenants() OWNER TO files_platform;
REVOKE ALL ON FUNCTION files.retention_tenants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION files.retention_tenants() TO svc_files;
