import { context, trace } from "@opentelemetry/api";
import { describe, expect, it } from "vitest";
import { extractTraceContext, injectTraceHeaders, startTelemetry, withSpan } from "./index.js";

describe("telemetry propagation (NFR-07: traceparent in AMQP headers)", () => {
  it("round-trips W3C trace context through message headers", async () => {
    const handle = startTelemetry({ serviceName: "t", serviceVersion: "v", env: "local", exportEnabled: false });
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const incoming = { traceparent, "x-retry-count": 1 };
    const ctx = extractTraceContext(incoming);
    expect(trace.getSpanContext(ctx)?.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");

    const outgoing: Record<string, unknown> = {};
    context.with(ctx, () => injectTraceHeaders(outgoing));
    expect(outgoing["traceparent"]).toBe(traceparent);

    // Buffers (as amqplib may deliver header values) are accepted too.
    expect(trace.getSpanContext(extractTraceContext({ traceparent: Buffer.from(traceparent) }))?.spanId).toBe(
      "00f067aa0ba902b7",
    );
    expect(trace.getSpanContext(extractTraceContext(undefined))).toBeUndefined();
    await handle.shutdown();
  });

  it("withSpan returns the result and rethrows failures", async () => {
    await expect(withSpan("ok", {}, async () => 7)).resolves.toBe(7);
    await expect(
      withSpan("fail", {}, async () => {
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
  });
});
