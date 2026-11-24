import { Writable } from "node:stream";
import { context, trace, TraceFlags } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTelemetry, type TelemetryHandle } from "../telemetry/index.js";
import { createLogger, maskEmail, REDACTED, runWithContext } from "./index.js";

function capture(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString("utf8"));
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("createLogger (NFR-07)", () => {
  let telemetry: TelemetryHandle;
  beforeAll(() => {
    telemetry = startTelemetry({ serviceName: "t", serviceVersion: "v", env: "local", exportEnabled: false });
  });
  afterAll(() => telemetry.shutdown());

  it("emits the mandatory fields with context and trace ids", () => {
    const out = capture();
    const log = createLogger({ service: "files", version: "abc123", env: "local", destination: out.stream });
    const spanContext = {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
    };
    context.with(trace.setSpanContext(context.active(), spanContext), () =>
      runWithContext({ correlationId: "corr-1", tenantId: "t-1" }, () =>
        runWithContext({ eventId: "e-1" }, () => log.info({ queue: "files.validation.q" }, "validated")),
      ),
    );
    const [line] = out.lines();
    expect(line).toMatchObject({
      level: "info",
      service: "files",
      version: "abc123",
      env: "local",
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      correlationId: "corr-1",
      tenantId: "t-1",
      eventId: "e-1",
      msg: "validated",
      queue: "files.validation.q",
    });
    expect(typeof line?.["ts"]).toBe("string");
    expect(Number.isNaN(Date.parse(String(line?.["ts"])))).toBe(false);
  });

  it("redacts secrets, credentials and bodies at any of the first three levels", () => {
    const out = capture();
    const log = createLogger({
      service: "ingestion",
      version: "v",
      env: "local",
      destination: out.stream,
      redact: ["webhook.sourceSecret"],
    });
    log.warn(
      {
        password: "p1",
        headers: { authorization: "Bearer abc" },
        req: { body: { clientSecret: "s3" } },
        rawBodyBase64: "e30=",
        webhook: { sourceSecret: "ws", sourceKey: "acme" },
      },
      "attempt",
    );
    const [line] = out.lines();
    const text = JSON.stringify(line);
    for (const leaked of ["p1", "Bearer abc", "s3", "e30=", '"ws"']) expect(text).not.toContain(leaked);
    expect(line?.["password"]).toBe(REDACTED);
    expect((line?.["webhook"] as Record<string, unknown>)["sourceKey"]).toBe("acme");
  });

  it("masks emails", () => {
    expect(maskEmail("jane.doe@example.com")).toBe("j***@example.com");
    expect(maskEmail("not-an-email")).toBe("***");
  });
});
