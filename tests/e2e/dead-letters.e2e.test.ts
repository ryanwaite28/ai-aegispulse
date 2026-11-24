// FR-MSG-03 over the gateway against the compose stack: /v1/ops/dead-letters* reach the events registry with the
// contract roles; PLATFORM_ADMIN lists every tenant, TENANT_ADMIN the own tenant; unknown ids are 404
// DEAD_LETTER_NOT_FOUND; discard needs a reason. The full failure → registry → replay flow is the Phase 7 exit demo
// (scripts/demo/dlq-demo.sh, docs/evidence/phase-07.md) and the events integration suite.
import { describe, expect, it } from "vitest";
import { call, world, type Reply } from "./support/world.js";

const UNKNOWN = "000000000000000000000000";
const tenantIds = (r: Reply): (string | null)[] =>
  (r.body.data ?? []).map((d: Record<string, unknown>) => (typeof d["tenantId"] === "string" ? d["tenantId"] : null));

describe("dead-letter admin API over the gateway (FR-MSG-03)", () => {
  it("PLATFORM_ADMIN lists all tenants (no X-Aegis-Tenant needed) and may narrow to one", async () => {
    const w = await world();
    const all = await call("GET", "/v1/ops/dead-letters?limit=5", { token: w.token("PLATFORM_ADMIN") });
    expect(all.status).toBe(200);
    expect(Array.isArray(all.body.data)).toBe(true);
    const narrowed = await call("GET", "/v1/ops/dead-letters", {
      token: w.token("PLATFORM_ADMIN"),
      headers: { "x-aegis-tenant": w.a.id },
    });
    expect(narrowed.status).toBe(200);
    for (const t of tenantIds(narrowed)) expect(t).toBe(w.a.id);
  });

  it("TENANT_ADMIN sees the own tenant only and may not name another tenant", async () => {
    const w = await world();
    const own = await call("GET", "/v1/ops/dead-letters", { token: w.token("TENANT_ADMIN") });
    expect(own.status).toBe(200);
    for (const t of tenantIds(own)) expect(t).toBe(w.a.id);
    const other = await call("GET", "/v1/ops/dead-letters", {
      token: w.token("TENANT_ADMIN"),
      headers: { "x-aegis-tenant": w.b.id },
    });
    expect(other.status).toBe(403);
  });

  it("unknown ids are 404 DEAD_LETTER_NOT_FOUND; discard without a reason is 422; filters are validated", async () => {
    const w = await world();
    const token = w.token("PLATFORM_ADMIN");
    const missing = await call("GET", `/v1/ops/dead-letters/${UNKNOWN}`, { token });
    expect([missing.status, missing.body.error?.code]).toEqual([404, "DEAD_LETTER_NOT_FOUND"]);
    const replay = await call("POST", `/v1/ops/dead-letters/${UNKNOWN}/replay`, { token, body: {} });
    expect([replay.status, replay.body.error?.code]).toEqual([404, "DEAD_LETTER_NOT_FOUND"]);
    const discard = await call("POST", `/v1/ops/dead-letters/${UNKNOWN}/discard`, { token, body: {} });
    expect(discard.status).toBe(422);
    const badDate = await call("GET", "/v1/ops/dead-letters?from=yesterday", { token });
    expect(badDate.status).toBe(422);
  });
});
