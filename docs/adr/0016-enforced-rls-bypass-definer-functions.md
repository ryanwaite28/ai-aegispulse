# ADR-0016 — Enforced RLS bypass: cross-tenant work only through SECURITY DEFINER functions

- **Status:** Accepted
- **Date:** 2026-11-23
- **Deciders:** Ryan M. Waite
- **PROJECT.md sections affected:** §5.7.2, §7.0, §11 (Phase 1 data foundations)
- **Related FR/NFR:** NFR-06, NFR-02, NFR-08; amends the RLS pattern from ADR-0005 / Phase 1a

## Context
Phase 1a's RLS policies read `tenant_id = {schema}.current_tenant() OR {schema}.rls_bypassed()`, where `rls_bypassed()` checks the session setting `app.bypass_rls`. Any `svc_*` session can set that setting (`set_config` needs no privilege), so the bypass was a coding convention only. One buggy or injected statement on a request path could read or write across tenants, and the policy would never catch it. NFR-06 requires tenant isolation enforced by RLS, not by discipline.

Some work is legitimately cross-tenant (retention purges, scheduled sweeps, lookups that resolve the tenant, such as webhook source by key). It needs a bypass that service code can use but cannot widen.

## Decision
We will:
1. Remove every bypass clause. Tenant policies are `USING/WITH CHECK (tenant_id = {schema}.current_tenant())`, and `rls_bypassed()` is dropped (V2 migration per schema). No session setting can lift RLS.
2. Create one `NOLOGIN BYPASSRLS` role per schema, `{schema}_platform`, in the database init/bootstrap script (superuser-only).
   - `mig_{schema}` is a member `WITH INHERIT FALSE, SET TRUE`, so it can assign ownership but inherits nothing.
   - The role holds `USAGE, CREATE` on its schema, plus only the table privileges its functions need.
3. Express each cross-tenant operation as a `SECURITY DEFINER` function in a reviewed migration.
   - It has fixed SQL and `SET search_path = pg_catalog, pg_temp`, and is owned by `{schema}_platform`.
   - `EXECUTE` is revoked from PUBLIC and granted to `svc_{schema}` only.
   - The first function is `{schema}.purge_expired_idempotency_records()`. Later FRs add theirs in their own migrations, e.g. webhook-source lookup by key (FR-WHK) and the retention sweeps.
4. Platform kits drop their bypass helpers (TS `withPlatformTransaction`, Java `TenantScope.bypassForPlatformJob`). Repositories call the functions.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A (chosen): SECURITY DEFINER functions owned by a NOLOGIN BYPASSRLS role | Bypass is limited to named, reviewed operations with fixed SQL. Service code cannot widen it. Grants and owners are auditable in the catalog and the migration test asserts them. | One small function per cross-tenant operation. Needs a superuser step in bootstrap. |
| B: separate login role `svc_{schema}_jobs` with a policy clause on `current_user` | Simple, and the job code path is ordinary SQL | The service process holds both credentials. The job role bypasses for any statement, so least privilege is weaker. |
| C: keep the session setting, add audit logging and a CI grep gate | Cheapest | RLS stays bypassable by any session, so NFR-06 isn't actually enforced |

## Consequences
- Positive: tenant isolation holds even against SQL bugs on request paths. Every cross-tenant capability is visible in `pg_proc` and in code review.
- Negative / accepted risks:
  - Local volumes created before this change must be recreated (`make reset`), because V2 needs the `{schema}_platform` roles. No shared environment existed yet.
  - `mig_{schema}` can `SET ROLE {schema}_platform`. It already owns the schema and runs only in migration Jobs, so this adds no meaningful power.
- Follow-up work (with phase):
  - Phase 9: the cluster Postgres bootstrap must create the same roles (it reuses the init script logic).
  - Every FR that needs cross-tenant access adds its function in its V-migration and a migration test.

## Verification
- `tests/migrations/postgres.integration.test.ts`:
  - setting `app.bypass_rls` as `svc_cases` changes nothing, and `rls_bypassed()` no longer exists;
  - each purge function is SECURITY DEFINER, owned by a NOLOGIN BYPASSRLS `{schema}_platform`, executable by its own `svc_*` only;
  - `SET ROLE {schema}_platform` is denied.
- The ts-platform and java-platform integration suites show that RLS ignores the old setting and that the definer function purges across tenants.
