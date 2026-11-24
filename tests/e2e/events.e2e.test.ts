// FR-EVT-01..05, FR-CLS-01/02 through the gateway against the compose stack (Phase 6 exit items): a signed webhook
// becomes visible via GET /v1/events?correlationId= with its severity lineage; a synthetic card number lands in the
// restricted tier, masked, visible to COMPLIANCE_AUDITOR only; the correlation chain is causal.
import { createHmac, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BASE_URL, call, world } from "./support/world.js";

async function source(token: string): Promise<{ key: string; secret: string }> {
  const key = `e2e-evt-${randomUUID().slice(0, 8)}`;
  const r = await call("POST", "/v1/webhook-sources", { token, body: { sourceKey: key, displayName: "E2E events" } });
  expect(r.status).toBe(201);
  return { key, secret: String(r.body.data?.["signingSecret"]) };
}

async function webhook(
  s: { key: string; secret: string },
  correlationId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const raw = Buffer.from(JSON.stringify(body));
  const ts = String(Math.floor(Date.now() / 1000));
  const deliveryId = `d-${randomUUID()}`;
  const sig = createHmac("sha256", s.secret)
    .update(Buffer.concat([Buffer.from(`${ts}.${deliveryId}.`), raw]))
    .digest("hex");
  const res = await fetch(`${BASE_URL}/webhooks/${s.key}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      "x-aegis-signature": `v1=${sig}`,
      "x-aegis-timestamp": ts,
      "x-aegis-delivery-id": deliveryId,
    },
    body: raw,
  });
  expect(res.status).toBe(202);
}

async function poll<T>(probe: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 60; i++) {
    const v = await probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alert = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  externalId: `e2e-${randomUUID()}`,
  category: "MARKET_ALERT",
  title: "E2E: unusual volume in ACMH",
  publishedAt: new Date().toISOString(),
  severity: "HIGH",
  mentionedEntities: ["ACME Holdings"],
  ...extra,
});

describe("events archive over the gateway (FR-EVT-04/05, Phase 6 exit)", () => {
  it("a webhook is visible via GET /v1/events?correlationId= with severity lineage, and in its causal chain", async () => {
    const w = await world();
    const s = await source(w.a.users.TENANT_ADMIN.token);
    const corr = `corr-${randomUUID()}`;
    await webhook(s, corr, alert());
    const viewer = w.a.users.VIEWER.token;
    const summary = await poll(async () => {
      const r = await call("GET", `/v1/events?correlationId=${corr}&eventType=external.`, { token: viewer });
      return (r.body.data as unknown as Record<string, unknown>[] | undefined)?.[0];
    }, "archived webhook");
    expect(summary).toMatchObject({
      correlationId: corr,
      eventType: "external.market.alert",
      source: `webhook:${s.key}`,
      status: "RULE_SCANNED",
      tier: "standard",
      classification: {
        sensitivity: "CONFIDENTIAL",
        publisher_stated_severity: "HIGH",
        source_trust_level: "UNTRUSTED", // new sources default to UNTRUSTED: the publisher's HIGH does not count
        algorithm_severity: "MEDIUM",
        final_severity: "MEDIUM",
        classification_source: "RULES",
        rule_version: "rules-v1.0.0",
      },
    });
    expect(summary["payload"]).toBeUndefined(); // summaries never carry payloads

    const full = await call("GET", `/v1/events/${String(summary["eventId"])}`, { token: viewer });
    expect(full.status).toBe(200);
    expect(full.body.data).toMatchObject({
      exchange: "aegispulse.ingress",
      routingKey: "external.market.alert",
      pendingAiScan: true,
      payload: { title: "E2E: unusual volume in ACMH" },
    });
    const history = (full.body.data?.["statusHistory"] as unknown as { status: string }[]).map((h) => h.status);
    expect(history).toEqual(["INGESTED", "RULE_SCANNED"]);

    // The Stage-2 request (classification.scan.requested, caused by the webhook) is archived too and follows it.
    const chain = await poll(async () => {
      const r = await call("GET", `/v1/events/correlation/${corr}`, { token: viewer });
      const items = r.body.data as unknown as { eventId: string; eventType: string; causationId: string | null }[];
      return items.length >= 2 ? items : undefined;
    }, "correlation chain");
    expect(chain.map((e) => e.eventType)).toEqual(["external.market.alert", "classification.scan.requested"]);
    expect(chain[1]?.causationId).toBe(summary["eventId"]);
  });

  it("masking demo: a synthetic card number lands in the restricted tier — hidden from VIEWER, masked for COMPLIANCE_AUDITOR", async () => {
    const w = await world();
    const s = await source(w.a.users.TENANT_ADMIN.token);
    const corr = `corr-${randomUUID()}`;
    await webhook(s, corr, alert({ summary: "Client paid with card 4111 1111 1111 1111 yesterday" }));
    const ca = w.a.users.COMPLIANCE_AUDITOR.token;
    const restricted = await poll(async () => {
      const r = await call("GET", `/v1/events?correlationId=${corr}&tier=restricted&eventType=external.`, {
        token: ca,
      });
      return (r.body.data as unknown as Record<string, unknown>[] | undefined)?.[0];
    }, "restricted event");
    expect(restricted).toMatchObject({
      tier: "restricted",
      classification: { sensitivity: "RESTRICTED", categories: ["PII"] },
    });
    const full = await call("GET", `/v1/events/${String(restricted["eventId"])}?tier=restricted`, { token: ca });
    expect(full.body.data?.["payload"]).toMatchObject({ summary: "Client paid with card ************1111 yesterday" });
    expect(full.body.data?.["redactions"]).toEqual([
      { path: "payload.summary", rule: "pii.payment_card", kind: "MASK" },
    ]);
    expect(JSON.stringify(full.body)).not.toContain("4111 1111 1111 1111");

    const viewer = w.a.users.VIEWER.token;
    const standard = await call("GET", `/v1/events?correlationId=${corr}&eventType=external.`, { token: viewer });
    expect(standard.body.data).toEqual([]);
    expect((await call("GET", `/v1/events?tier=restricted`, { token: viewer })).status).toBe(403);
    expect((await call("GET", `/v1/events/${String(restricted["eventId"])}`, { token: viewer })).status).toBe(404);
    // Tenant B never sees tenant A's events.
    expect(
      (
        await call("GET", `/v1/events?correlationId=${corr}&tier=restricted`, {
          token: w.b.users.COMPLIANCE_AUDITOR.token,
        })
      ).body.data,
    ).toEqual([]);
  });
});
