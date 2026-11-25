// FR-TXN-01 over the gateway against the compose stack: 202 with {transactionId, eventId}; an idempotent repeat returns
// the original; the same key with another body is 409; FX/skew violations are 422; and txn.submitted travels the real
// outbox → broker → events archive on the request's correlation id.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, world } from "./support/world.js";

const txn = (key: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  idempotencyKey: key,
  accountId: "acc-e2e",
  counterpartyId: "cp-e2e",
  counterpartyName: "E2E Counterparty",
  amount: "1250.50",
  currency: "EUR",
  country: "DE",
  channel: "WIRE",
  occurredAt: new Date().toISOString(),
  metadata: { source: "e2e" },
  ...overrides,
});

describe("transaction intake over the gateway (FR-TXN-01)", () => {
  it("202 → idempotent repeat → 409 on a changed body; txn.submitted is archived on the correlation id", async () => {
    const w = await world();
    const token = w.token("ANALYST");
    const correlationId = `corr-${randomUUID()}`;
    const key = `e2e-${randomUUID()}`;
    const body = txn(key);
    const first = await call("POST", "/v1/transactions", {
      token,
      body,
      headers: { "x-correlation-id": correlationId },
    });
    expect(first.status).toBe(202);
    const accepted = first.body.data as unknown as { transactionId: string; eventId: string };
    expect(accepted.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    const repeat = await call("POST", "/v1/transactions", { token, body });
    expect([repeat.status, repeat.body.data]).toEqual([202, accepted]);
    const reused = await call("POST", "/v1/transactions", { token, body: txn(key, { amount: "9.99" }) });
    expect([reused.status, reused.body.error?.code]).toEqual([409, "IDEMPOTENCY_KEY_REUSED"]);

    let archived: Record<string, unknown>[] = [];
    for (let i = 0; i < 60 && archived.length === 0; i++) {
      const r = await call("GET", `/v1/events?correlationId=${correlationId}`, { token });
      archived = ((r.body.data ?? []) as Record<string, unknown>[]).filter((e) => e["eventType"] === "txn.submitted");
      if (archived.length === 0) await new Promise((res) => setTimeout(res, 500));
    }
    expect(archived).toHaveLength(1);
    expect(archived[0]?.["eventId"]).toBe(accepted.eventId);
  });

  it("422 for a currency outside fx-static-v1 or > 24 h future skew; VIEWER is 403", async () => {
    const w = await world();
    const token = w.token("ANALYST");
    const ccy = await call("POST", "/v1/transactions", {
      token,
      body: txn(`e2e-${randomUUID()}`, { currency: "XYZ" }),
    });
    expect([ccy.status, ccy.body.error?.code]).toEqual([422, "VALIDATION_ERROR"]);
    const future = new Date(Date.now() + 25 * 3_600_000).toISOString();
    const skew = await call("POST", "/v1/transactions", {
      token,
      body: txn(`e2e-${randomUUID()}`, { occurredAt: future }),
    });
    expect(skew.status).toBe(422);
    const viewer = await call("POST", "/v1/transactions", {
      token: w.token("VIEWER"),
      body: txn(`e2e-${randomUUID()}`),
    });
    expect(viewer.status).toBe(403);
  });
});
