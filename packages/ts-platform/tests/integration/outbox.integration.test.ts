// FR-MSG-01 / NFR-02 / ADR-0004: transactional outbox, relay with publisher confirms, consumer dedup and HTTP
// idempotency against real PostgreSQL 18 (migrated by the migrate image, accessed as svc_files) and RabbitMQ 4.
import { Writable } from "node:stream";
import amqp from "amqplib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAmqpClient, AmqpPublisher, type AegisAmqpClient } from "../../src/amqp/index.js";
import { DomainError } from "../../src/errors/index.js";
import { IdempotencyRepository, ProcessedMessagesRepository, sha256Hex } from "../../src/idempotency/index.js";
import { createLogger } from "../../src/logging/index.js";
import {
  OutboxRelay,
  OutboxRepository,
  withTenantTransaction,
  withTransaction,
  type EnvelopePublisher,
} from "../../src/outbox/index.js";
import { sampleEnvelope } from "../fixtures.js";
import { startBroker, startPostgres, type BrokerEnv, type PostgresEnv } from "./env.js";

const logger = createLogger({
  service: "files",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const repo = new OutboxRepository("files");

let db: PostgresEnv;
let broker: BrokerEnv;
let client: AegisAmqpClient;

beforeAll(async () => {
  [db, broker] = await Promise.all([startPostgres(), startBroker()]);
  const url = await broker.addRuntimeUser({
    name: "svc_files",
    write: "^aegispulse\\.(ingress|enrichment)$",
    read: "^$",
  });
  client = createAmqpClient({
    url,
    service: "files-test",
    logger,
    publishesTo: ["aegispulse.ingress", "aegispulse.enrichment"],
  });
  await client.init();
}, 600_000);

afterAll(async () => {
  await client?.close({ drainTimeoutMs: 1000 });
  await Promise.all([db?.stop(), broker?.stop()]);
});

async function drain(queue: string): Promise<amqp.GetMessage[]> {
  const conn = await amqp.connect(broker.adminUrl);
  const ch = await conn.createChannel();
  const out: amqp.GetMessage[] = [];
  for (;;) {
    const m = await ch.get(queue, { noAck: true });
    if (m === false) break;
    out.push(m);
  }
  await conn.close();
  return out;
}

describe("OutboxRepository + OutboxRelay (PROJECT.md §6.6)", () => {
  it("only persists rows whose transaction commits; duplicate eventIds are no-ops", async () => {
    const committed = sampleEnvelope();
    const rolledBack = sampleEnvelope();
    await withTransaction(db.pool, async (tx) => {
      expect(
        await repo.enqueue(tx, { exchange: "aegispulse.ingress", routingKey: "file.uploaded", envelope: committed }),
      ).toBe(true);
      expect(
        await repo.enqueue(tx, { exchange: "aegispulse.ingress", routingKey: "file.uploaded", envelope: committed }),
      ).toBe(false);
    });
    await expect(
      withTransaction(db.pool, async (tx) => {
        await repo.enqueue(tx, { exchange: "aegispulse.ingress", routingKey: "file.uploaded", envelope: rolledBack });
        throw new Error("state change failed");
      }),
    ).rejects.toThrow("state change failed");
    const rows = await db.pool.query<{ event_id: string; status: string }>(
      "SELECT event_id, status FROM files.outbox_events",
    );
    expect(rows.rows).toEqual([{ event_id: committed.eventId, status: "PENDING" }]);
    expect(await repo.lagSeconds(db.pool)).toBeGreaterThanOrEqual(0);
  });

  it("publishes PENDING rows with confirms and §6.4 properties, then marks them SENT", async () => {
    const relay = new OutboxRelay({ pool: db.pool, repository: repo, publisher: new AmqpPublisher(client), logger });
    expect(await relay.runOnce()).toBe(1);
    const rows = await db.pool.query<{ status: string; sent_at: Date | null }>(
      "SELECT status, sent_at FROM files.outbox_events",
    );
    expect(rows.rows[0]).toMatchObject({ status: "SENT" });
    expect(rows.rows[0]?.sent_at).not.toBeNull();

    const [msg] = await drain("files.validation.q");
    expect(msg).toBeDefined();
    const envelope = JSON.parse(msg?.content.toString() ?? "{}") as { eventId: string; tenantId: string };
    expect(msg?.properties).toMatchObject({
      messageId: envelope.eventId,
      type: "file.uploaded",
      contentType: "application/json",
      deliveryMode: 2,
    });
    expect(msg?.properties.headers).toMatchObject({
      "x-aegis-tenant": envelope.tenantId,
      "x-aegis-schema-version": "1.1.0",
    });
    expect(await drain("events.archive.q")).toHaveLength(1);
  });

  it("two relays never publish the same row twice (FOR UPDATE SKIP LOCKED)", async () => {
    await withTransaction(db.pool, async (tx) => {
      for (let i = 0; i < 150; i++) {
        await repo.enqueue(tx, {
          exchange: "aegispulse.ingress",
          routingKey: "file.uploaded",
          envelope: sampleEnvelope(),
        });
      }
    });
    const a = new OutboxRelay({
      pool: db.pool,
      repository: repo,
      publisher: new AmqpPublisher(client),
      logger,
      batchSize: 40,
    });
    const b = new OutboxRelay({
      pool: db.pool,
      repository: repo,
      publisher: new AmqpPublisher(client),
      logger,
      batchSize: 40,
    });
    let total = 0;
    for (;;) {
      const [x, y] = await Promise.all([a.runOnce(), b.runOnce()]);
      total += x + y;
      if (x + y === 0) break;
    }
    expect(total).toBe(150);
    const messages = await drain("files.validation.q");
    expect(messages).toHaveLength(150);
    expect(new Set(messages.map((m) => m.properties.messageId)).size).toBe(150);
    await drain("events.archive.q");
  });

  it("backs off failed publishes and marks FAILED after 20 attempts", async () => {
    const envelope = sampleEnvelope();
    await withTransaction(db.pool, (tx) =>
      repo.enqueue(tx, { exchange: "aegispulse.ingress", routingKey: "file.uploaded", envelope }),
    );
    const failing: EnvelopePublisher = { publishEnvelope: () => Promise.reject(new Error("broker nacked")) };
    const relay = new OutboxRelay({ pool: db.pool, repository: repo, publisher: failing, logger });
    expect(await relay.runOnce()).toBe(1);
    const after = await db.pool.query<{ attempts: number; status: string; last_error: string; delay: string }>(
      "SELECT attempts, status, last_error, EXTRACT(EPOCH FROM available_at - now()) AS delay FROM files.outbox_events WHERE event_id = $1",
      [envelope.eventId],
    );
    expect(after.rows[0]).toMatchObject({ attempts: 1, status: "PENDING", last_error: "Error: broker nacked" });
    expect(Number(after.rows[0]?.delay)).toBeGreaterThan(0.5); // 2^1 s
    expect(await relay.runOnce()).toBe(0); // not due yet

    const row = await db.pool.query<{ id: string }>("SELECT id FROM files.outbox_events WHERE event_id = $1", [
      envelope.eventId,
    ]);
    const id = row.rows[0]?.id ?? "";
    const status = await withTransaction(db.pool, (tx) =>
      repo.markFailed(
        tx,
        {
          id,
          eventId: envelope.eventId,
          tenantId: null,
          exchange: "aegispulse.ingress",
          routingKey: "file.uploaded",
          envelope,
          attempts: 19,
        },
        "x",
      ),
    );
    expect(status).toBe("FAILED");
  });

  it("purges SENT rows only after the retention window", async () => {
    expect(await repo.purgeSent(db.pool, 7)).toBe(0);
    expect(await repo.purgeSent(db.pool, 0)).toBeGreaterThanOrEqual(151);
    const left = await db.pool.query<{ status: string }>("SELECT status FROM files.outbox_events");
    expect(left.rows.every((r) => r.status !== "SENT")).toBe(true);
  });
});

describe("ProcessedMessagesRepository (NFR-02 consumer dedup)", () => {
  const processed = new ProcessedMessagesRepository("files");

  it("detects redelivery but treats a replay generation as new", async () => {
    const key = { consumer: "files.validation.q", eventId: sampleEnvelope().eventId, replayGeneration: 0 };
    expect(await withTransaction(db.pool, (tx) => processed.markProcessed(tx, key))).toBe(true);
    expect(await withTransaction(db.pool, (tx) => processed.markProcessed(tx, key))).toBe(false);
    expect(await withTransaction(db.pool, (tx) => processed.markProcessed(tx, { ...key, replayGeneration: 1 }))).toBe(
      true,
    );
  });

  it("a rolled-back mark is not remembered (crash before commit retries cleanly)", async () => {
    const key = { consumer: "files.validation.q", eventId: sampleEnvelope().eventId, replayGeneration: 0 };
    await expect(
      withTransaction(db.pool, async (tx) => {
        await processed.markProcessed(tx, key);
        throw new Error("service action failed");
      }),
    ).rejects.toThrow();
    expect(await withTransaction(db.pool, (tx) => processed.markProcessed(tx, key))).toBe(true);
  });
});

describe("IdempotencyRepository (NFR-02 HTTP Idempotency-Key) under RLS (NFR-06)", () => {
  const idem = new IdempotencyRepository("files");
  const tenantA = sampleEnvelope().tenantId ?? "";
  const tenantB = sampleEnvelope().tenantId ?? "";

  it("fails closed without tenant context", async () => {
    const id = { tenantId: tenantA, scope: "initUpload", key: "key-0000", requestSha256: sha256Hex("x") };
    await expect(withTransaction(db.pool, (tx) => idem.begin(tx, id))).rejects.toThrow(/row-level security/);
  });

  it("stores the response, replays it for the same body, and rejects a different body", async () => {
    const id = { tenantId: tenantA, scope: "initUpload", key: "key-0001", requestSha256: sha256Hex('{"a":1}') };
    await withTenantTransaction(db.pool, tenantA, async (tx) => {
      expect(await idem.begin(tx, id)).toEqual({ kind: "new" });
      await idem.complete(tx, id, 201, { fileId: "f-1" });
    });
    expect(await withTenantTransaction(db.pool, tenantA, (tx) => idem.begin(tx, id))).toEqual({
      kind: "replay",
      status: 201,
      body: { fileId: "f-1" },
    });
    const conflict = await withTenantTransaction(db.pool, tenantA, (tx) =>
      idem.begin(tx, { ...id, requestSha256: sha256Hex('{"a":2}') }),
    ).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(DomainError);
    expect(conflict).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
  });

  it("isolates tenants: the same key in another tenant is independent and invisible", async () => {
    const id = { tenantId: tenantB, scope: "initUpload", key: "key-0001", requestSha256: sha256Hex("other") };
    expect(await withTenantTransaction(db.pool, tenantB, (tx) => idem.begin(tx, id))).toEqual({ kind: "new" });
    const visible = await withTenantTransaction(db.pool, tenantB, (tx) =>
      tx.query("SELECT 1 FROM files.idempotency_records WHERE tenant_id = $1", [tenantA]),
    );
    expect(visible.rows).toHaveLength(0);
    // writing a row for tenant A while scoped to tenant B is refused by the RLS WITH CHECK
    await expect(
      withTenantTransaction(db.pool, tenantB, (tx) => idem.begin(tx, { ...id, tenantId: tenantA, key: "key-0003" })),
    ).rejects.toThrow(/row-level security/);
  });

  it("serializes concurrent requests with the same key: the second sees the first's response", async () => {
    const id = { tenantId: tenantA, scope: "initUpload", key: "key-0002", requestSha256: sha256Hex("same") };
    const first = withTenantTransaction(db.pool, tenantA, async (tx) => {
      const decision = await idem.begin(tx, id);
      await new Promise((r) => setTimeout(r, 300)); // slow handler holds the key
      await idem.complete(tx, id, 202, { n: 1 });
      return decision;
    });
    await new Promise((r) => setTimeout(r, 50));
    const second = withTenantTransaction(db.pool, tenantA, (tx) => idem.begin(tx, id));
    expect(await first).toEqual({ kind: "new" });
    expect(await second).toEqual({ kind: "replay", status: 202, body: { n: 1 } });
  });

  it("ignores the old app.bypass_rls session setting (ADR-0016)", async () => {
    const seen = await withTransaction(db.pool, async (tx) => {
      await tx.query("SELECT set_config('app.bypass_rls', 'on', true)");
      return tx.query("SELECT 1 FROM files.idempotency_records");
    });
    expect(seen.rows).toHaveLength(0);
  });

  it("purges expired keys across tenants only through the SECURITY DEFINER function", async () => {
    for (const tenant of [tenantA, tenantB]) {
      await withTenantTransaction(db.pool, tenant, (tx) =>
        tx.query("UPDATE files.idempotency_records SET expires_at = now() - interval '1 hour' WHERE tenant_id = $1", [
          tenant,
        ]),
      );
    }
    const plain = await withTransaction(db.pool, (tx) => tx.query("DELETE FROM files.idempotency_records"));
    expect(plain.rowCount).toBe(0); // a service session cannot reach any tenant's rows
    expect(await withTransaction(db.pool, (tx) => idem.purgeExpired(tx))).toBe(3); // A: key-0001, key-0002; B: key-0001
  });
});
