import { describe, expect, it, vi } from "vitest";
import { parseHeaders, sign, verify, withinSkew, type SignedHeaders } from "./signature.js";

const body = Buffer.from('{"externalId":"x-1","category":"MARKET_ALERT"}');
const now = Date.parse("2026-11-24T12:00:00Z");
const ts = Math.floor(now / 1000);

function headers(signature: string, timestamp = String(ts), deliveryId = "d-1"): SignedHeaders {
  const r = parseHeaders({ signature, timestamp, deliveryId });
  if (!r.ok) throw new Error("unexpected parse failure");
  return r.headers;
}

describe("webhook signatures (FR-WHK-02)", () => {
  it("signs {timestamp}.{deliveryId}.{rawBody} and verifies against CURRENT, then PREVIOUS", () => {
    const sig = sign("prev-secret", ts, "d-1", body);
    expect(sig).toMatch(/^v1=[0-9a-f]{64}$/);
    const secrets = [
      { slot: "CURRENT" as const, secret: "cur-secret" },
      { slot: "PREVIOUS" as const, secret: "prev-secret" },
    ];
    expect(verify(headers(sig), body, secrets)).toBe("PREVIOUS");
    expect(verify(headers(sign("cur-secret", ts, "d-1", body)), body, secrets)).toBe("CURRENT");
    // a different body, delivery id or timestamp breaks the signature
    expect(verify(headers(sig), Buffer.concat([body, Buffer.from(" ")]), secrets)).toBeUndefined();
    expect(verify(headers(sig, String(ts), "d-2"), body, secrets)).toBeUndefined();
    expect(verify(headers(sig, String(ts + 1)), body, secrets)).toBeUndefined();
  });

  it("accepts a comma-separated list during rotation (up to 5) and rejects malformed or missing headers", () => {
    const good = sign("s", ts, "d-1", body);
    const list = `v1=${"0".repeat(64)}, ${good}`;
    expect(verify(headers(list), body, [{ slot: "CURRENT", secret: "s" }])).toBe("CURRENT");
    for (const bad of [
      { signature: undefined, timestamp: String(ts), deliveryId: "d" },
      { signature: good, timestamp: undefined, deliveryId: "d" },
      { signature: good, timestamp: String(ts), deliveryId: undefined },
      { signature: good.slice(0, -2), timestamp: String(ts), deliveryId: "d" }, // truncated
      { signature: good.replace("v1=", "v2="), timestamp: String(ts), deliveryId: "d" },
      { signature: good.toUpperCase(), timestamp: String(ts), deliveryId: "d" },
      { signature: Array(6).fill(good).join(","), timestamp: String(ts), deliveryId: "d" },
      { signature: good, timestamp: "12.5", deliveryId: "d" },
      { signature: good, timestamp: String(ts), deliveryId: "x".repeat(129) },
      { signature: good, timestamp: String(ts), deliveryId: "has space" },
    ]) {
      expect(parseHeaders(bad)).toEqual({ ok: false, reason: "signature" });
    }
  });

  it("compares every signature × secret pair with the constant-time primitive (no early exit)", () => {
    const compare = vi.fn((a: Buffer, b: Buffer) => a.equals(b));
    const secrets = [
      { slot: "CURRENT" as const, secret: "a" },
      { slot: "PREVIOUS" as const, secret: "b" },
    ];
    const h = headers(`${sign("a", ts, "d-1", body)},${sign("b", ts, "d-1", body)},v1=${"f".repeat(64)}`);
    expect(verify(h, body, secrets, compare)).toBe("CURRENT");
    expect(compare).toHaveBeenCalledTimes(6); // 3 signatures × 2 secrets, even though the first pair matched
    for (const [a, b] of compare.mock.calls) expect(a.length).toBe(b.length);
  });

  it("enforces ±300 s skew", () => {
    expect(withinSkew(ts - 300, now)).toBe(true);
    expect(withinSkew(ts + 300, now)).toBe(true);
    expect(withinSkew(ts - 301, now)).toBe(false);
    expect(withinSkew(ts + 301, now)).toBe(false);
  });
});
