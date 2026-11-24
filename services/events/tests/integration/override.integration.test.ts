// FR-CLS-07 analyst override against a real MongoDB 8 replica set: events are archived through ArchiveService, then
// overridden through OverrideService (Mongo transaction + outbox).
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import type { UserPrincipal } from "@aegispulse/ts-platform/auth";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { startMongo, type MongoEnv } from "../../../../packages/ts-platform/tests/integration/env.js";
import { ArchiveRepository } from "../../src/db/archive.repository.js";
import { MongoOutboxRepository } from "../../src/db/outbox.repository.js";
import { ArchiveService } from "../../src/service/archive.service.js";
import { OverrideService } from "../../src/service/override.service.js";

const logger = createLogger({
  service: "events",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const JUSTIFICATION = "Duplicate of a reviewed filing; no new market impact.";

let mongoEnv: MongoEnv;
let mongo: MongoClient;
let db: Db;
let archive: ArchiveService;
let overrides: OverrideService;

const user = (tenantId: string, roles: string[]): UserPrincipal => ({
  kind: "user",
  userId: randomUUID(),
  tenantId,
  tenantSlug: "t",
  roles,
  tokenId: randomUUID(),
});
const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  return (e as { code?: string }).code ?? "ok";
};

async function archived(
  tenantId: string,
  eventType = "external.acquisition.announced",
  payload: Record<string, unknown> = { title: "t" },
): Promise<string> {
  const eventId = randomUUID();
  await archive.archiveEvent(
    {
      eventId,
      correlationId: `corr-${eventId}`,
      causationId: null,
      tenantId,
      schemaVersion: "1.0.0",
      eventType,
      source: "webhook:demo",
      producer: "aegispulse-ingestion@0000000",
      occurredAt: new Date().toISOString(),
      ingestedAt: new Date().toISOString(),
      idempotencyKey: `k-${eventId}`,
      classification: { sensitivity: "UNCLASSIFIED", status: "INGESTED" },
      payload,
    } as CanonicalEnvelope,
    { exchange: "aegispulse.ingress", routingKey: eventType, replayJob: undefined },
  );
  return eventId;
}

const overriddenEvents = (eventId: string): Promise<Record<string, unknown>[]> =>
  db.collection("outbox").find({ routingKey: "classification.overridden", "envelope.causationId": eventId }).toArray();

beforeAll(async () => {
  mongoEnv = await startMongo();
  mongo = new MongoClient(mongoEnv.uri);
  await mongo.connect();
  db = mongo.db("aegispulse_events");
  const require = createRequire(import.meta.url);
  await (require("../../src/db/mongo-migrations/20261122000001-baseline.cjs") as { up(db: Db): Promise<void> }).up(db);
  const common = {
    client: mongo,
    archive: new ArchiveRepository(db),
    outbox: new MongoOutboxRepository(db),
    version: "abc1234",
    logger,
  };
  archive = new ArchiveService({ ...common, tenants: { retentionDays: () => Promise.resolve(400) } });
  overrides = new OverrideService(common);
}, 600_000);

afterAll(async () => {
  await mongo?.close();
  await mongoEnv?.stop();
});

describe("analyst override (FR-CLS-07)", () => {
  it("an ANALYST may lower severity: OVERRIDDEN, ANALYST source, revision+1, histories, pendingAiScan off, one classification.overridden", async () => {
    const t = randomUUID();
    const id = await archived(t); // acquisition → HIGH, Stage 2 pending
    const analyst = user(t, ["ANALYST"]);
    const r = await overrides.overrideClassification(analyst, undefined, {
      eventId: id,
      finalSeverity: "LOW",
      justification: `  ${JUSTIFICATION}  `,
    });
    expect(r).toMatchObject({
      status: "OVERRIDDEN",
      pendingAiScan: false,
      classification: {
        final_severity: "LOW",
        algorithm_severity: "HIGH",
        classification_source: "ANALYST",
        revision: 2,
        sensitivity: "CONFIDENTIAL",
      },
    });
    expect(r.statusHistory.map((s) => s.status)).toEqual(["INGESTED", "RULE_SCANNED", "OVERRIDDEN"]);
    expect(r.classificationHistory[1]).toMatchObject({
      stage: "ANALYST",
      severity: "LOW",
      version: "analyst-override",
      actor: `user:${analyst.userId}`,
      justification: JUSTIFICATION,
    });
    const events = await overriddenEvents(id);
    expect(events.map((e) => (e["envelope"] as { payload: unknown }).payload)).toEqual([
      {
        eventId: id,
        before: { sensitivity: "CONFIDENTIAL", final_severity: "HIGH" },
        after: { sensitivity: "CONFIDENTIAL", final_severity: "LOW" },
        actorId: analyst.userId,
        justification: JUSTIFICATION,
      },
    ]);
    // The same override again is a no-op.
    const again = await overrides.overrideClassification(analyst, undefined, {
      eventId: id,
      finalSeverity: "LOW",
      justification: JUSTIFICATION,
    });
    expect(again.classification.revision).toBe(2);
    expect(await overriddenEvents(id)).toHaveLength(1);
  });

  it("refusals: short justification 422, VIEWER 403, nothing to change 422, restricted or other tenant 404", async () => {
    const t = randomUUID();
    const id = await archived(t);
    const analyst = user(t, ["ANALYST"]);
    expect(
      await code(
        overrides.overrideClassification(analyst, undefined, {
          eventId: id,
          finalSeverity: "LOW",
          justification: "   too short   ",
        }),
      ),
    ).toBe("CLASSIFICATION_JUSTIFICATION_REQUIRED");
    expect(
      await code(
        overrides.overrideClassification(user(t, ["VIEWER"]), undefined, {
          eventId: id,
          finalSeverity: "LOW",
          justification: JUSTIFICATION,
        }),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await code(overrides.overrideClassification(analyst, undefined, { eventId: id, justification: JUSTIFICATION })),
    ).toBe("VALIDATION_ERROR");
    const restricted = await archived(t, "external.market.alert", { summary: "card 4111 1111 1111 1111" });
    expect(
      await code(
        overrides.overrideClassification(analyst, undefined, {
          eventId: restricted,
          finalSeverity: "LOW",
          justification: JUSTIFICATION,
        }),
      ),
    ).toBe("EVENT_NOT_FOUND");
    expect(
      await code(
        overrides.overrideClassification(user(randomUUID(), ["ANALYST"]), undefined, {
          eventId: id,
          finalSeverity: "LOW",
          justification: JUSTIFICATION,
        }),
      ),
    ).toBe("EVENT_NOT_FOUND");
    expect(await overriddenEvents(id)).toEqual([]);
  });

  it("raising sensitivity to RESTRICTED moves the record to the restricted tier with a 7-year expiry", async () => {
    const t = randomUUID();
    const id = await archived(t);
    const r = await overrides.overrideClassification(user(t, ["TENANT_ADMIN"]), undefined, {
      eventId: id,
      sensitivity: "RESTRICTED",
      finalSeverity: "CRITICAL",
      justification: JUSTIFICATION,
    });
    expect(r.tier).toBe("restricted");
    expect(await db.collection("events_archive").findOne({ tenantId: t, eventId: id })).toBeNull();
    const moved = await db.collection("events_restricted_audit").findOne({ tenantId: t, eventId: id });
    expect(moved?.["classification"]).toMatchObject({
      sensitivity: "RESTRICTED",
      final_severity: "CRITICAL",
      revision: 2,
    });
    const years =
      ((moved?.["expireAt"] as Date).getTime() - (moved?.["archivedAt"] as Date).getTime()) / (365.25 * 86_400_000);
    expect(years).toBeGreaterThan(6.99);
  });

  it("concurrent overrides both apply, one after the other (revision-guarded, retried)", async () => {
    const t = randomUUID();
    const id = await archived(t);
    const [a, b] = await Promise.all([
      overrides.overrideClassification(user(t, ["ANALYST"]), undefined, {
        eventId: id,
        finalSeverity: "LOW",
        justification: JUSTIFICATION,
      }),
      overrides.overrideClassification(user(t, ["ANALYST"]), undefined, {
        eventId: id,
        finalSeverity: "MEDIUM",
        justification: `${JUSTIFICATION} (second)`,
      }),
    ]);
    expect([a.classification.revision, b.classification.revision].sort()).toEqual([2, 3]);
    const stored = await db.collection("events_archive").findOne({ tenantId: t, eventId: id });
    expect((stored?.["classification"] as { revision: number }).revision).toBe(3);
    expect(await overriddenEvents(id)).toHaveLength(2);
  });
});
