// FR-EVT-04..06 against a real MongoDB 8 replica set (baseline migration). Events are archived through the real
// ArchiveService (Stage 1 included), then read back through EventQueryService.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import { PLATFORM_TENANT_ID, type Principal, type UserPrincipal } from "@aegispulse/ts-platform/auth";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { startMongo, type MongoEnv } from "../../../../packages/ts-platform/tests/integration/env.js";
import { ArchiveRepository } from "../../src/db/archive.repository.js";
import { EventQueryRepository } from "../../src/db/event-query.repository.js";
import { MongoOutboxRepository } from "../../src/db/outbox.repository.js";
import { ArchiveService } from "../../src/service/archive.service.js";
import { EventQueryService } from "../../src/service/event-query.service.js";

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
let queries: EventQueryService;
let repo: EventQueryRepository;

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

let clock = Date.parse("2026-11-24T10:00:00Z");
async function put(
  tenantId: string,
  over: Partial<CanonicalEnvelope> & { payload?: Record<string, unknown> } = {},
): Promise<CanonicalEnvelope> {
  clock += 60_000;
  const eventId = randomUUID();
  const env = {
    eventId,
    correlationId: "corr-default",
    causationId: null,
    tenantId,
    schemaVersion: "1.0.0",
    eventType: "external.market.alert",
    source: "webhook:demo",
    producer: "aegispulse-ingestion@0000000",
    occurredAt: new Date(clock).toISOString(),
    ingestedAt: new Date(clock + 500).toISOString(),
    idempotencyKey: `k-${eventId}`,
    classification: { sensitivity: "UNCLASSIFIED", status: "INGESTED" },
    payload: { title: "t" },
    ...over,
  } as CanonicalEnvelope;
  expect(
    await archive.archiveEvent(env, {
      exchange: "aegispulse.ingress",
      routingKey: env.eventType,
      replayJob: undefined,
    }),
  ).toBe("archived");
  return env;
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
    tenants: { retentionDays: () => Promise.resolve(400) },
    version: "abc1234",
    logger,
  });
  repo = new EventQueryRepository(db);
  queries = new EventQueryService(repo);
}, 600_000);

afterAll(async () => {
  await mongo?.close();
  await mongoEnv?.stop();
});

