// Adversarial webhook suite (FR-WHK-02/03, FR-EVAL-04 subset) through the gateway against the compose stack.
// A fresh source is registered per run; every attack must produce its documented code, and a correctly signed
// delivery must be accepted exactly once.
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_URL, call, world } from "../e2e/support/world.js";

interface Sent {
  status: number;
  code: string | undefined;
  body: Record<string, unknown>;
}

function sign(secret: string, ts: string, deliveryId: string, raw: Buffer): string {
  return `v1=${createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${ts}.${deliveryId}.`), raw]))
    .digest("hex")}`;
}

async function send(sourceKey: string, raw: Buffer, headers: Record<string, string>): Promise<Sent> {
  const res = await fetch(`${BASE_URL}/webhooks/${sourceKey}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: raw,
  });
  const text = await res.text();
  const body = (text === "" ? {} : JSON.parse(text)) as Record<string, unknown>;
  return { status: res.status, code: (body["error"] as { code?: string } | undefined)?.code, body };
}

const now = (): string => String(Math.floor(Date.now() / 1000));
const payload = (externalId = `e2e-${randomUUID()}`): Buffer =>
  Buffer.from(
    JSON.stringify({
      externalId,
      category: "MARKET_ALERT",
      title: "E2E alert",
      publishedAt: new Date().toISOString(),
      severity: "MEDIUM",
    }),
  );

async function source(): Promise<{ key: string; secret: string; id: string; token: string }> {
  const w = await world();
  const key = `e2e-whk-${randomUUID().slice(0, 8)}`;
  const r = await call("POST", "/v1/webhook-sources", {
    token: w.a.users.TENANT_ADMIN.token,
    body: { sourceKey: key, displayName: "E2E" },
  });
  expect(r.status).toBe(201);
  return {
    key,
    secret: String(r.body.data?.["signingSecret"]),
    id: String(r.body.data?.["id"]),
    token: w.a.users.TENANT_ADMIN.token,
  };
}

describe("adversarial webhooks over the gateway (FR-WHK-02/03)", () => {
  it("accepts a correctly signed delivery (202) and reports a duplicate externalId as duplicate:true", async () => {
    const s = await source();
    const raw = payload("same-external-id");
    const ts = now();
    const first = await send(s.key, raw, {
      "x-aegis-signature": sign(s.secret, ts, "d-ok-1", raw),
      "x-aegis-timestamp": ts,
      "x-aegis-delivery-id": "d-ok-1",
    });
    expect(first.status).toBe(202);
    expect(first.body["data"]).toMatchObject({ duplicate: false });
    const second = await send(s.key, raw, {
      "x-aegis-signature": sign(s.secret, ts, "d-ok-2", raw),
      "x-aegis-timestamp": ts,
      "x-aegis-delivery-id": "d-ok-2",
    });
    expect(second.status).toBe(202);
    expect(second.body["data"]).toMatchObject({ duplicate: true, eventId: null });
    const deliveries = await call("GET", `/v1/webhook-sources/${s.id}/deliveries`, { token: s.token });
    expect((deliveries.body.data ?? []).map((d) => d["outcome"]).sort()).toEqual(["ACCEPTED", "DUPLICATE"]);
    expect(JSON.stringify(deliveries.body)).not.toContain("E2E alert"); // metadata only, never the raw body
  });

  it("rejects every attack with its documented code", async () => {
    const s = await source();
    const raw = payload();
    const ts = now();
    const good = (id: string): Record<string, string> => ({
      "x-aegis-signature": sign(s.secret, ts, id, raw),
      "x-aegis-timestamp": ts,
      "x-aegis-delivery-id": id,
    });
    const cases: [string, Promise<Sent>, number, string][] = [
      ["unknown source", send("no-such-source-key", raw, good("d1")), 404, "WEBHOOK_SOURCE_NOT_FOUND"],
      [
        "wrong secret",
        send(s.key, raw, { ...good("d2"), "x-aegis-signature": sign("wrong-secret", ts, "d2", raw) }),
        401,
        "WEBHOOK_SIGNATURE_INVALID",
      ],
      [
        "truncated signature",
        send(s.key, raw, { ...good("d3"), "x-aegis-signature": good("d3")["x-aegis-signature"]?.slice(0, -2) ?? "" }),
        401,
        "WEBHOOK_SIGNATURE_INVALID",
      ],
      ["missing headers", send(s.key, raw, {}), 401, "WEBHOOK_SIGNATURE_INVALID"],
      [
        "body tampered after signing",
        send(s.key, Buffer.concat([raw, Buffer.from(" ")]), good("d4")),
        401,
        "WEBHOOK_SIGNATURE_INVALID",
      ],
    ];
    for (const [name, p, status, code] of cases) {
      const r = await p;
      expect({ name, status: r.status, code: r.code }).toEqual({ name, status, code });
    }
    for (const skew of [-301, 301]) {
      // Round away from now so the probe is ≥ 301 s off when signed: flooring the future side could eat up to
      // 0.999 s of the 1 s margin, and request latency then landed it inside the ±300 s window (flaky).
      const nowS = Date.now() / 1000;
      const t = String(skew > 0 ? Math.ceil(nowS + skew) : Math.floor(nowS + skew));
      const r = await send(s.key, raw, {
        "x-aegis-signature": sign(s.secret, t, `d-skew${String(skew)}`, raw),
        "x-aegis-timestamp": t,
        "x-aegis-delivery-id": `d-skew${String(skew)}`,
      });
      expect({ skew, status: r.status, code: r.code }).toEqual({ skew, status: 401, code: "WEBHOOK_TIMESTAMP_SKEW" });
    }
    const replay = good("d-replay");
    expect((await send(s.key, raw, replay)).status).toBe(202);
    expect(await send(s.key, raw, replay)).toMatchObject({ status: 409, code: "WEBHOOK_REPLAY_DETECTED" });
    const malformed = Buffer.from("{not json");
    const m = await send(s.key, malformed, {
      "x-aegis-signature": sign(s.secret, ts, "d-mal", malformed),
      "x-aegis-timestamp": ts,
      "x-aegis-delivery-id": "d-mal",
    });
    expect(m).toMatchObject({ status: 422, code: "VALIDATION_ERROR" }); // only after the signature verified
    const unsignedMalformed = await send(s.key, malformed, {
      "x-aegis-signature": `v1=${"0".repeat(64)}`,
      "x-aegis-timestamp": ts,
      "x-aegis-delivery-id": "d-mal2",
    });
    expect(unsignedMalformed.code).toBe("WEBHOOK_SIGNATURE_INVALID"); // never 422 before the signature
    const oversize = Buffer.alloc(1024 * 1024 + 1, 0x20);
    expect((await send(s.key, oversize, good("d-big"))).status).toBe(413);
  });

  it("a disabled source stops accepting deliveries", async () => {
    const s = await source();
    await call("PATCH", `/v1/webhook-sources/${s.id}`, { token: s.token, body: { status: "DISABLED" } });
    const raw = payload();
    const ts = now();
    const r = await send(s.key, raw, {
      "x-aegis-signature": sign(s.secret, ts, "d-dis", raw),
      "x-aegis-timestamp": ts,
      "x-aegis-delivery-id": "d-dis",
    });
    expect(r).toMatchObject({ status: 404, code: "WEBHOOK_SOURCE_NOT_FOUND" });
  });
});
