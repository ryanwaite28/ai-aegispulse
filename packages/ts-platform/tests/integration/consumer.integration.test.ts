// FR-MSG-01 / NFR-07 / NFR-10 / NFR-11: the AMQP consumer kit against RabbitMQ 4 with the real contract topology,
// running as a runtime user that cannot declare anything (configure '^$'). Retries go through the real TTL queues.
import { Writable } from "node:stream";
import amqp from "amqplib";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import {
  consumeEnvelopes,
  consumeRaw,
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
import { assertTopology } from "../../../contracts/scripts/topology-assert.js";

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
  for (const q of [
    QUEUE,
    `${QUEUE}.dlq`,
    "events.deadletter.q",
    "events.archive.q",
    `${QUEUE}.retry.1s`,
    `${QUEUE}.retry.5s`,
    `${QUEUE}.retry.30s`,
  ])
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
      "x-aegis-error-message": "PermanentError[NOT_FOUND]: file row missing",
    });
    expect(dead.properties.headers?.["x-aegis-error-stack-hash"]).toMatch(/^[0-9a-f]{16}$/);
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

  it("walks the full 1 s → 5 s → 30 s retry chain with increasing delays, then dead-letters (FR-MSG-01)", async () => {
    const seen: { retryCount: number; at: number }[] = [];
    await start(async (_env, ctx) => {
      seen.push({ retryCount: ctx.retryCount, at: Date.now() });
      throw new TransientError("DEPENDENCY_UNAVAILABLE", "scanner down");
    });
    await publish(sampleEnvelope());
    const dead = await waitFor(() => getOne(`${QUEUE}.dlq`), 60_000);
    expect(seen.map((s) => s.retryCount)).toEqual([0, 1, 2, 3]);
    const gaps = seen.slice(1).map((s, i) => s.at - (seen[i]?.at ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(900);
    expect(gaps[1]).toBeGreaterThanOrEqual(4_500);
    expect(gaps[2]).toBeGreaterThanOrEqual(29_000);
    expect(gaps[0]).toBeLessThan(gaps[1] ?? 0);
    expect(gaps[1]).toBeLessThan(gaps[2] ?? 0);
    expect(dead.properties.headers).toMatchObject({
      "x-aegis-error-code": "DEPENDENCY_UNAVAILABLE",
      "x-aegis-original-queue": QUEUE,
      "x-retry-count": 3,
    });
  }, 90_000);

  it("leaves the original on its queue (requeued, redelivered) when the DLQ republish fails (FR-MSG-01)", async () => {
    // The dead-letter exchange disappears after the client verified the topology: the DLQ copy is never confirmed,
    // so the original must not be acked; it comes back redelivered instead of being lost.
    const deliveries: boolean[] = [];
    await start(async (_env, ctx) => {
      deliveries.push(ctx.redelivered);
      if (deliveries.length === 1) throw new PermanentError("NOT_FOUND", "row missing");
    });
    await adminCh.deleteExchange("aegispulse.dlx");
    try {
      await publish(sampleEnvelope());
      await waitFor(() => (deliveries.length >= 2 ? true : undefined), 30_000);
      expect(deliveries.slice(0, 2)).toEqual([false, true]);
      expect((await depth(`${QUEUE}.dlq`)).ready).toBe(0);
      await waitFor(async () => ((await depth(QUEUE)).ready === 0 ? true : undefined));
    } finally {
      await assertTopology(broker.adminUrl, false); // restores aegispulse.dlx and its bindings
    }
  }, 60_000);

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

describe("consumeRaw (FR-MSG-02 registry consumer) on events.deadletter.q", () => {
  const DLQ_REGISTRY = "events.deadletter.q";

  async function rawClient(): Promise<AegisAmqpClient> {
    const url = await broker.addRuntimeUser({
      name: `svc_events_${String(Date.now())}`,
      write: "^aegispulse\\.(retry|dlx|intelligence)$",
      read: "^events\\.deadletter\\.q$",
    });
    const c = createAmqpClient({ url, service: "events-test", logger, consumes: [DLQ_REGISTRY] });
    await c.init();
    client = c;
    return c;
  }

  async function deadLetter(body: Buffer): Promise<void> {
    adminCh.publish("aegispulse.dlx", QUEUE, body, { contentType: "application/json", persistent: true });
    await adminCh.waitForConfirms();
  }

  it("retries a failing store in process with backoff, holding the delivery: no redelivery, acked once it works", async () => {
    const c = await rawClient();
    const calls: { at: number; redelivered: boolean }[] = [];
    consumeRaw({
      client: c,
      queue: DLQ_REGISTRY,
      logger,
      initialDelayMs: 200,
      maxDelayMs: 400,
      handler: async (d) => {
        calls.push({ at: Date.now(), redelivered: d.redelivered });
        if (calls.length < 4) throw new Error("mongo down");
      },
    });
    await deadLetter(Buffer.from("{not json"));
    await waitFor(() => (calls.length === 4 ? true : undefined));
    expect(calls.map((x) => x.redelivered)).toEqual([false, false, false, false]);
    const gaps = calls.slice(1).map((x, i) => x.at - (calls[i]?.at ?? 0));
    expect(gaps[0]).toBeGreaterThanOrEqual(180); // 200 ms
    expect(gaps[1]).toBeGreaterThanOrEqual(380); // doubled to 400 ms
    expect(gaps[2]).toBeGreaterThanOrEqual(380); // capped at 400 ms
    await waitFor(async () => ((await depth(DLQ_REGISTRY)).ready === 0 ? true : undefined));
  });

  it("requeues the delivery once the hold window is spent (never dead-letters it again)", async () => {
    const c = await rawClient();
    const seen: boolean[] = [];
    consumeRaw({
      client: c,
      queue: DLQ_REGISTRY,
      logger,
      initialDelayMs: 100,
      maxDelayMs: 100,
      maxHoldMs: 250,
      handler: async (d) => {
        seen.push(d.redelivered);
        if (!d.redelivered) throw new Error("mongo down");
      },
    });
    await deadLetter(Buffer.from(JSON.stringify(sampleEnvelope())));
    await waitFor(() => (seen.includes(true) ? true : undefined));
    expect(seen[0]).toBe(false);
    expect(seen.filter((r) => !r).length).toBeGreaterThanOrEqual(2); // retried in process before the requeue
    expect((await depth(`${QUEUE}.dlq`)).ready).toBe(1); // only the original DLQ copy from the dlx binding
    await waitFor(async () => ((await depth(DLQ_REGISTRY)).ready === 0 ? true : undefined));
  });
});
