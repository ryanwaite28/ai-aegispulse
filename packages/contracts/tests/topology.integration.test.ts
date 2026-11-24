// Real RabbitMQ 4 via Testcontainers (no broker mocks — PROJECT.md §12 rule 10).
import { RabbitMQContainer, type StartedRabbitMQContainer } from "@testcontainers/rabbitmq";
import amqp from "amqplib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertTopology } from "../scripts/topology-assert.js";
import { loadTopology } from "../src/topology.js";

describe("topology-assert against RabbitMQ 4 (FR-MSG-01, ADR-0003)", () => {
  let broker: StartedRabbitMQContainer;
  let url: string;

  beforeAll(async () => {
    broker = await new RabbitMQContainer("rabbitmq:4.4.1-management-alpine").start();
    url = broker.getAmqpUrl();
  }, 180_000);

  afterAll(async () => {
    await broker?.stop();
  });

  it("asserts the full topology, and re-asserting is idempotent", async () => {
    const first = await assertTopology(url, false);
    const second = await assertTopology(url, false);
    const t = loadTopology();
    expect(first).toEqual({ exchanges: t.exchanges.length, queues: t.queues.length, bindings: t.bindings.length });
    expect(second).toEqual(first);
    await expect(assertTopology(url, true)).resolves.toEqual(first);
  });

  it("routes a published event to its consumer queue and the archive queue", async () => {
    const conn = await amqp.connect(url);
    const ch = await conn.createConfirmChannel();
    ch.publish("aegispulse.ingress", "txn.submitted", Buffer.from("{}"), { persistent: true, messageId: "probe" });
    await ch.waitForConfirms();
    const txn = await ch.checkQueue("orchestrator.txn.q");
    const archive = await ch.checkQueue("events.archive.q");
    expect(txn.messageCount).toBe(1);
    expect(archive.messageCount).toBe(1);
    await conn.close();
  });

  it("dead-letters to both the DLQ and the registry queue via the topic dlx", async () => {
    const conn = await amqp.connect(url);
    const ch = await conn.createConfirmChannel();
    ch.publish("aegispulse.dlx", "files.validation.q", Buffer.from("{}"), { persistent: true });
    await ch.waitForConfirms();
    expect((await ch.checkQueue("files.validation.q.dlq")).messageCount).toBe(1);
    expect((await ch.checkQueue("events.deadletter.q")).messageCount).toBe(1);
    await conn.close();
  });

  it("rejects a conflicting redeclaration (drift detection)", async () => {
    const conn = await amqp.connect(url);
    const ch = await conn.createChannel();
    ch.on("error", () => undefined);
    await expect(
      ch.assertQueue("orchestrator.txn.q", { durable: true, arguments: { "x-queue-type": "classic" } }),
    ).rejects.toThrow(/PRECONDITION_FAILED/);
    await conn.close().catch(() => undefined);
  });
});
