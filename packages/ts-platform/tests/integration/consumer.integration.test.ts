// FR-MSG-01 / NFR-07 / NFR-10 / NFR-11: the AMQP consumer kit against RabbitMQ 4 with the real contract topology,
// running as a runtime user that cannot declare anything (configure '^$'). Retries go through the real TTL queues.
import { Writable } from "node:stream";
import amqp from "amqplib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import {
  consumeEnvelopes,
  createAmqpClient,
  type AegisAmqpClient,
  type DeliveryContext,
  type EnvelopeHandler,
} from "../../src/amqp/index.js";
import { PermanentError, TransientError } from "../../src/errors/index.js";
import { createLogger, getContext } from "../../src/logging/index.js";
import { startTelemetry, type TelemetryHandle } from "../../src/telemetry/index.js";
import { trace, context as otelContext } from "@opentelemetry/api";
import { sampleEnvelope } from "../fixtures.js";
import { startBroker, type BrokerEnv } from "./env.js";

const QUEUE = "files.validation.q";
const logger = createLogger({
  service: "files",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

let broker: BrokerEnv;
let runtimeUrl: string;
let telemetry: TelemetryHandle;
let admin: amqp.ChannelModel;
let adminCh: amqp.ConfirmChannel;
let client: AegisAmqpClient | undefined;

beforeAll(async () => {
  telemetry = startTelemetry({ serviceName: "files", serviceVersion: "test", env: "local", exportEnabled: false });
  broker = await startBroker();
  // §5.7.3-style runtime user for files: consume its queue, publish to retry/DLX (and its own exchanges).
  runtimeUrl = await broker.addRuntimeUser({
    name: "svc_files",
    write: "^aegispulse\\.(retry|dlx|enrichment)$",
    read: `^${QUEUE.replaceAll(".", "\\.")}$`,
  });
  admin = await amqp.connect(broker.adminUrl);
  adminCh = await admin.createConfirmChannel();
}, 300_000);

afterEach(async () => {
  await client?.close({ drainTimeoutMs: 2000 });
  client = undefined;
  for (const q of [QUEUE, `${QUEUE}.dlq`, "events.deadletter.q", "events.archive.q", `${QUEUE}.retry.1s`])
    await adminCh.purgeQueue(q);
});

afterAll(async () => {
  await admin?.close();
  await broker?.stop();
  await telemetry?.shutdown();
});

async function publish(body: Buffer | CanonicalEnvelope, headers: Record<string, unknown> = {}): Promise<void> {
  const content = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  adminCh.publish("aegispulse.ingress", "file.uploaded", content, {
    contentType: "application/json",
    persistent: true,
    headers,
  });
  await adminCh.waitForConfirms();
}

async function start(handler: EnvelopeHandler): Promise<AegisAmqpClient> {
  const c = createAmqpClient({ url: runtimeUrl, service: "files-test", logger, consumes: [QUEUE] });
  await c.init();
  consumeEnvelopes({ client: c, queue: QUEUE, logger, handler });
  client = c;
  return c;
}

async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function getOne(queue: string): Promise<amqp.GetMessage | undefined> {
  const m = await adminCh.get(queue, { noAck: true });
  return m === false ? undefined : m;
}

async function depth(queue: string): Promise<{ ready: number; consumers: number }> {
  const q = await adminCh.checkQueue(queue);
  return { ready: q.messageCount, consumers: q.consumerCount };
}

describe("consumeEnvelopes (FR-MSG-01) as a configure-'^$' runtime user", () => {
  it("delivers a valid envelope with log/trace context and acks it", async () => {
    const envelope = sampleEnvelope();
    const seen: { ctx?: DeliveryContext; log?: ReturnType<typeof getContext>; traceId?: string | undefined } = {};
    await start(async (_env, ctx) => {
      seen.ctx = ctx;
      seen.log = getContext();
      seen.traceId = trace.getSpanContext(otelContext.active())?.traceId;
    });
    await publish(envelope, { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" });
    await waitFor(() => seen.ctx);
    expect(seen.ctx).toMatchObject({ queue: QUEUE, retryCount: 0, replayGeneration: 0, redelivered: false });
    expect(seen.log).toMatchObject({
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      tenantId: envelope.tenantId,
    });
    expect(seen.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736"); // continued the producer's trace
    await waitFor(async () => ((await depth(QUEUE)).ready === 0 ? true : undefined));
  });

  it("retries a TRANSIENT failure through the real 1 s TTL queue with x-retry-count, then succeeds", async () => {
    const calls: number[] = [];
    await start(async (_env, ctx) => {
      calls.push(ctx.retryCount);
      if (ctx.retryCount === 0) throw new TransientError("DEPENDENCY_UNAVAILABLE", "scanner down");
    });
    const started = Date.now();
    await publish(sampleEnvelope());
    await waitFor(() => (calls.length === 2 ? true : undefined), 15_000);
    expect(calls).toEqual([0, 1]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // came back through the 1 s TTL retry queue
    expect((await depth(`${QUEUE}.dlq`)).ready).toBe(0);
  });

  it("dead-letters PERMANENT failures immediately with error headers (DLQ + registry queue)", async () => {
    let calls = 0;
    await start(async () => {
      calls++;
      throw new PermanentError("NOT_FOUND", "file row missing");
    });
    const envelope = sampleEnvelope();
    await publish(envelope);
    const dead = await waitFor(() => getOne(`${QUEUE}.dlq`));
    expect(calls).toBe(1);
    expect(dead.properties.headers).toMatchObject({
      "x-aegis-error-code": "NOT_FOUND",
      "x-aegis-original-queue": QUEUE,
    });
    expect((JSON.parse(dead.content.toString()) as { eventId: string }).eventId).toBe(envelope.eventId);
    expect(await waitFor(() => getOne("events.deadletter.q"))).toBeDefined();
  });

  it("dead-letters poison (non-JSON and schema-invalid) as ENVELOPE_INVALID without calling the handler", async () => {
    let calls = 0;
    await start(async () => {
      calls++;
    });
    await publish(Buffer.from("{not json"));
    await publish(sampleEnvelope({ schemaVersion: "2.0.0" }));
    const a = await waitFor(() => getOne(`${QUEUE}.dlq`));
    const b = await waitFor(() => getOne(`${QUEUE}.dlq`));
    expect([a.properties.headers?.["x-aegis-error-code"], b.properties.headers?.["x-aegis-error-code"]]).toEqual([
      "ENVELOPE_INVALID",
      "ENVELOPE_INVALID",
    ]);
    expect(calls).toBe(0);
  });

  it("dead-letters a TRANSIENT failure once the retry budget is spent", async () => {
    await start(async () => {
      throw new TransientError("DEPENDENCY_UNAVAILABLE", "still down");
    });
    await publish(sampleEnvelope(), { "x-retry-count": 3 });
    const dead = await waitFor(() => getOne(`${QUEUE}.dlq`));
    expect(dead.properties.headers).toMatchObject({
      "x-aegis-error-code": "DEPENDENCY_UNAVAILABLE",
      "x-retry-count": 3,
    });
  });

  it("passes replay headers to the handler for dedup (NFR-02)", async () => {
    let ctx: DeliveryContext | undefined;
    await start(async (_e, c) => {
      ctx = c;
      return "duplicate";
    });
    await publish(sampleEnvelope(), { "x-aegis-replay-job": "job-1", "x-aegis-replay-generation": 2 });
    await waitFor(() => ctx);
    expect(ctx).toMatchObject({ replayJob: "job-1", replayGeneration: 2 });
    await waitFor(async () => ((await depth(QUEUE)).ready === 0 ? true : undefined));
  });

  it("close() cancels the consumer, waits for the in-flight handler, and the message is acked not redelivered (NFR-11)", async () => {
    let finished = false;
    let startedHandling = false;
    const c = await start(async () => {
      startedHandling = true;
      await new Promise((r) => setTimeout(r, 700));
      finished = true;
    });
    await publish(sampleEnvelope());
    await waitFor(() => (startedHandling ? true : undefined));
    await c.close({ drainTimeoutMs: 5000 });
    client = undefined;
    expect(finished).toBe(true);
    expect(c.state).toBe("closed");
    expect(await depth(QUEUE)).toEqual({ ready: 0, consumers: 0 });
  });
});
