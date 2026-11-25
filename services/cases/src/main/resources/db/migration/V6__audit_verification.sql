-- V6: nightly audit-chain verification (PROJECT.md FR-AUD-03; ADR-0016). The job verifies every tenant's chain from its
-- last verified seq; listing the chains is the only cross-tenant read, so it is one SECURITY DEFINER function owned by
-- the NOLOGIN BYPASSRLS role cases_platform. The per-tenant verification itself runs under the tenant's RLS.
GRANT SELECT ON cases.audit_chain_heads TO cases_platform;

CREATE FUNCTION cases.audit_chains_to_verify() RETURNS TABLE (tenant_id uuid, last_seq bigint, verified_seq bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT h.tenant_id, h.last_seq, h.verified_seq FROM cases.audit_chain_heads h WHERE h.last_seq > h.verified_seq
$$;
ALTER FUNCTION cases.audit_chains_to_verify() OWNER TO cases_platform;
REVOKE ALL ON FUNCTION cases.audit_chains_to_verify() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases.audit_chains_to_verify() TO svc_cases;
