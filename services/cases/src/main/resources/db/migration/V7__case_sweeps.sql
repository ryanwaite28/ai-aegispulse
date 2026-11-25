-- V7: scheduled case sweeps (FR-CASE-02; ADR-0016). Finding due cases is the only cross-tenant read, so each finder is
-- a SECURITY DEFINER function owned by cases_platform returning ids only; every transition then runs under the case
-- tenant's RLS like any other.
GRANT SELECT ON cases.cases, cases.case_evidence TO cases_platform;

-- ENRICHING cases past their enrichment deadline (10 min after open), oldest first.
CREATE FUNCTION cases.enrichment_overdue(p_limit int) RETURNS TABLE (tenant_id uuid, case_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.tenant_id, c.id FROM cases.cases c
   WHERE c.status = 'ENRICHING' AND c.enrichment_deadline <= now()
   ORDER BY c.enrichment_deadline LIMIT p_limit
$$;
ALTER FUNCTION cases.enrichment_overdue(int) OWNER TO cases_platform;
REVOKE ALL ON FUNCTION cases.enrichment_overdue(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases.enrichment_overdue(int) TO svc_cases;

-- CLEARED cases with no change and no new evidence for p_days days (auto-resolve, FR-CASE-02).
CREATE FUNCTION cases.cleared_without_new_evidence(p_days int, p_limit int) RETURNS TABLE (tenant_id uuid, case_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.tenant_id, c.id FROM cases.cases c
   WHERE c.status = 'CLEARED' AND c.updated_at <= now() - make_interval(days => p_days)
     AND NOT EXISTS (SELECT 1 FROM cases.case_evidence e
                      WHERE e.case_id = c.id AND e.created_at > now() - make_interval(days => p_days))
   ORDER BY c.updated_at LIMIT p_limit
$$;
ALTER FUNCTION cases.cleared_without_new_evidence(int, int) OWNER TO cases_platform;
REVOKE ALL ON FUNCTION cases.cleared_without_new_evidence(int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cases.cleared_without_new_evidence(int, int) TO svc_cases;
