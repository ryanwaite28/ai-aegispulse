-- V2: enforced RLS bypass (PROJECT.md §7.0, §5.7.2, ADR-0016). Replaces the settable app.bypass_rls convention:
-- policies admit only the current tenant; cross-tenant work happens solely through SECURITY DEFINER functions owned by
-- the NOLOGIN BYPASSRLS role analytics_platform, each defined here with a fixed search_path and EXECUTE granted to svc_analytics only.
-- Requires analytics_platform from the init/bootstrap script (local volumes created before this change: `make reset`).

-- No tenant-scoped table exists in analytics yet; drop the settable bypass helper so later policies cannot use it.
DROP FUNCTION analytics.rls_bypassed();
