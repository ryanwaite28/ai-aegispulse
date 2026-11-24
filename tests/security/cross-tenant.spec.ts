// Cross-tenant harness (PROJECT.md §11 FR-AUTH-06, §14): two tenants; every resource of B is invisible to A (404, not
// 403, so ids can't be enumerated). Grows with each phase as new tenant-owned resources appear.
import { describe, expect, it } from "vitest";
import { call, world } from "../e2e/support/world.js";

describe("cross-tenant isolation (FR-AUTH-06, NFR-06)", () => {
  it("Phase 2: tenants, users and service accounts of B read as 404 for A", async () => {
    const w = await world();
    const ta = w.a.users.TENANT_ADMIN.token;
    expect((await call("GET", `/v1/tenants/${w.b.id}`, { token: ta })).status).toBe(404);
    expect((await call("PATCH", `/v1/tenants/${w.b.id}`, { token: ta, body: { retentionDays: 90 } })).status).toBe(404);
    expect((await call("PATCH", `/v1/users/${w.b.adminId}`, { token: ta, body: { displayName: "x" } })).status).toBe(
      404,
    );
    expect((await call("POST", `/v1/service-accounts/${w.b.integration.id}/rotate-secret`, { token: ta })).status).toBe(
      404,
    );
    expect((await call("DELETE", `/v1/service-accounts/${w.b.integration.id}`, { token: ta })).status).toBe(404);

    const users = await call("GET", "/v1/users?limit=100", { token: ta });
    const tenantIds = new Set((users.body.data ?? []).map((u) => String(u["tenantId"])));
    expect([...tenantIds]).toEqual([w.a.id]);
    const accounts = await call("GET", "/v1/service-accounts", { token: ta });
    expect((accounts.body.data ?? []).map((a) => String(a["id"]))).toEqual([w.a.integration.id]);
  });

  it("Phase 2: tenant roles cannot act as another tenant via X-Aegis-Tenant; B's integration secret is useless for A", async () => {
    const w = await world();
    const r = await call("GET", "/v1/users", {
      token: w.a.users.TENANT_ADMIN.token,
      headers: { "x-aegis-tenant": w.b.id },
    });
    expect(r.status).toBe(403);
    const me = await call("GET", "/v1/auth/me", { token: w.b.integration.token });
    expect(me.body.data).toMatchObject({ tenant: { id: w.b.id } });
    expect((await call("GET", `/v1/tenants/${w.a.id}`, { token: w.b.users.TENANT_ADMIN.token })).status).toBe(404);
  });
});
