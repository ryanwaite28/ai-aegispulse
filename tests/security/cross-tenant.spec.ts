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

  it("Phase 3: entities and watchlists of B read as 404 for A and never leak into A's lists", async () => {
    const w = await world();
    const b = w.b.users.ANALYST.token;
    const entity = await call("POST", "/v1/entities", {
      token: b,
      body: { name: "Globex Clearing", entityType: "COUNTERPARTY" },
    });
    expect(entity.status).toBe(201);
    const entityId = String(entity.body.data?.["id"]);
    const wl = await call("POST", "/v1/watchlists", { token: b, body: { name: "B Watch", reason: "x" } });
    const wlId = String(wl.body.data?.["id"]);
    expect((await call("POST", `/v1/watchlists/${wlId}/entries`, { token: b, body: { entityId } })).status).toBe(201);

    const a = w.a.users.TENANT_ADMIN.token;
    expect((await call("GET", `/v1/entities/${entityId}`, { token: a })).status).toBe(404);
    expect((await call("PATCH", `/v1/entities/${entityId}`, { token: a, body: { country: "US" } })).status).toBe(404);
    expect((await call("DELETE", `/v1/entities/${entityId}`, { token: a })).status).toBe(404);
    expect((await call("PATCH", `/v1/watchlists/${wlId}`, { token: a, body: { name: "x" } })).status).toBe(404);
    expect((await call("POST", `/v1/watchlists/${wlId}/entries`, { token: a, body: { entityId } })).status).toBe(404);
    expect((await call("DELETE", `/v1/watchlists/${wlId}/entries/${entityId}`, { token: a })).status).toBe(404);
    expect((await call("DELETE", `/v1/watchlists/${wlId}`, { token: a })).status).toBe(404);
    const search = await call("GET", "/v1/entities?q=globex%20clearing", { token: a });
    expect(search.body.data ?? []).toHaveLength(0);
    expect((await call("GET", "/v1/watchlists", { token: a })).body.data ?? []).toHaveLength(0);
  });

  it("Phase 4: webhook sources of B read as 404 for A; the secret is never listed", async () => {
    const w = await world();
    const run = Math.random().toString(36).slice(2, 8);
    const created = await call("POST", "/v1/webhook-sources", {
      token: w.b.users.TENANT_ADMIN.token,
      body: { sourceKey: `e2e-${run}-b`, displayName: "B feed" },
    });
    expect(created.status).toBe(201);
    const id = String(created.body.data?.["id"]);
    const secret = String(created.body.data?.["signingSecret"]);
    const a = w.a.users.TENANT_ADMIN.token;
    expect((await call("PATCH", `/v1/webhook-sources/${id}`, { token: a, body: { displayName: "x" } })).status).toBe(
      404,
    );
    expect((await call("POST", `/v1/webhook-sources/${id}/rotate-secret`, { token: a })).status).toBe(404);
    expect((await call("DELETE", `/v1/webhook-sources/${id}`, { token: a })).status).toBe(404);
    expect((await call("GET", "/v1/webhook-sources", { token: a })).body.data ?? []).toHaveLength(0);
    const own = await call("GET", "/v1/webhook-sources", { token: w.b.users.TENANT_ADMIN.token });
    expect(JSON.stringify(own.body)).not.toContain(secret);
    const taken = await call("POST", "/v1/webhook-sources", {
      token: a,
      body: { sourceKey: `e2e-${run}-b`, displayName: "dup" },
    });
    expect(taken.body.error?.code).toBe("WEBHOOK_SOURCE_KEY_TAKEN");
  });
});
