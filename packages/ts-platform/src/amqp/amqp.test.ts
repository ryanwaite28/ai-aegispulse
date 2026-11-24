import { describe, expect, it } from "vitest";
import { PermanentError, PoisonMessageError, TransientError, classifyFailure } from "../errors/index.js";
import { sampleEnvelope } from "../../tests/fixtures.js";
import { failureRoute, parseEnvelope, queuePolicy } from "./index.js";

describe("queuePolicy (read from the topology contract)", () => {
  it("exposes prefetch, retry tiers and DLQ presence", () => {
    expect(queuePolicy("files.validation.q")).toEqual({
      queue: "files.validation.q",
      prefetch: 4,
      retryTiers: ["1s", "5s", "30s"],
      deadLetter: true,
    });
    expect(queuePolicy("doc.extraction.q").retryTiers).toEqual(["5s", "30s", "30s"]);
    expect(queuePolicy("events.deadletter.q")).toMatchObject({ retryTiers: [], deadLetter: false });
  });
});

describe("failureRoute (FR-MSG-01)", () => {
  const files = queuePolicy("files.validation.q");
  const transient = classifyFailure(new TransientError("DEPENDENCY_UNAVAILABLE", "x"));

  it("retries TRANSIENT through the tier ladder, then dead-letters", () => {
    expect(failureRoute(files, 0, transient)).toEqual({ action: "retry", routingKey: "files.validation.q.retry.1s" });
    expect(failureRoute(files, 1, transient)).toEqual({ action: "retry", routingKey: "files.validation.q.retry.5s" });
    expect(failureRoute(files, 2, transient)).toEqual({ action: "retry", routingKey: "files.validation.q.retry.30s" });
    expect(failureRoute(files, 3, transient)).toEqual({ action: "dead_letter" });
    expect(failureRoute(queuePolicy("doc.extraction.q"), 0, transient)).toEqual({
      action: "retry",
      routingKey: "doc.extraction.q.retry.5s",
    });
  });

  it("dead-letters PERMANENT and POISON immediately", () => {
    expect(failureRoute(files, 0, classifyFailure(new PermanentError("NOT_FOUND", "x")))).toEqual({
      action: "dead_letter",
    });
    expect(failureRoute(files, 0, classifyFailure(new PoisonMessageError("ENVELOPE_INVALID", "x")))).toEqual({
      action: "dead_letter",
    });
  });

  it("requeues on queues without a DLQ (no dead-letter loop on events.deadletter.q)", () => {
    expect(failureRoute(queuePolicy("events.deadletter.q"), 0, transient)).toEqual({ action: "requeue" });
  });
});

describe("parseEnvelope (FR-EVT-01 poison detection)", () => {
  it("accepts a valid 1.x envelope", () => {
    const env = sampleEnvelope();
    expect(parseEnvelope(Buffer.from(JSON.stringify(env)))).toEqual(env);
  });

  it.each([
    ["non-JSON", Buffer.from("{not json")],
    ["unknown major version", Buffer.from(JSON.stringify(sampleEnvelope({ schemaVersion: "2.0.0" })))],
    ["missing eventId", Buffer.from(JSON.stringify({ ...sampleEnvelope(), eventId: undefined }))],
    ["extra envelope field", Buffer.from(JSON.stringify(sampleEnvelope({ rogue: true })))],
  ])("rejects %s as POISON / ENVELOPE_INVALID", (_label, body) => {
    const error = (() => {
      try {
        parseEnvelope(body);
      } catch (e: unknown) {
        return e;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(PoisonMessageError);
    expect(error).toMatchObject({ code: "ENVELOPE_INVALID" });
  });
});
