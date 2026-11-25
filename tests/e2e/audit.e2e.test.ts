// FR-AUD-02/03 over the gateway against the compose stack: registry events of the test world (user creation) flow
// through cases.audit-ingest.q into the tenant's hash chain; COMPLIANCE_AUDITOR lists and verifies it.
import { describe, expect, it } from "vitest";
import { call, world } from "./support/world.js";

describe("audit log over the gateway (FR-AUD-02/03)", () => {
  it("ingested registry events are listed for the tenant and the chain verifies", async () => {
    const w = await world();
    const token = w.token("COMPLIANCE_AUDITOR");
    let entries: { action: string; subjectType: string; seq: number }[] = [];
    for (let i = 0; i < 60 && entries.length === 0; i++) {
      const r = await call("GET", "/v1/audit?action=REGISTRY_USER_CHANGED&limit=100", { token });
      expect(r.status).toBe(200);
      entries = (r.body.data ?? []) as unknown as typeof entries;
      if (entries.length === 0) await new Promise((res) => setTimeout(res, 500));
    }
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.subjectType === "USER")).toBe(true);
    const seqs = entries.map((e) => e.seq);
    expect([...seqs].sort((a, b) => b - a)).toEqual(seqs); // newest first

    const v = await call("GET", "/v1/audit/verify", { token });
    expect(v.status).toBe(200);
    expect(v.body.data).toMatchObject({ valid: true });
    const checked = (v.body.data as unknown as { checked: number }).checked;
    expect(checked).toBeGreaterThanOrEqual(entries.length);
    const bad = await call("GET", "/v1/audit/verify?fromSeq=zero", { token });
    expect(bad.status).toBe(422);
  });

  it("another tenant's auditor sees only its own chain", async () => {
    const w = await world();
    const a = await call("GET", "/v1/audit?limit=100", { token: w.token("COMPLIANCE_AUDITOR") });
    const b = await call("GET", "/v1/audit?limit=100", { token: w.token("COMPLIANCE_AUDITOR", w.b) });
    const ids = (r: typeof a): string[] => ((r.body.data ?? []) as unknown as { id: string }[]).map((e) => e.id);
    expect(ids(a).filter((id) => ids(b).includes(id))).toEqual([]);
  });
});
