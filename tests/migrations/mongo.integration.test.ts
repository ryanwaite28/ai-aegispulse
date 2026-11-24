// Phase 1 data foundations: applies the Events Service Mongo migrations to an empty MongoDB 8 replica set (PROJECT.md §7.6).
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoDBContainer, type StartedMongoDBContainer } from "@testcontainers/mongodb";
import { MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("MongoDB migrations (FR-EVT-02, FR-RPL, FR-MSG-02)", () => {
  let mongo: StartedMongoDBContainer;
  let client: MongoClient;
  let uri: string;

  const migrate = (): string =>
    execFileSync("pnpm", ["--filter", "@aegispulse/events", "run", "migrate:mongo"], {
      cwd: root,
      env: { ...process.env, MONGO_MIGRATE_URI: uri },
      encoding: "utf8",
    });

  beforeAll(async () => {
    mongo = await new MongoDBContainer("mongo:8.0.38").start();
    uri = `${mongo.getConnectionString()}/aegispulse_events?directConnection=true`;
    client = await MongoClient.connect(uri);
  }, 180_000);

  afterAll(async () => {
    await client?.close();
    await mongo?.stop();
  });

  it("applies every migration in order and is a no-op on re-run", () => {
    const first = migrate();
    expect(first).toContain("MIGRATED UP: 20261122000001-baseline.cjs");
    expect(first).toContain("MIGRATED UP: 20261124000001-dead-letter-open-identity.cjs");
    expect(first).toContain("MIGRATED UP: 20261124000002-dead-letter-tenant-identity-retention.cjs");
    expect(migrate()).not.toContain("MIGRATED UP");
  });

  it("creates every §7.6 collection", async () => {
    const names = (await client.db("aegispulse_events").listCollections().toArray()).map((c) => c.name).sort();
    expect(names).toEqual([
      "dead_letters",
      "events_archive",
      "events_restricted_audit",
      "leases",
      "outbox",
      "processed_messages",
      "replay_jobs",
      "schema_meta",
    ]);
  });

  it.each(["events_archive", "events_restricted_audit"])(
    "indexes %s for idempotency, queries, and TTL",
    async (name) => {
      const idx = await client.db("aegispulse_events").collection(name).indexes();
      const byName = new Map(idx.map((i) => [i.name, i]));
      expect(byName.get("ux_tenant_event")?.unique).toBe(true);
      expect(byName.get("ttl_expire_at")?.expireAfterSeconds).toBe(0);
      expect(byName.has("ix_tenant_final_severity_time")).toBe(true);
      expect(byName.get("ix_pending_ai_scan")?.partialFilterExpression).toEqual({ pendingAiScan: true });
    },
  );

  it("rejects archive documents that violate the validator", async () => {
    await expect(
      client.db("aegispulse_events").collection("events_archive").insertOne({ tenantId: "t", eventId: "e" }),
    ).rejects.toThrow(/validation/i);
  });

  it("deduplicates archive writes on (tenantId, eventId) (FR-EVT-02)", async () => {
    const now = new Date();
    const doc = {
      tenantId: "8f2a6a5e-3d1b-4c7e-9a0f-1b2c3d4e5f60",
      eventId: "019352b8-7c4a-7e10-9a21-4f8c2d1e9b01",
      correlationId: "corr-x",
      eventType: "txn.submitted",
      source: "api:test",
      schemaVersion: "1.1.0",
      occurredAt: now,
      ingestedAt: now,
      archivedAt: now,
      idempotencyKey: "k",
      status: "RULE_SCANNED",
      statusHistory: [],
      classificationHistory: [],
      payload: {},
      payloadSha256: "a".repeat(64),
      expireAt: new Date(now.getTime() + 86_400_000),
      classification: {
        sensitivity: "CONFIDENTIAL",
        algorithm_severity: "LOW",
        final_severity: "LOW",
        classification_source: "RULES",
        rule_version: "rules-v1.0.0",
        revision: 1,
      },
    };
    const col = client.db("aegispulse_events").collection("events_archive");
    await col.insertOne({ ...doc });
    await expect(col.insertOne({ ...doc })).rejects.toThrow(/duplicate key/);
  });
});
