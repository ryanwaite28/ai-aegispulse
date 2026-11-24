// FR-MSG-02 / FR-MSG-03 against real RabbitMQ 4 (contract topology, configure-'^$' runtime users) and a real MongoDB 8
// replica set: a files.validation.q consumer (the TS kit) fails → DLQ + events.deadletter.q → the registry records it
// → an admin replays it after the "fix" → processed exactly once; poison is recorded and discarded; audit events go
// through the Mongo outbox.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import amqp from "amqplib";
import { MongoClient, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consumeEnvelopes, createAmqpClient, parseEnvelope, type AegisAmqpClient } from "@aegispulse/ts-platform/amqp";
import { PLATFORM_TENANT_ID, type UserPrincipal } from "@aegispulse/ts-platform/auth";
import { PermanentError } from "@aegispulse/ts-platform/errors";
import { createLogger } from "@aegispulse/ts-platform/logging";
import {
  startBroker,
  startMongo,
  type BrokerEnv,
  type MongoEnv,
} from "../../../../packages/ts-platform/tests/integration/env.js";
import { sampleEnvelope } from "../../../../packages/ts-platform/tests/fixtures.js";
import { consumeDeadLetters } from "../../src/adapters/amqp/deadletter.consumer.js";
import { DeadLetterRepository, type DeadLetterDoc } from "../../src/db/dead-letter.repository.js";
import { MongoOutboxRepository } from "../../src/db/outbox.repository.js";
import { DeadLetterService } from "../../src/service/dead-letter.service.js";
import { TopologyReplayPublisher } from "../../src/storage/dead-letter-replay.js";

