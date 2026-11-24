// FR-EVT-01..03, FR-CLS-01/02 against real MongoDB 8 (single-node replica set, baseline migration with validators +
// indexes) and RabbitMQ 4 (contract topology; events runtime user without configure rights). Messages are published
// to the real exchanges and consumed through events.archive.q by the production consumer adapter.
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import amqplib from "amqplib";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AmqpPublisher, createAmqpClient, type AegisAmqpClient } from "@aegispulse/ts-platform/amqp";
import { createLogger } from "@aegispulse/ts-platform/logging";
import {
  bindTestQueue,
  drainQueue,
  startBroker,
  startMongo,
  type BrokerEnv,
  type MongoEnv,
} from "../../../../packages/ts-platform/tests/integration/env.js";
import { consumeArchive } from "../../src/adapters/amqp/archive.consumer.js";
import { ArchiveRepository } from "../../src/db/archive.repository.js";
import { MongoOutboxRepository } from "../../src/db/outbox.repository.js";
import { ArchiveService } from "../../src/service/archive.service.js";
import { MongoOutboxRelay } from "../../src/storage/mongo-outbox-relay.js";

const logger = createLogger({
  service: "events",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const TENANT = "8f2a6a5e-3d1b-4c7e-9a0f-1b2c3d4e5f60";

let mongoEnv: MongoEnv;
let broker: BrokerEnv;
let mongo: MongoClient;
let db: Db;
let amqp: AegisAmqpClient;
let relay: MongoOutboxRelay;
let publisher: amqplib.ChannelModel;
let channel: amqplib.Channel;
let classificationQueue: string;

function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  const eventId = randomUUID();
  return {
    eventId,
    correlationId: `corr-${randomUUID()}`,
    causationId: null,
    tenantId: TENANT,
    schemaVersion: "1.0.0",
    eventType: "external.market.alert",
    source: "webhook:demo-market-feed",
    producer: "aegispulse-ingestion@0000000",
    occurredAt: "2026-11-24T11:59:00Z",
    ingestedAt: "2026-11-24T12:00:00.000Z",
    idempotencyKey: `demo-market-feed:${eventId}:v1`,
    classification: { sensitivity: "UNCLASSIFIED", status: "INGESTED", classification_source: "PRODUCER" },
    payload: {
      externalId: eventId,
      category: "MARKET_ALERT",
      title: "Unusual volume",
      mentionedEntities: ["ACME Holdings"],
    },
    ...over,
  };
}

function publish(exchange: string, routingKey: string, body: unknown, headers: Record<string, unknown> = {}): void {
  channel.publish(exchange, routingKey, Buffer.from(typeof body === "string" ? body : JSON.stringify(body)), {
    contentType: "application/json",
    persistent: true,
    headers,
  });
}

async function waitFor<T>(probe: () => Promise<T | null | undefined>, what: string, timeoutMs = 20_000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const archived = (eventId: string, col = "events_archive"): Promise<Record<string, unknown> | null> =>
  db.collection(col).findOne({ tenantId: TENANT, eventId }, { projection: { _id: 0 } });
const outboxFor = (eventId: string): Promise<Record<string, unknown>[]> =>
  db.collection("outbox").find({ "envelope.causationId": eventId }).toArray();

beforeAll(async () => {
  [mongoEnv, broker] = await Promise.all([startMongo(), startBroker()]);
  mongo = new MongoClient(mongoEnv.uri);
  await mongo.connect();
  db = mongo.db("aegispulse_events");
  const require = createRequire(import.meta.url);
  const baseline = require("../../src/db/mongo-migrations/20261122000001-baseline.cjs") as {
    up(db: Db): Promise<void>;
  };
  await baseline.up(db);

  const url = await broker.addRuntimeUser({
    name: "svc_events",
    write: "^aegispulse\\.(enrichment|intelligence|retry|dlx)$",
    read: "^events\\..*",
  });
  amqp = createAmqpClient({
    url,
    service: "events-test",
    logger,
    consumes: ["events.archive.q"],
    publishesTo: ["aegispulse.enrichment", "aegispulse.intelligence"],
  });
  await amqp.init();
  classificationQueue = await bindTestQueue(broker.adminUrl, "aegispulse.enrichment", "classification.#");
  const outbox = new MongoOutboxRepository(db);
  const service = new ArchiveService({
    client: mongo,
    archive: new ArchiveRepository(db),
    outbox,
    tenants: { retentionDays: (t) => Promise.resolve(t === null ? 400 : 30) },
    version: "abc1234",
    logger,
  });
  consumeArchive(amqp, logger, service);
  relay = new MongoOutboxRelay({ repository: outbox, publisher: new AmqpPublisher(amqp), logger });
  publisher = await amqplib.connect(broker.adminUrl);
  channel = await publisher.createChannel();
}, 900_000);

afterAll(async () => {
  await channel?.close();
  await publisher?.close();
  await amqp?.close({ drainTimeoutMs: 1000 });
  await mongo?.close();
  await Promise.all([mongoEnv?.stop(), broker?.stop()]);
});

describe("archive consumer (FR-EVT-01..03, FR-CLS-01/02)", () => {
  it("3× redelivery of one event → exactly 1 document; Stage 2 path: RULE_SCANNED, pendingAiScan, scan.requested once", async () => {
    const env = envelope({
      classification: {
        sensitivity: "UNCLASSIFIED",
        status: "INGESTED",
        classification_source: "PRODUCER",
        publisher_stated_severity: "HIGH",
        source_trust_level: "TRUSTED",
      },
    });
    const id = String(env["eventId"]);
    for (let i = 0; i < 3; i++) publish("aegispulse.ingress", "external.market.alert", env);
    const doc = await waitFor(() => archived(id), "archive document");
    await new Promise((r) => setTimeout(r, 1500)); // let the redeliveries land
    expect(await db.collection("events_archive").countDocuments({ tenantId: TENANT, eventId: id })).toBe(1);
    expect(doc).toMatchObject({
      exchange: "aegispulse.ingress",
      routingKey: "external.market.alert",
      status: "RULE_SCANNED",
      pendingAiScan: true,
      classification: {
        sensitivity: "CONFIDENTIAL",
        publisher_stated_severity: "HIGH",
        source_trust_level: "TRUSTED",
        algorithm_severity: "MEDIUM",
        final_severity: "HIGH", // trusted publisher elevates (§1.4.3); never lowered
        classification_source: "RULES",
        rule_version: "rules-v1.0.0",
        revision: 1,
      },
      replay: { count: 0, lastReplayedAt: null, lastJobId: null },
    });
    expect((doc["statusHistory"] as { status: string }[]).map((s) => s.status)).toEqual(["INGESTED", "RULE_SCANNED"]);
    const pending = await outboxFor(id);
    expect(pending.map((o) => o["routingKey"])).toEqual(["classification.scan.requested"]);
    // Relay → broker (publisher confirms): exactly one message on enrichment.
    await relay.drain();
    const got = (await drainQueue(broker.adminUrl, classificationQueue)) as {
      eventType: string;
      payload: Record<string, unknown>;
    }[];
    expect(got.filter((m) => m.payload["eventId"] === id).map((m) => m.eventType)).toEqual([
      "classification.scan.requested",
    ]);
  });

  it("untrusted publisher severity never counts; a terminal family is archived without emitting anything", async () => {
    const untrusted = envelope({
      eventType: "external.ipo.filed",
      classification: {
        sensitivity: "UNCLASSIFIED",
        status: "INGESTED",
        publisher_stated_severity: "CRITICAL",
        source_trust_level: "UNTRUSTED",
      },
    });
    publish("aegispulse.ingress", "external.ipo.filed", untrusted);
    const u = await waitFor(() => archived(String(untrusted["eventId"])), "untrusted document");
    expect(u["classification"]).toMatchObject({
      publisher_stated_severity: "CRITICAL",
      algorithm_severity: "MEDIUM",
      final_severity: "MEDIUM",
    });

    const terminal = envelope({
      eventType: "classification.finalized",
      source: "service:events",
      producer: "aegispulse-events@0000000",
      classification: { sensitivity: "INTERNAL", status: "INGESTED" },
      payload: {
        eventId: randomUUID(),
        eventType: "external.market.alert",
        sensitivity: "CONFIDENTIAL",
        categories: [],
        algorithm_severity: "MEDIUM",
        final_severity: "MEDIUM",
        revision: 1,
      },
    });
    publish("aegispulse.enrichment", "classification.finalized", terminal);
    const t = await waitFor(() => archived(String(terminal["eventId"])), "terminal document");
    expect(t).toMatchObject({
      status: "CLASSIFIED",
      pendingAiScan: false,
      classification: { sensitivity: "INTERNAL", final_severity: "INFO" },
    });
    expect(await outboxFor(String(terminal["eventId"]))).toEqual([]);
  });

  it("RESTRICTED → events_restricted_audit with masked payload, redactions, pre-redaction sha256, 7-year expiry; finalized emitted", async () => {
    const payload = { transactionId: randomUUID(), note: "card 4111 1111 1111 1111", amount: "10.00" };
    const env = envelope({ eventType: "txn.submitted", source: "api:/v1/transactions", payload });
    const id = String(env["eventId"]);
    publish("aegispulse.ingress", "txn.submitted", env);
    const doc = await waitFor(() => archived(id, "events_restricted_audit"), "restricted document");
    expect(await archived(id)).toBeNull();
    expect(doc).toMatchObject({
      status: "CLASSIFIED",
      payload: { note: "card ************1111" },
      redactions: [{ path: "payload.note", rule: "pii.payment_card", kind: "MASK" }],
      payloadSha256: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
      classification: { sensitivity: "RESTRICTED", categories: ["PII"], final_severity: "LOW" },
    });
    const years = ((doc["expireAt"] as Date).getTime() - (doc["archivedAt"] as Date).getTime()) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(6.99);
    expect((await outboxFor(id)).map((o) => o["routingKey"])).toEqual(["classification.finalized"]);
    expect(JSON.stringify(await outboxFor(id))).not.toContain("4111 1111"); // events never carry the payload
  });

  it("standard expiry = archivedAt + tenant retentionDays; replay-tagged messages only bump replay metadata", async () => {
    const env = envelope({ eventType: "file.uploaded", payload: { fileId: randomUUID() } });
    const id = String(env["eventId"]);
    publish("aegispulse.ingress", "file.uploaded", env);
    const doc = await waitFor(() => archived(id), "file document");
    expect(((doc["expireAt"] as Date).getTime() - (doc["archivedAt"] as Date).getTime()) / 86_400_000).toBe(30);

    publish("aegispulse.ingress", "file.uploaded", env, {
      "x-aegis-replay-job": "job-1",
      "x-aegis-replay-generation": 1,
    });
    await waitFor(
      async () => ((await archived(id))?.["replay"] as { count: number }).count === 1 || null,
      "replay count",
    );
    expect(await archived(id)).toMatchObject({ replay: { count: 1, lastJobId: "job-1" } });
    const ghost = envelope({ eventType: "file.uploaded" });
    publish("aegispulse.ingress", "file.uploaded", ghost, {
      "x-aegis-replay-job": "job-2",
      "x-aegis-replay-generation": 1,
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await archived(String(ghost["eventId"]))).toBeNull(); // replays never create records
  });

  it("an invalid envelope is dead-lettered as poison (no retry) with x-aegis-error-code ENVELOPE_INVALID", async () => {
    const bad = envelope();
    delete bad["eventId"];
    publish("aegispulse.ingress", "external.market.alert", bad);
    publish("aegispulse.ingress", "external.market.alert", "{not json");
    const conn = await amqplib.connect(broker.adminUrl);
    const ch = await conn.createChannel();
    const dead: amqplib.GetMessage[] = [];
    await waitFor(async () => {
      const m = await ch.get("events.archive.q.dlq", { noAck: true });
      if (m !== false) dead.push(m);
      return dead.length >= 2 || null;
    }, "two dead letters");
    await conn.close();
    expect(dead.map((m) => m.properties.headers?.["x-aegis-error-code"])).toEqual([
      "ENVELOPE_INVALID",
      "ENVELOPE_INVALID",
    ]);
    expect(dead.every((m) => (m.properties.headers?.["x-retry-count"] ?? 0) === 0)).toBe(true);
  });
});
