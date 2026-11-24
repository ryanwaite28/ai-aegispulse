import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { buildWebhookEnvelope } from "./envelope-builder.js";
import { marketEventV1 } from "./market-event.js";

// The built envelope and payload are checked against the contract JSON Schemas (§6.4, §6.7).
const contracts = fileURLToPath(new URL("../../../../packages/contracts/", import.meta.url));
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
const load = (p: string): Record<string, unknown> =>
  JSON.parse(readFileSync(contracts + p, "utf8")) as Record<string, unknown>;
ajv.addSchema(load("envelope/canonical-envelope.v1.schema.json"));
ajv.addSchema(load("events/_shared.v1.schema.json"));

describe("canonical envelope for webhooks (FR-WHK-04/05)", () => {
  it("maps category → eventType, keeps pointers not bodies, seeds publisher severity, and satisfies the contracts", () => {
    const event = marketEventV1.parse({
      externalId: "reg-2026-1",
      category: "REGULATION_PUBLISHED",
      title: "New disclosure rule",
      body: "x".repeat(10_000),
      publishedAt: "2026-11-24T11:00:00Z",
      severity: "HIGH",
      url: "https://regulator.example/rule",
      mentionedEntities: ["ACME Holdings"],
      unknownExtra: true,
    });
    const deliveryUuid = randomUUID();
    const envelope = buildWebhookEnvelope({
      eventId: "0196f3b2-7c1a-7a3e-9c2d-1b2c3d4e5f60",
      correlationId: `corr-${randomUUID()}`,
      tenantId: randomUUID(),
      sourceKey: "acme-wire",
      deliveryUuid,
      rawStorageKey: `raw/webhooks/t/2026/11/24/${deliveryUuid}.json`,
      rawSha256: "a".repeat(64),
      receivedAt: "2026-11-24T12:00:00.000Z",
      producer: "aegispulse-ingestion@abc1234",
      trustLevel: "TRUSTED",
      event,
    });
    expect(envelope.eventType).toBe("external.regulatory.published");
    expect(envelope.idempotencyKey).toBe("acme-wire:reg-2026-1:v1");
    expect(envelope.source).toBe("webhook:acme-wire");
    expect(envelope.classification).toMatchObject({ publisher_stated_severity: "HIGH", status: "INGESTED" });
    expect(JSON.stringify(envelope)).not.toContain("x".repeat(100)); // the raw body never goes on the bus
    const validEnvelope = ajv.validate(
      "https://aegispulse.dev/contracts/envelope/canonical-envelope.v1.schema.json",
      envelope,
    );
    expect(ajv.errors ?? []).toEqual([]);
    expect(validEnvelope).toBe(true);
    const payloadSchema = load("events/external.regulatory.published.v1.schema.json");
    expect(ajv.validate(payloadSchema, envelope.payload)).toBe(true);
  });

  it("rejects payloads outside AEGIS_MARKET_EVENT_V1", () => {
    const base = { externalId: "x", category: "MARKET_ALERT", title: "t", publishedAt: "2026-11-24T11:00:00Z" };
    expect(marketEventV1.safeParse(base).success).toBe(true);
    for (const bad of [
      { ...base, category: "OTHER" },
      { ...base, url: "http://insecure.example" },
      { ...base, publishedAt: "yesterday" },
      { ...base, mentionedEntities: Array(51).fill("e") },
      { ...base, attachments: Array(6).fill({ url: "https://a.example/f", filename: "f", contentType: "x" }) },
      { ...base, version: 0 },
      { ...base, externalId: "" },
    ]) {
      expect(marketEventV1.safeParse(bad).success).toBe(false);
    }
  });
});
