import { describe, expect, it } from "vitest";
import {
  deadLetterFacts,
  isSameResolution,
  maskedContent,
  plainHeaderValue,
  replayBody,
  replayHeaders,
  replayRefusal,
} from "./dead-letter.js";

const EVENT_ID = "0193a0b2-7c4d-7e8f-9a0b-1c2d3e4f5a6b";
const TENANT = "2b7d3e51-9c4a-4f08-8d1e-5a6b7c8d9e0f";

describe("deadLetterFacts (FR-MSG-02)", () => {
  it("takes ids, tenant, type and error facts from the envelope and the §6.4 DLQ headers", () => {
    const facts = deadLetterFacts({
      content: Buffer.from(JSON.stringify({ eventId: EVENT_ID, tenantId: TENANT, eventType: "file.uploaded" })),
      headers: {
        "x-aegis-original-queue": "files.validation.q",
        "x-aegis-error-code": "NOT_FOUND",
        "x-aegis-error-message": Buffer.from("PermanentError[NOT_FOUND]: gone"),
        "x-aegis-error-stack-hash": "0123456789abcdef",
        "x-retry-count": 3,
        "x-death": [{ time: new Date("2026-11-24T00:00:00Z"), count: 1n }],
      },
      messageId: "ignored",
      routingKey: "files.validation.q",
    });
    expect(facts).toMatchObject({
      tenantId: TENANT,
      eventId: EVENT_ID,
      eventType: "file.uploaded",
      routingKey: "file.uploaded",
      queue: "files.validation.q",
      errorCode: "NOT_FOUND",
      errorMessage: "PermanentError[NOT_FOUND]: gone",
      stackHash: "0123456789abcdef",
      retryCount: 3,
      rawBody: null,
    });
    expect(facts.headers["x-death"]).toEqual([{ time: "2026-11-24T00:00:00.000Z", count: "1" }]);
    expect(facts.bodySha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records poison: raw body, no ids, the DLQ routing key as queue, UNKNOWN when headers are missing", () => {
    const facts = deadLetterFacts({
      content: Buffer.from("{not json"),
      headers: {},
      messageId: EVENT_ID,
      routingKey: "doc.extraction.q",
    });
    expect(facts).toMatchObject({
      eventId: null, // a broker-stamped messageId is not an event id
      tenantId: null,
      envelope: null,
      rawBody: "{not json",
      queue: "doc.extraction.q",
      errorCode: "UNKNOWN",
      errorMessage: "",
      stackHash: null,
      retryCount: 0,
    });
    expect(
      deadLetterFacts({ content: Buffer.from("[1,2]"), headers: {}, messageId: undefined, routingKey: "q" }),
    ).toMatchObject({ envelope: null, rawBody: "[1,2]" });
  });

  it("falls back to the x-aegis-tenant header and ignores malformed ids", () => {
    const facts = deadLetterFacts({
      content: Buffer.from(JSON.stringify({ eventId: "nope", tenantId: "also-nope" })),
      headers: { "x-aegis-tenant": TENANT },
      messageId: undefined,
      routingKey: "q",
    });
    expect(facts).toMatchObject({ eventId: null, tenantId: TENANT });
  });
});

describe("security (FR-MSG-03 review)", () => {
  it("puts the tenant into the identity and flags a queue header that disagrees with the routing key", () => {
    const content = Buffer.from(JSON.stringify({ eventId: EVENT_ID, tenantId: TENANT }));
    const facts = deadLetterFacts({
      content,
      headers: { "x-aegis-original-queue": "cases.audit-ingest.q" },
      messageId: undefined,
      routingKey: "files.validation.q",
    });
    expect(facts).toMatchObject({ queue: "files.validation.q", queueHeaderMismatch: true });
    expect(facts.identityKey).toBe(`${TENANT}|${EVENT_ID}`);
    const poison = deadLetterFacts({ content: Buffer.from("x"), headers: {}, messageId: undefined, routingKey: "q" });
    expect(poison.identityKey).toBe(`-|sha256:${poison.bodySha256}`);
    expect(replayRefusal(facts)).toMatch(/suspect/);
    expect(replayRefusal(poison)).toBeNull();
    expect(replayRefusal({ ...poison, rawBody: "y" })).toMatch(/byte-identical/);
  });

  it("masks card numbers, secrets and PII keys in envelope, raw body, headers and error message", () => {
    const card = ["4111", "1111", "1111", "1111"].join("");
    const m = maskedContent({
      envelope: { payload: { note: `card ${card}`, ssn: "123-45-6789" } },
      rawBody: null,
      headers: { "x-note": `card ${card}` },
      errorMessage: `bad ${card}`,
    });
    expect(JSON.stringify(m)).not.toContain(card);
    expect(m.redactions.map((r) => r.path).sort()).toEqual([
      "envelope.payload.note",
      "envelope.payload.ssn",
      "errorMessage",
      "headers.x-note",
    ]);
  });
});

describe("replay (FR-MSG-03)", () => {
  it("drops DLQ-only and broker headers and resets x-retry-count", () => {
    expect(
      replayHeaders({
        traceparent: "00-a-b-01",
        "x-aegis-tenant": TENANT,
        "x-retry-count": 3,
        "x-aegis-error-code": "X",
        "x-aegis-original-queue": "q",
        "x-aegis-error-message": "m",
        "x-aegis-error-stack-hash": "h",
        "x-death": [],
      }),
    ).toEqual({ traceparent: "00-a-b-01", "x-aegis-tenant": TENANT, "x-retry-count": 0 });
  });

  it("republishes the stored envelope, or the raw body of poison", () => {
    expect(replayBody({ envelope: { a: 1 }, rawBody: null }).toString()).toBe('{"a":1}');
    expect(replayBody({ envelope: null, rawBody: "{not json" }).toString()).toBe("{not json");
  });

  it("treats only the identical resolution as a repeat", () => {
    const r = { status: "DISCARDED" as const, resolvedBy: "user:a", reason: "why" };
    expect(isSameResolution(r, "DISCARDED", "user:a", "why")).toBe(true);
    expect(isSameResolution(r, "DISCARDED", "user:b", "why")).toBe(false);
    expect(isSameResolution(r, "REPLAYED", "user:a", "why")).toBe(false);
  });

  it("bounds header nesting", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 20; i++) deep = { d: deep };
    expect(JSON.stringify(plainHeaderValue(deep))).toContain("null");
  });
});
