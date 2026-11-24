// FR-EVT-07 part 1 against a real MongoDB 8 replica set: TTL indexes exist on both tiers (expireAfterSeconds 0 on
// expireAt), expireAt follows the tenant setting / 7-year restricted rule, and Mongo's TTL monitor really removes
// expired records (monitor interval lowered to 1 s for the test only).
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { startMongo, type MongoEnv } from "../../../../packages/ts-platform/tests/integration/env.js";
import { ArchiveRepository } from "../../src/db/archive.repository.js";
import { MongoOutboxRepository } from "../../src/db/outbox.repository.js";
import { ArchiveService } from "../../src/service/archive.service.js";

const logger = createLogger({
  service: "events",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

let mongoEnv: MongoEnv;
let mongo: MongoClient;
let db: Db;
let archive: ArchiveService;
const retention = new Map<string, number>();

async function put(tenantId: string, payload: Record<string, unknown> = { title: "t" }): Promise<string> {
  const eventId = randomUUID();
  await archive.archiveEvent(
    {
      eventId,
      correlationId: `corr-${eventId}`,
      causationId: null,
      tenantId,
      schemaVersion: "1.0.0",
      eventType: "txn.submitted",
      source: "api:/v1/transactions",
      producer: "aegispulse-ingestion@0000000",
      occurredAt: new Date().toISOString(),
      ingestedAt: new Date().toISOString(),
      idempotencyKey: `k-${eventId}`,
      classification: { sensitivity: "UNCLASSIFIED", status: "INGESTED" },
      payload,
    } as CanonicalEnvelope,
    { exchange: "aegispulse.ingress", routingKey: "txn.submitted", replayJob: undefined },
  );
  return eventId;
}

beforeAll(async () => {
  mongoEnv = await startMongo();
  mongo = new MongoClient(mongoEnv.uri);
  await mongo.connect();
  db = mongo.db("aegispulse_events");
  const require = createRequire(import.meta.url);
  await (require("../../src/db/mongo-migrations/20261122000001-baseline.cjs") as { up(db: Db): Promise<void> }).up(db);
  archive = new ArchiveService({
    client: mongo,
    archive: new ArchiveRepository(db),
    outbox: new MongoOutboxRepository(db),
    tenants: { retentionDays: (t) => Promise.resolve(t === null ? 400 : (retention.get(t) ?? 400)) },
    version: "abc1234",
    logger,
  });
}, 600_000);

afterAll(async () => {
  await mongo?.close();
  await mongoEnv?.stop();
});

describe("archive retention (FR-EVT-07 part 1)", () => {
  it("both tiers carry the TTL index on expireAt (expireAfterSeconds 0) and the §7.6 query indexes", async () => {
    for (const name of ["events_archive", "events_restricted_audit"]) {
      const indexes = await db.collection(name).listIndexes().toArray();
      const ttl = indexes.find((i) => i["name"] === "ttl_expire_at");
      expect(ttl).toMatchObject({ key: { expireAt: 1 }, expireAfterSeconds: 0 });
      expect(indexes.find((i) => i["name"] === "ux_tenant_event")).toMatchObject({
        unique: true,
        key: { tenantId: 1, eventId: 1 },
      });
      expect(indexes.map((i) => i["name"]).sort()).toEqual([
        "_id_",
        "ix_pending_ai_scan",
        "ix_status_time",
        "ix_tenant_correlation_time",
        "ix_tenant_entity_time",
        "ix_tenant_final_severity_time",
        "ix_tenant_type_time",
        "ttl_expire_at",
        "ux_tenant_event",
      ]);
    }
  });

  it("expireAt follows each tenant's retentionDays (standard) and 7 years (restricted)", async () => {
    const short = randomUUID();
    const long = randomUUID();
    retention.set(short, 30);
    retention.set(long, 3650);
    const days = async (tenantId: string, eventId: string, col = "events_archive"): Promise<number> => {
      const d = await db.collection(col).findOne({ tenantId, eventId });
      return Math.round(((d?.["expireAt"] as Date).getTime() - (d?.["archivedAt"] as Date).getTime()) / 86_400_000);
    };
    expect(await days(short, await put(short))).toBe(30);
    expect(await days(long, await put(long))).toBe(3650);
    expect(
      await days(short, await put(short, { note: "ssn 123-45-6789" }), "events_restricted_audit"),
    ).toBeGreaterThanOrEqual(2556); // 7 y
  });

  it("Mongo's TTL monitor removes expired records from both tiers (monitor sped up to 1 s for the test)", async () => {
    await mongo.db("admin").command({ setParameter: 1, ttlMonitorSleepSecs: 1 });
    const t = randomUUID();
    const standard = await put(t);
    const restricted = await put(t, { ssn: "123456789" });
    const keep = await put(t);
    const past = new Date(Date.now() - 60_000);
    await db.collection("events_archive").updateOne({ tenantId: t, eventId: standard }, { $set: { expireAt: past } });
    await db
      .collection("events_restricted_audit")
      .updateOne({ tenantId: t, eventId: restricted }, { $set: { expireAt: past } });
    const gone = async (): Promise<boolean> =>
      (await db.collection("events_archive").countDocuments({ tenantId: t, eventId: standard })) === 0 &&
      (await db.collection("events_restricted_audit").countDocuments({ tenantId: t, eventId: restricted })) === 0;
    for (let i = 0; i < 60 && !(await gone()); i++) await new Promise((r) => setTimeout(r, 500));
    expect(await gone()).toBe(true);
    expect(await db.collection("events_archive").countDocuments({ tenantId: t, eventId: keep })).toBe(1);
  });
});
