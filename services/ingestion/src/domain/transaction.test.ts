import { describe, expect, it } from "vitest";
import { canonicalJson, intakeViolations, requestHash, type TransactionInput } from "./transaction.js";

const NOW = new Date("2026-11-24T12:00:00Z");
const CCY = new Set(["USD", "EUR"]);
const base: TransactionInput = {
  idempotencyKey: "k-1",
  accountId: "acc-1",
  counterpartyId: "cp-1",
  counterpartyName: "Globex Clearing",
  amount: "1250.50",
  currency: "USD",
  country: "US",
  channel: "WIRE",
  occurredAt: "2026-11-24T11:00:00Z",
};

describe("transaction intake rules (FR-TXN-01)", () => {
  it("accepts a valid submission, including up to 24 h future skew", () => {
    expect(intakeViolations(base, NOW, CCY)).toEqual([]);
    expect(intakeViolations({ ...base, occurredAt: "2026-11-25T11:59:59Z" }, NOW, CCY)).toEqual([]);
  });

  it("rejects currencies outside the FX table, > 24 h future skew and metadata over 4 KiB", () => {
    const bad = intakeViolations(
      { ...base, currency: "XYZ", occurredAt: "2026-11-25T12:00:01Z", metadata: { blob: "x".repeat(4100) } },
      NOW,
      CCY,
    );
    expect(bad.map((v) => v.field)).toEqual(["currency", "occurredAt", "metadata"]);
  });

  it("hashes the canonical body: key order does not matter, any value change does", () => {
    const reordered = JSON.parse(
      JSON.stringify({ ...base, metadata: { b: 1, a: [2, { y: 1, x: 2 }] } }),
    ) as TransactionInput;
    const same = { metadata: { a: [2, { x: 2, y: 1 }], b: 1 }, ...base } as TransactionInput;
    expect(requestHash(reordered)).toBe(requestHash(same));
    expect(requestHash({ ...base, amount: "1250.51" })).not.toBe(requestHash(base));
    expect(canonicalJson({ b: 1, a: undefined, c: [3, 1] })).toBe('{"b":1,"c":[3,1]}');
  });
});
