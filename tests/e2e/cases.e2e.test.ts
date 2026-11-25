// FR-CASE-05/06/07 over the gateway against the compose stack, on a case opened by the real saga: an analyst finds
// it, reads detail (policy factors) and timeline, assigns it (optimistic version), notes it, records NEEDS_REVIEW;
// the same analyst cannot close it (four-eyes); a second person (tenant admin) resolves it.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, world } from "./support/world.js";

async function escalatedCase(token: string): Promise<string> {
  const account = `acc-${randomUUID().slice(0, 8)}`;
  let caseId: string | null = null;
  for (let i = 0; i < 6 && caseId === null; i++) {
    const r = await call("POST", "/v1/transactions", {
      token,
      body: {
        idempotencyKey: `e2e-${randomUUID()}`,
        accountId: account,
        counterpartyId: `cp-${randomUUID().slice(0, 8)}`,
        counterpartyName: "E2E Counterparty",
        amount: "60000.00",
        currency: "EUR",
        country: "IR",
        channel: "WIRE",
        occurredAt: new Date().toISOString(),
      },
    });
    const id = (r.body.data as unknown as { transactionId: string }).transactionId;
    for (let j = 0; j < 120; j++) {
      const d = (await call("GET", `/v1/transactions/${id}`, { token })).body.data as unknown as {
        processingStatus: string;
        caseId: string | null;
      };
      if (d.processingStatus !== "ACCEPTED") {
        // velocity grows per transaction: 65, 65, 65, 70 (CLEARED), 75 (ESCALATED) …
        if (d.caseId !== null) {
          const c = (await call("GET", `/v1/cases/${d.caseId}`, { token })).body.data as unknown as { status: string };
          if (c.status === "ESCALATED") caseId = d.caseId;
        }
        break;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
  }
  if (caseId === null) throw new Error("no escalated case after 6 transactions");
  return caseId;
}

describe("case work over the gateway (FR-CASE-05..07)", () => {
  it("find → detail → timeline → assign → note → NEEDS_REVIEW → four-eyes → resolve", async () => {
    const w = await world();
    const analyst = w.token("ANALYST");
    const caseId = await escalatedCase(analyst);

    const listed = await call("GET", "/v1/cases?status=ESCALATED&limit=100", { token: w.token("VIEWER") });
    expect((listed.body.data as unknown as { id: string }[]).map((c) => c.id)).toContain(caseId);
    const detail = await call("GET", `/v1/cases/${caseId}`, { token: analyst });
    const d = detail.body.data as unknown as {
      status: string;
      version: number;
      severity: string;
      caseNumber: string;
      latestPolicyEvaluation: { policyScore: number; outcome: string; factors: { name: string }[] };
    };
    expect(d).toMatchObject({
      status: "ESCALATED",
      severity: "HIGH",
      latestPolicyEvaluation: { outcome: "ESCALATED" },
    });
    expect(d.caseNumber).toMatch(/^AP-\d{4}-\d{6}$/);
    expect(d.latestPolicyEvaluation.factors.map((f) => f.name)).toContain("base_score");
    const timeline = await call("GET", `/v1/cases/${caseId}/timeline`, { token: analyst });
    const t = timeline.body.data as unknown as {
      transitions: { toStatus: string }[];
      evidence: { evidenceType: string }[];
    };
    expect(t.transitions.map((x) => x.toStatus)).toEqual(["OPEN", "ENRICHING", "POLICY_EVALUATED", "ESCALATED"]);
    expect(t.evidence.map((e) => e.evidenceType)).toContain("RISK_EVALUATION");

    const stale = await call("POST", `/v1/cases/${caseId}/assign`, {
      token: analyst,
      body: { assigneeUserId: null, expectedVersion: d.version - 1 },
    });
    expect([stale.status, stale.body.error?.code]).toEqual([409, "CASE_CONFLICT"]);
    const assigned = await call("POST", `/v1/cases/${caseId}/assign`, {
      token: analyst,
      body: { assigneeUserId: null, expectedVersion: d.version },
    });
    expect(assigned.status).toBe(200);
    const note = await call("POST", `/v1/cases/${caseId}/notes`, {
      token: analyst,
      body: { body: "Velocity burst on one account." },
    });
    expect(note.status).toBe(201);

    const rationale = "Burst of high-value wires to a high-risk jurisdiction.";
    const review = await call("POST", `/v1/cases/${caseId}/dispositions`, {
      token: analyst,
      body: { disposition: "NEEDS_REVIEW", rationale },
    });
    expect(review.status).toBe(201);
    const self = await call("POST", `/v1/cases/${caseId}/dispositions`, {
      token: analyst,
      body: { disposition: "TRUE_POSITIVE", rationale },
    });
    expect([self.status, self.body.error?.code]).toEqual([409, "CASE_FOUR_EYES_REQUIRED"]);
    const final = await call("POST", `/v1/cases/${caseId}/dispositions`, {
      token: w.token("TENANT_ADMIN"),
      body: { disposition: "TRUE_POSITIVE", rationale: `${rationale} Confirmed.` },
    });
    expect(final.status).toBe(201);
    expect((final.body.data as unknown as { case: { status: string } }).case.status).toBe("RESOLVED");

    const viewerWrite = await call("POST", `/v1/cases/${caseId}/notes`, {
      token: w.token("VIEWER"),
      body: { body: "x" },
    });
    expect(viewerWrite.status).toBe(403);
    const otherTenant = await call("GET", `/v1/cases/${caseId}`, { token: w.token("ANALYST", w.b) });
    expect(otherTenant.status).toBe(404);
  }, 180_000);
});
