// FR-TXN-03/04/05/06 + FR-TEN-08 over the gateway against the compose stack: txn.submitted → orchestrator
// ScoreTransactionSaga → registry (settings, watchlists) → risk-scoring → cases. Scores are deterministic for these
// inputs (§1.4.4): 60,000 EUR = 64,800 USD ≥ 50,000 → amount 40; country IR (default high-risk list) → geo 15; a new
// counterparty each time → 10; the 4th transaction on the account within the hour adds velocity 5 → 70 → case.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, world } from "./support/world.js";

interface Detail {
  processingStatus: string;
  caseId: string | null;
  latestEvaluation: { score: number; band: string; factors: { name: string; contribution: number }[] } | null;
}

async function submit(token: string, account: string, overrides: Record<string, unknown> = {}): Promise<string> {
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
      ...overrides,
    },
  });
  expect(r.status, JSON.stringify(r.body.error)).toBe(202);
  return (r.body.data as unknown as { transactionId: string }).transactionId;
}

async function scored(token: string, transactionId: string): Promise<Detail> {
  for (let i = 0; i < 120; i++) {
    const r = await call("GET", `/v1/transactions/${transactionId}`, { token });
    const d = r.body.data as unknown as Detail;
    if (d.processingStatus !== "ACCEPTED") return d;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`transaction ${transactionId} not scored within 60 s`);
}

describe("ScoreTransactionSaga end to end (FR-TXN-03..06)", () => {
  it("three transactions score 65 (SCORED); the fourth adds velocity and opens a TRANSACTION_RISK case", async () => {
    const w = await world();
    const token = w.token("ANALYST");
    const account = `acc-${randomUUID().slice(0, 8)}`;
    const results: Detail[] = [];
    for (let i = 0; i < 4; i++) results.push(await scored(token, await submit(token, account)));
    expect(results.slice(0, 3).map((d) => [d.processingStatus, d.latestEvaluation?.score])).toEqual([
      ["SCORED", 65],
      ["SCORED", 65],
      ["SCORED", 65],
    ]);
    const fourth = results[3];
    expect(fourth?.processingStatus).toBe("CASE_OPENED");
    expect(fourth?.latestEvaluation).toMatchObject({ score: 70, band: "HIGH" });
    expect(fourth?.caseId).toMatch(/^[0-9a-f-]{36}$/);
    const factors = Object.fromEntries((fourth?.latestEvaluation?.factors ?? []).map((f) => [f.name, f.contribution]));
    expect(factors).toMatchObject({ amount: 40, geo: 15, new_counterparty: 10, velocity: 5, watchlist: 0 });
  });

  it("a tenant settings change reaches scoring within 60 s (FR-TEN-08, settings cache ≤ 60 s)", async () => {
    const w = await world();
    const token = w.token("ANALYST", w.b);
    const before = await scored(token, await submit(token, `acc-${randomUUID().slice(0, 8)}`, { country: "BR" }));
    const geoBefore = before.latestEvaluation?.factors.find((f) => f.name === "geo")?.contribution;
    expect(geoBefore).toBe(0);
    const patch = await call("PATCH", `/v1/tenants/${w.b.id}`, {
      token: w.token("TENANT_ADMIN", w.b),
      body: { highRiskCountries: ["BR"] },
    });
    expect(patch.status, JSON.stringify(patch.body.error)).toBe(200);
    const changedAt = Date.now();
    let geo = 0;
    while (geo === 0) {
      expect(Date.now() - changedAt).toBeLessThan(75_000);
      const d = await scored(token, await submit(token, `acc-${randomUUID().slice(0, 8)}`, { country: "BR" }));
      geo = d.latestEvaluation?.factors.find((f) => f.name === "geo")?.contribution ?? 0;
      if (geo === 0) await new Promise((res) => setTimeout(res, 3_000));
    }
    expect(geo).toBe(15);
    expect(Date.now() - changedAt).toBeLessThanOrEqual(65_000); // ≤ 60 s cache TTL + scoring time
  }, 120_000);
});