const logger = createLogger({
  service: "events",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const EXCHANGES = "^aegispulse\\.(ingress|enrichment|domain|intelligence|retry|dlx)$";

let broker: BrokerEnv;
let mongoEnv: MongoEnv;
let mongo: MongoClient;
let db: Db;
let admin: amqp.ChannelModel;
let adminCh: amqp.ConfirmChannel;
let eventsClient: AegisAmqpClient;
let filesClient: AegisAmqpClient;
let service: DeadLetterService;

/** The files.validation.q stand-in: fails PERMANENT until fixed, then records each processed eventId. */
const files = { fixed: false, processed: [] as string[] };

const user = (tenantId: string, roles: string[]): UserPrincipal => ({
  kind: "user",
  userId: randomUUID(),
  tenantId,
  tenantSlug: "t",
  roles,
  tokenId: randomUUID(),
});
const platformAdmin = user(PLATFORM_TENANT_ID, ["PLATFORM_ADMIN"]);
const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  return (e as { code?: string }).code ?? "ok";
};

async function waitFor<T>(fn: () => Promise<T | undefined | null>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined && v !== null) return v;
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function publish(body: Buffer, routingKey = "file.uploaded"): Promise<void> {
  adminCh.publish("aegispulse.ingress", routingKey, body, { contentType: "application/json", persistent: true });
  await adminCh.waitForConfirms();
}

const recordFor = (filter: Record<string, unknown>): Promise<DeadLetterDoc | null> =>
  db.collection<DeadLetterDoc>("dead_letters").findOne(filter);
const outboxFor = (routingKey: string, deadLetterId: string): Promise<Record<string, unknown>[]> =>
  db.collection("outbox").find({ routingKey, "envelope.payload.deadLetterId": deadLetterId }).toArray();

beforeAll(async () => {
  [broker, mongoEnv] = await Promise.all([startBroker(), startMongo()]);
  mongo = new MongoClient(mongoEnv.uri);
  await mongo.connect();
  db = mongo.db("aegispulse_events");
  const require = createRequire(import.meta.url);
  for (const m of [
    "20261122000001-baseline.cjs",
    "20261124000001-dead-letter-open-identity.cjs",
    "20261124000002-dead-letter-tenant-identity-retention.cjs",
  ]) {
    await (require(`../../src/db/mongo-migrations/${m}`) as { up(db: Db): Promise<void> }).up(db);
  }
  admin = await amqp.connect(broker.adminUrl);
  adminCh = await admin.createConfirmChannel();

  const eventsUrl = await broker.addRuntimeUser({ name: "svc_events", write: EXCHANGES, read: "^events\\..*$" });
  const filesUrl = await broker.addRuntimeUser({ name: "svc_files", write: EXCHANGES, read: "^files\\..*$" });
  eventsClient = createAmqpClient({
    url: eventsUrl,
    service: "events-test",
    logger,
    consumes: ["events.deadletter.q"],
    publishesTo: ["aegispulse.intelligence"],
  });
  filesClient = createAmqpClient({ url: filesUrl, service: "files-test", logger, consumes: ["files.validation.q"] });
  await Promise.all([eventsClient.init(), filesClient.init()]);
  service = new DeadLetterService({
    client: mongo,
    repo: new DeadLetterRepository(db),
    outbox: new MongoOutboxRepository(db),
    replay: new TopologyReplayPublisher(eventsClient),
    version: "abc1234",
    logger,
  });
  consumeDeadLetters(eventsClient, logger, service);
  consumeEnvelopes({
    client: filesClient,
    queue: "files.validation.q",
    logger,
    handler: async (envelope) => {
      if (!files.fixed) throw new PermanentError("NOT_FOUND", "file row missing");
      files.processed.push(envelope.eventId);
    },
  });
}, 600_000);

afterAll(async () => {
  await filesClient?.close({ drainTimeoutMs: 2000 });
  await eventsClient?.close({ drainTimeoutMs: 2000 });
  await admin?.close();
  await mongo?.close();
  await Promise.all([broker?.stop(), mongoEnv?.stop()]);
});

describe("dead-letter registry (FR-MSG-02) and admin actions (FR-MSG-03)", () => {
  const tenant = randomUUID();
  const envelope = sampleEnvelope({ tenantId: tenant });
  let deadLetterId = "";
  let poisonId = "";

  it("records a failed message with envelope, headers, error code/message/stack hash; one ops.dead_letter.recorded", async () => {
    await publish(Buffer.from(JSON.stringify(envelope)));
    const doc = await waitFor(() => recordFor({ eventId: envelope.eventId }));
    deadLetterId = doc._id.toHexString();
    expect(doc).toMatchObject({
      tenantId: tenant,
      eventId: envelope.eventId,
      eventType: "file.uploaded",
      queue: "files.validation.q",
      routingKey: "file.uploaded",
      errorCode: "NOT_FOUND",
      errorMessage: "PermanentError[NOT_FOUND]: file row missing",
      retryCount: 0,
      status: "OPEN",
      occurrences: 1,
      rawBody: null,
    });
    expect(doc.stackHash).toMatch(/^[0-9a-f]{16}$/);
    expect(doc.envelope).toMatchObject({ eventId: envelope.eventId, payload: envelope.payload });
    expect(doc.headers).toMatchObject({ "x-aegis-original-queue": "files.validation.q" });
    const recorded = await waitFor(async () => {
      const rows = await outboxFor("ops.dead_letter.recorded", deadLetterId);
      return rows.length > 0 ? rows : undefined;
    });
    expect(recorded).toHaveLength(1);
    const env = parseEnvelope(Buffer.from(JSON.stringify(recorded[0]?.["envelope"])));
    expect(env).toMatchObject({
      tenantId: tenant,
      causationId: envelope.eventId,
      correlationId: envelope.correlationId,
      payload: { queue: "files.validation.q", errorCode: "NOT_FOUND", originalEventId: envelope.eventId },
    });
  });

  it("records poison (non-JSON) with the raw body and no event id", async () => {
    await publish(Buffer.from("{not json"));
    const doc = await waitFor(() => recordFor({ eventId: null, errorCode: "ENVELOPE_INVALID" }));
    poisonId = doc._id.toHexString();
    expect(doc).toMatchObject({ tenantId: null, envelope: null, rawBody: "{not json", queue: "files.validation.q" });
    expect(await outboxFor("ops.dead_letter.recorded", poisonId)).toHaveLength(1);
  });

  it("a repeat failure of the same OPEN message updates the record instead of adding one", async () => {
    await service.recordDeadLetter({
      content: Buffer.from(JSON.stringify(envelope)),
      headers: { "x-aegis-original-queue": "files.validation.q", "x-aegis-error-code": "NOT_FOUND" },
      messageId: envelope.eventId,
      routingKey: "files.validation.q",
    });
    expect(await db.collection("dead_letters").countDocuments({ eventId: envelope.eventId })).toBe(1);
    expect((await recordFor({ eventId: envelope.eventId }))?.occurrences).toBe(2);
    expect(await outboxFor("ops.dead_letter.recorded", deadLetterId)).toHaveLength(1);
  });

  it("concurrent recordings of one failure keep a single OPEN record (partial unique index + rerun)", async () => {
    const twin = sampleEnvelope({ tenantId: tenant });
    const delivery = {
      content: Buffer.from(JSON.stringify(twin)),
      headers: { "x-aegis-original-queue": "files.validation.q", "x-aegis-error-code": "NOT_FOUND" },
      messageId: twin.eventId,
      routingKey: "files.validation.q",
    };
    await Promise.all(Array.from({ length: 6 }, () => service.recordDeadLetter(delivery)));
    const rows = await db.collection<DeadLetterDoc>("dead_letters").find({ eventId: twin.eventId }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(6);
    expect(await outboxFor("ops.dead_letter.recorded", rows[0]?._id.toHexString() ?? "")).toHaveLength(1);
    await service.discardDeadLetter(platformAdmin, undefined, rows[0]?._id.toHexString() ?? "", "test twin");
  });

  it("does not re-announce a dead-lettered ops.dead_letter.recorded (no feedback loop)", async () => {
    const loop = sampleEnvelope({ eventType: "ops.dead_letter.recorded", tenantId: tenant });
    const doc = await service.recordDeadLetter({
      content: Buffer.from(JSON.stringify(loop)),
      headers: { "x-aegis-original-queue": "events.archive.q", "x-aegis-error-code": "INTERNAL_ERROR" },
      messageId: loop.eventId,
      routingKey: "events.archive.q",
    });
    expect(await outboxFor("ops.dead_letter.recorded", doc._id.toHexString())).toHaveLength(0);
  });

  it("TENANT_ADMIN sees the own tenant only; PLATFORM_ADMIN sees all and may narrow with X-Aegis-Tenant", async () => {
    const ta = user(tenant, ["TENANT_ADMIN"]);
    const own = await service.listDeadLetters(ta, undefined, { queue: "files.validation.q" });
    expect(own.items.map((d) => d._id.toHexString())).toContain(deadLetterId);
    expect(own.items.every((d) => d.tenantId === tenant)).toBe(true);
    const other = user(randomUUID(), ["TENANT_ADMIN"]);
    expect((await service.listDeadLetters(other, undefined, {})).items).toEqual([]);
    expect(await code(service.getDeadLetter(other, undefined, deadLetterId))).toBe("DEAD_LETTER_NOT_FOUND");
    expect(await code(service.listDeadLetters(ta, tenant, {}))).toBe("FORBIDDEN");
    expect(await code(service.listDeadLetters(user(tenant, ["ANALYST"]), undefined, {}))).toBe("FORBIDDEN");

    const all = await service.listDeadLetters(platformAdmin, undefined, { errorCode: "ENVELOPE_INVALID" });
    expect(all.items.map((d) => d._id.toHexString())).toContain(poisonId);
    const narrowed = await service.listDeadLetters(platformAdmin, tenant, {});
    expect(narrowed.items.every((d) => d.tenantId === tenant)).toBe(true);
    const page = await service.listDeadLetters(platformAdmin, undefined, { limit: 1 });
    expect(page.items).toHaveLength(1);
    const next = await service.listDeadLetters(platformAdmin, undefined, { limit: 1, cursor: page.nextCursor });
    expect(next.items[0]?._id.toHexString()).not.toBe(page.items[0]?._id.toHexString());
    expect(await code(service.listDeadLetters(platformAdmin, undefined, { cursor: "bad" }))).toBe("VALIDATION_ERROR");
    expect(await code(service.getDeadLetter(platformAdmin, undefined, "not-an-id"))).toBe("DEAD_LETTER_NOT_FOUND");
  });

  it("replay after the fix → processed exactly once; REPLAYED + one ops.audit.dead_letter_resolved", async () => {
    files.fixed = true;
    const ta = user(tenant, ["TENANT_ADMIN"]);
    const replayed = await service.replayDeadLetter(ta, undefined, deadLetterId);
    expect(replayed).toMatchObject({ status: "REPLAYED", resolvedBy: `user:${ta.userId}`, reason: null });
    await waitFor(async () => (files.processed.includes(envelope.eventId) ? true : undefined));
    await new Promise((r) => setTimeout(r, 2_000)); // nothing else arrives
    expect(files.processed.filter((id) => id === envelope.eventId)).toHaveLength(1);
    expect((await adminCh.checkQueue("files.validation.q.dlq")).messageCount).toBe(2); // the two original copies only

    const audit = await outboxFor("ops.audit.dead_letter_resolved", deadLetterId);
    expect(audit).toHaveLength(1);
    const env = parseEnvelope(Buffer.from(JSON.stringify(audit[0]?.["envelope"])));
    expect(env).toMatchObject({
      tenantId: tenant,
      payload: { action: "REPLAYED", actorId: ta.userId, queue: "files.validation.q", reason: null },
    });

    // the same request again is a no-op; a different resolution is a conflict
    expect((await service.replayDeadLetter(ta, undefined, deadLetterId)).status).toBe("REPLAYED");
    expect(await outboxFor("ops.audit.dead_letter_resolved", deadLetterId)).toHaveLength(1);
    expect(await code(service.replayDeadLetter(user(tenant, ["TENANT_ADMIN"]), undefined, deadLetterId))).toBe(
      "DEAD_LETTER_ALREADY_RESOLVED",
    );
    expect(await code(service.discardDeadLetter(ta, undefined, deadLetterId, "no longer needed"))).toBe(
      "DEAD_LETTER_ALREADY_RESOLVED",
    );
  });

  it("two simultaneous replays by different admins: one wins, the other is a conflict; processed once", async () => {
    const racer = sampleEnvelope({ tenantId: tenant });
    files.fixed = false;
    await publish(Buffer.from(JSON.stringify(racer)));
    const doc = await waitFor(() => recordFor({ eventId: racer.eventId, status: "OPEN" }));
    files.fixed = true;
    const id = doc._id.toHexString();
    const results = await Promise.all([
      code(service.replayDeadLetter(user(tenant, ["TENANT_ADMIN"]), undefined, id)),
      code(service.replayDeadLetter(user(tenant, ["TENANT_ADMIN"]), undefined, id)),
    ]);
    expect(results.sort()).toEqual(["DEAD_LETTER_ALREADY_RESOLVED", "ok"]);
    await waitFor(async () => (files.processed.includes(racer.eventId) ? true : undefined));
    await new Promise((r) => setTimeout(r, 2_000));
    expect(files.processed.filter((x) => x === racer.eventId)).toHaveLength(1);
    expect(await outboxFor("ops.audit.dead_letter_resolved", id)).toHaveLength(1);
  });

  it("views mask card numbers and secrets (§1.4.2) while the replay re-delivers the original bytes", async () => {
    const card = ["4111", "1111", "1111", "1111"].join(" ");
    const secret = sampleEnvelope({ tenantId: tenant, payload: { fileId: randomUUID(), note: `paid with ${card}` } });
    files.fixed = false;
    await publish(Buffer.from(JSON.stringify(secret)));
    const doc = await waitFor(() => recordFor({ eventId: secret.eventId, status: "OPEN" }));
    const id = doc._id.toHexString();
    const ta = user(tenant, ["TENANT_ADMIN"]);
    const shown = await service.getDeadLetter(ta, undefined, id);
    expect(JSON.stringify(shown.envelope)).not.toContain(card);
    expect(shown.envelope).toMatchObject({ payload: { note: "paid with ************1111" } });
    expect(shown.redactions).toContainEqual({ path: "envelope.payload.note", rule: "pii.payment_card", kind: "MASK" });
    const listed = await service.listDeadLetters(ta, undefined, { queue: "files.validation.q" });
    expect(JSON.stringify(listed.items)).not.toContain(card);
    files.fixed = true;
    const before = files.processed.length;
    await service.replayDeadLetter(ta, undefined, id);
    await waitFor(async () => (files.processed.length > before ? true : undefined));
    const delivered = files.processed[files.processed.length - 1];
    expect(delivered).toBe(secret.eventId);
    const after = await recordFor({ _id: doc._id });
    expect(after?.expireAt?.getTime()).toBe((after?.resolvedAt?.getTime() ?? 0) + 30 * 86_400_000);
  });

  it("authz: other tenant's id, tenantless records and X-Aegis-Tenant from a TA; integrations cannot replay", async () => {
    files.fixed = false;
    const other = sampleEnvelope({ tenantId: randomUUID() });
    await publish(Buffer.from(JSON.stringify(other)));
    const foreign = (await waitFor(() => recordFor({ eventId: other.eventId, status: "OPEN" })))._id.toHexString();
    const ta = user(tenant, ["TENANT_ADMIN"]);
    expect(await code(service.getDeadLetter(ta, undefined, foreign))).toBe("DEAD_LETTER_NOT_FOUND");
    expect(await code(service.replayDeadLetter(ta, undefined, foreign))).toBe("DEAD_LETTER_NOT_FOUND");
    expect(await code(service.discardDeadLetter(ta, undefined, foreign, "not mine"))).toBe("DEAD_LETTER_NOT_FOUND");
    expect(await code(service.getDeadLetter(ta, undefined, poisonId))).toBe("DEAD_LETTER_NOT_FOUND");
    expect(await code(service.replayDeadLetter(ta, tenant, foreign))).toBe("FORBIDDEN");
    const integration = { ...platformAdmin, kind: "integration", clientId: "ci" } as unknown as UserPrincipal;
    expect(await code(service.replayDeadLetter(integration, undefined, foreign))).toBe("FORBIDDEN");
    await service.discardDeadLetter(platformAdmin, undefined, foreign, "authz test");
  });

  it("a dead letter naming another tenant opens its own record instead of overwriting (tenant in identity)", async () => {
    const shared = randomUUID();
    const mk = (t: string): Buffer => Buffer.from(JSON.stringify(sampleEnvelope({ eventId: shared, tenantId: t })));
    const headers = { "x-aegis-original-queue": "files.validation.q", "x-aegis-error-code": "NOT_FOUND" };
    const a = await service.recordDeadLetter({
      content: mk(tenant),
      headers,
      messageId: shared,
      routingKey: "files.validation.q",
    });
    const b = await service.recordDeadLetter({
      content: mk(randomUUID()),
      headers,
      messageId: shared,
      routingKey: "files.validation.q",
    });
    expect(b._id.toHexString()).not.toBe(a._id.toHexString());
    expect((await recordFor({ _id: a._id }))?.tenantId).toBe(tenant);
    for (const d of [a, b]) await service.discardDeadLetter(platformAdmin, undefined, d._id.toHexString(), "test");
  });

  it("refuses to replay a suspect record whose queue header disagrees with the routing key", async () => {
    const env = sampleEnvelope({ tenantId: tenant });
    const doc = await service.recordDeadLetter({
      content: Buffer.from(JSON.stringify(env)),
      headers: { "x-aegis-original-queue": "cases.audit-ingest.q", "x-aegis-error-code": "NOT_FOUND" },
      messageId: env.eventId,
      routingKey: "files.validation.q",
    });
    expect(doc).toMatchObject({ queue: "files.validation.q", queueHeaderMismatch: true });
    expect(await code(service.replayDeadLetter(platformAdmin, undefined, doc._id.toHexString()))).toBe(
      "VALIDATION_ERROR",
    );
    await service.discardDeadLetter(platformAdmin, undefined, doc._id.toHexString(), "suspect");
  });

  it("discard needs a reason and a person; tenantless records are audited under the platform tenant", async () => {
    expect(await code(service.discardDeadLetter(platformAdmin, undefined, poisonId, "   "))).toBe("VALIDATION_ERROR");
    const integration = { ...platformAdmin, kind: "integration", clientId: "ci" } as unknown as UserPrincipal;
    expect(await code(service.discardDeadLetter(integration, undefined, poisonId, "x"))).toBe("FORBIDDEN");
    const done = await service.discardDeadLetter(platformAdmin, undefined, poisonId, " producer bug fixed ");
    expect(done).toMatchObject({ status: "DISCARDED", reason: "producer bug fixed" });
    const audit = await outboxFor("ops.audit.dead_letter_resolved", poisonId);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.["envelope"]).toMatchObject({
      tenantId: PLATFORM_TENANT_ID,
      payload: { action: "DISCARDED", reason: "producer bug fixed", originalEventId: null },
    });
  });

  it("a failure after a replay opens a new record (history kept)", async () => {
    files.fixed = false;
    await publish(Buffer.from(JSON.stringify(envelope)));
    await waitFor(async () =>
      (await db.collection("dead_letters").countDocuments({ eventId: envelope.eventId })) === 2 ? true : undefined,
    );
    const open = await recordFor({ eventId: envelope.eventId, status: "OPEN" });
    expect(open?._id.toHexString()).not.toBe(deadLetterId);
  });
});