describe("event queries (FR-EVT-04)", () => {
  it("filters (correlation, type prefix, severity ≥, source, time) and pages newest first with a keyset cursor", async () => {
    const t = randomUUID();
    const viewer = user(t, ["VIEWER"]);
    const corr = `corr-${randomUUID()}`;
    const a = await put(t, { correlationId: corr, eventType: "external.market.alert" }); // MEDIUM
    const b = await put(t, { correlationId: corr, eventType: "external.acquisition.announced" }); // HIGH
    const c = await put(t, { correlationId: corr, eventType: "file.uploaded", source: "service:files" }); // INFO
    await put(randomUUID(), { correlationId: corr }); // other tenant: never visible

    const all = await queries.searchEvents(viewer, undefined, { correlationId: corr });
    expect(all.items.map((e) => e.eventId)).toEqual([c.eventId, b.eventId, a.eventId]);
    expect(
      (await queries.searchEvents(viewer, undefined, { eventType: "external." })).items.map((e) => e.eventId),
    ).toEqual([b.eventId, a.eventId]);
    expect(
      (await queries.searchEvents(viewer, undefined, { finalSeverity: "HIGH" })).items.map((e) => e.eventId),
    ).toEqual([b.eventId]);
    expect(
      (await queries.searchEvents(viewer, undefined, { source: "service:files" })).items.map((e) => e.eventId),
    ).toEqual([c.eventId]);
    expect(
      (await queries.searchEvents(viewer, undefined, { from: a.occurredAt, to: c.occurredAt })).items.map(
        (e) => e.eventId,
      ),
    ).toEqual([b.eventId, a.eventId]);

    const p1 = await queries.searchEvents(viewer, undefined, { correlationId: corr, limit: 2 });
    expect(p1.items.map((e) => e.eventId)).toEqual([c.eventId, b.eventId]);
    const p2 = await queries.searchEvents(viewer, undefined, { correlationId: corr, limit: 2, cursor: p1.nextCursor });
    expect(p2.items.map((e) => e.eventId)).toEqual([a.eventId]);
    expect(p2.nextCursor).toBeUndefined();
    expect(await code(queries.searchEvents(viewer, undefined, { cursor: "bm90LWEtY3Vyc29y" }))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("the restricted tier is COMPLIANCE_AUDITOR-only; VIEWER/ANALYST never see restricted events (masked payload for CA)", async () => {
    const t = randomUUID();
    const r = await put(t, {
      eventType: "external.market.alert",
      payload: { title: "leak", summary: "card 4111 1111 1111 1111" },
    });
    for (const roles of [["VIEWER"], ["ANALYST"], ["TENANT_ADMIN"]]) {
      const p = user(t, roles);
      expect((await queries.searchEvents(p, undefined, {})).items.map((e) => e.eventId)).not.toContain(r.eventId);
      expect(await code(queries.searchEvents(p, undefined, { tier: "restricted" }))).toBe("FORBIDDEN");
      expect(await code(queries.getEvent(p, undefined, { eventId: r.eventId }))).toBe("EVENT_NOT_FOUND");
    }
    const ca = user(t, ["COMPLIANCE_AUDITOR"]);
    const found = await queries.searchEvents(ca, undefined, { tier: "restricted" });
    expect(found.items.map((e) => e.eventId)).toEqual([r.eventId]);
    const full = await queries.getEvent(ca, undefined, { eventId: r.eventId, tier: "restricted" });
    expect(full).toMatchObject({ tier: "restricted", payload: { summary: "card ************1111" } });
    expect(full.classification.sensitivity).toBe("RESTRICTED");
  });

  it("getEvent returns the full lineage; other tenants and PA without X-Aegis-Tenant cannot read it", async () => {
    const t = randomUUID();
    const e = await put(t, {
      classification: {
        sensitivity: "UNCLASSIFIED",
        status: "INGESTED",
        publisher_stated_severity: "CRITICAL",
        source_trust_level: "TRUSTED",
      },
    } as Partial<CanonicalEnvelope>);
    const got = await queries.getEvent(user(t, ["ANALYST"]), undefined, { eventId: e.eventId });
    expect(got.classification).toMatchObject({
      publisher_stated_severity: "CRITICAL",
      algorithm_severity: "MEDIUM",
      final_severity: "CRITICAL",
    });
    expect(got.statusHistory.map((s) => s.status)).toEqual(["INGESTED", "RULE_SCANNED"]);
    expect(got.classificationHistory.map((h) => h.stage)).toEqual(["RULES"]);
    expect(await code(queries.getEvent(user(randomUUID(), ["ANALYST"]), undefined, { eventId: e.eventId }))).toBe(
      "EVENT_NOT_FOUND",
    );
    const pa: Principal = user(PLATFORM_TENANT_ID, ["PLATFORM_ADMIN"]);
    expect(await code(queries.getEvent(pa, undefined, { eventId: e.eventId }))).toBe("FORBIDDEN");
    expect((await queries.getEvent(pa, t, { eventId: e.eventId })).eventId).toBe(e.eventId);
  });
});

describe("correlation chain and entity search (FR-EVT-05/06)", () => {
  it("orders a correlation causally (cause before effects) regardless of arrival", async () => {
    const t = randomUUID();
    const corr = `corr-${randomUUID()}`;
    const root = await put(t, { correlationId: corr });
    const late = await put(t, { correlationId: corr, eventType: "file.uploaded" }); // unrelated sibling root
    const effect = await put(t, {
      correlationId: corr,
      eventType: "classification.finalized",
      causationId: root.eventId,
      source: "service:events",
    });
    // An effect whose occurredAt is *earlier* than its cause still follows it.
    const early = await put(t, {
      correlationId: corr,
      eventType: "case.opened",
      causationId: effect.eventId,
      occurredAt: "2020-01-01T00:00:00Z",
    });
    const chain = await queries.getCorrelationChain(user(t, ["VIEWER"]), undefined, corr);
    expect(chain.map((e) => e.eventId)).toEqual([root.eventId, effect.eventId, early.eventId, late.eventId]);
  });

  it("searchEventsForEntities (SERVICE only) matches entity ids, exact or wildcard types, since; tenantless queries are refused", async () => {
    const t = randomUUID();
    const entity = randomUUID();
    const hit = await put(t, { eventType: "external.ipo.filed" });
    const other = await put(t, { eventType: "txn.submitted" });
    await db
      .collection("events_archive")
      .updateMany({ eventId: { $in: [hit.eventId, other.eventId] } }, { $set: { mentionedEntityIds: [entity] } });
    const orchestrator: Principal = {
      kind: "service",
      clientId: "svc-orchestrator",
      actions: ["events.searchEventsForEntities"],
    };
    const input = {
      tenantId: t,
      entityIds: [entity],
      eventTypes: ["external.*"],
      since: "2026-01-01T00:00:00Z",
      limit: 10,
    };
    expect((await queries.searchEventsForEntities(orchestrator, input)).map((e) => e.eventId)).toEqual([hit.eventId]);
    expect(
      (await queries.searchEventsForEntities(orchestrator, { ...input, eventTypes: ["txn.submitted", "external.*"] }))
        .length,
    ).toBe(2);
    expect(await queries.searchEventsForEntities(orchestrator, { ...input, tenantId: randomUUID() })).toEqual([]);
    expect(await code(queries.searchEventsForEntities(user(t, ["ANALYST"]), input))).toBe("FORBIDDEN");
    await expect(repo.search("standard", "", {}, undefined, 10)).rejects.toThrow("tenantless archive query refused");
  });
});
