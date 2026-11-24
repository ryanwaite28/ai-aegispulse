// FR-WHK-02..05 end to end inside ingestion, against real PostgreSQL (svc_ingestion, RLS), Redis (ingestion ACL user),
// SeaweedFS (ingestion's prefix-restricted identity) and RabbitMQ (contract topology, configure-'^$' runtime user).
// Tenant status is a port (the registry call is covered by the compose E2E).
import { randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { CreateBucketCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AmqpPublisher, createAmqpClient, type AegisAmqpClient } from "@aegispulse/ts-platform/amqp";
import type { ServicePrincipal, UserPrincipal } from "@aegispulse/ts-platform/auth";
import { IdempotencyRepository } from "@aegispulse/ts-platform/idempotency";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { OutboxRelay, OutboxRepository } from "@aegispulse/ts-platform/outbox";
import {
  bindTestQueue,
  drainQueue,
  startBroker,
  startObjectStore,
  startPostgres,
  startRedis,
  type BrokerEnv,
  type ObjectStoreEnv,
  type PostgresEnv,
  type RedisEnv,
} from "../../../../packages/ts-platform/tests/integration/env.js";
import { WebhookDeliveryRepository } from "../../src/db/webhook-deliveries.repository.js";
import { WebhookSourceRepository } from "../../src/db/webhook-sources.repository.js";
import { parseKek } from "../../src/domain/crypto.js";
import { sign } from "../../src/domain/signature.js";
import { IngestWebhookUseCase, type IngestInput } from "../../src/service/orchestrators/ingest-webhook.usecase.js";
import { WebhookSourceService } from "../../src/service/webhook-source.service.js";
import { RedisNonceStore, S3RawStore } from "../../src/storage/webhook-infra.js";

const logger = createLogger({
  service: "ingestion",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const kek = parseKek(randomBytes(32).toString("base64"), 1);
const BUCKET = "aegispulse-local-raw";
const gateway: ServicePrincipal = {
  kind: "service",
  clientId: "svc-gateway",
  actions: ["ingestion.ingestWebhookDelivery"],
};

let db: PostgresEnv;
let broker: BrokerEnv;
let cache: RedisEnv;
let store: ObjectStoreEnv;
let amqp: AegisAmqpClient;
let redis: Redis;
let s3: S3Client;
let sources: WebhookSourceService;
let usecase: IngestWebhookUseCase;
let suspended = new Set<string>();
let nowMs = Date.parse("2026-11-24T12:00:00Z");

const ta = (tenantId: string): UserPrincipal => ({
  kind: "user",
  userId: randomUUID(),
  tenantId,
  tenantSlug: "t",
  roles: ["TENANT_ADMIN"],
  tokenId: randomUUID(),
});
const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  return (e as { code?: string }).code ?? `no error: ${JSON.stringify(e)}`;
};

function delivery(
  sourceKey: string,
  secret: string,
  body: unknown,
  opts: { deliveryId?: string; ts?: number; rawOverride?: Buffer } = {},
): IngestInput {
  const raw = opts.rawOverride ?? Buffer.from(JSON.stringify(body));
  const ts = opts.ts ?? Math.floor(nowMs / 1000);
  const deliveryId = opts.deliveryId ?? `d-${randomUUID()}`;
  return {
    sourceKey,
    headers: {
      "X-Aegis-Signature": sign(secret, ts, deliveryId, raw),
      "X-Aegis-Timestamp": String(ts),
      "X-Aegis-Delivery-Id": deliveryId,
    },
    rawBodyBase64: raw.toString("base64"),
    receivedAt: new Date(nowMs).toISOString(),
    clientIp: "203.0.113.7",
  };
}

const event = (externalId: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  externalId,
  category: "MARKET_ALERT",
  title: "Unusual volume",
  publishedAt: "2026-11-24T11:59:00Z",
  severity: "HIGH",
  body: "full text that must never reach the broker",
  ...extra,
});

beforeAll(async () => {
  [db, broker, cache, store] = await Promise.all([
    startPostgres("ingestion"),
    startBroker(),
    startRedis("ingestion", "REDIS_PASSWORD_INGESTION"),
    startObjectStore(),
  ]);
  const admin = new S3Client({
    endpoint: store.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: store.secrets["S3_ADMIN_ACCESS_KEY"] ?? "",
      secretAccessKey: store.secrets["S3_ADMIN_SECRET_KEY"] ?? "",
    },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
      break;
    } catch (error: unknown) {
      if (attempt > 30) throw error;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  admin.destroy();
  s3 = new S3Client({
    endpoint: store.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: store.secrets["S3_INGESTION_ACCESS_KEY"] ?? "",
      secretAccessKey: store.secrets["S3_INGESTION_SECRET_KEY"] ?? "",
    },
  });
  redis = new Redis(cache.url, { maxRetriesPerRequest: 1 });
  const url = await broker.addRuntimeUser({
    name: "svc_ingestion",
    write: "^aegispulse\\.(ingress|intelligence)$",
    read: "^$",
  });
  amqp = createAmqpClient({
    url,
    service: "ingestion-test",
    logger,
    publishesTo: ["aegispulse.ingress", "aegispulse.intelligence"],
  });
  await amqp.init();
  const outbox = new OutboxRepository("ingestion");
  sources = new WebhookSourceService({
    pool: db.pool,
    sources: new WebhookSourceRepository(),
    outbox,
    idempotency: new IdempotencyRepository("ingestion"),
    kek,
    version: "abc1234",
    logger,
    now: () => new Date(nowMs),
  });
  usecase = new IngestWebhookUseCase({
    pool: db.pool,
    deliveries: new WebhookDeliveryRepository(),
    outbox,
    nonces: new RedisNonceStore(redis),
    raw: new S3RawStore(s3, BUCKET),
    tenants: { isActive: (t) => Promise.resolve(!suspended.has(t)) },
    kek,
    version: "abc1234",
    logger,
    now: () => nowMs,
  });
}, 900_000);

afterAll(async () => {
  await amqp?.close({ drainTimeoutMs: 1000 });
  redis?.disconnect();
  s3?.destroy();
  await Promise.all([db?.stop(), broker?.stop(), cache?.stop(), store?.stop()]);
});

describe("webhook ingest (FR-WHK-02..05)", () => {
  it("FR-WHK-05 accepted webhook: raw body stored, delivery row, exactly one event on external.# across 3 relay restarts", async () => {
    const tenant = randomUUID();
    const src = await sources.create(ta(tenant), undefined, {
      sourceKey: `ingest-${randomUUID().slice(0, 8)}`,
      displayName: "S",
    });
    const queue = await bindTestQueue(broker.adminUrl, "aegispulse.ingress", "external.#");
    const input = delivery(src.sourceKey, src.signingSecret, event("alert-1"));
    const result = await usecase.execute(gateway, input);
    expect(result.duplicate).toBe(false);
    expect(result.eventId).toMatch(/^[0-9a-f-]{36}$/);

    const relays = Array.from(
      { length: 3 },
      () =>
        new OutboxRelay({
          pool: db.pool,
          repository: new OutboxRepository("ingestion"),
          publisher: new AmqpPublisher(amqp),
          logger,
        }),
    );
    for (const relay of relays) {
      relay.start();
      await relay.runOnce();
      await relay.stop();
    }
    await new Promise((r) => setTimeout(r, 500));
    const messages = (await drainQueue(broker.adminUrl, queue)) as {
      eventId: string;
      eventType: string;
      payload: Record<string, unknown>;
      classification: Record<string, unknown>;
      idempotencyKey: string;
    }[];
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m?.eventId).toBe(result.eventId);
    expect(m?.eventType).toBe("external.market.alert");
    expect(m?.idempotencyKey).toBe(`${src.sourceKey}:alert-1:v1`);
    expect(m?.classification).toMatchObject({ publisher_stated_severity: "HIGH" });
    expect(JSON.stringify(m)).not.toContain("full text that must never reach the broker");

    const stored = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: String(m?.payload["rawStorageKey"]) }));
    expect(await stored.Body?.transformToString()).toBe(Buffer.from(input.rawBodyBase64, "base64").toString("utf8"));
    expect(String(m?.payload["rawStorageKey"])).toMatch(
      new RegExp(`^raw/webhooks/${tenant}/2026/11/24/[0-9a-f-]{36}\\.json$`),
    );
  });

  it("FR-WHK-05 same idempotency key → 202 duplicate:true, DUPLICATE row, no second event", async () => {
    const tenant = randomUUID();
    const src = await sources.create(ta(tenant), undefined, {
      sourceKey: `dup-${randomUUID().slice(0, 8)}`,
      displayName: "D",
    });
    const first = await usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, event("same-1")));
    const second = await usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, event("same-1")));
    expect(second).toMatchObject({ duplicate: true, eventId: null });
    const v2 = await usecase.execute(
      gateway,
      delivery(src.sourceKey, src.signingSecret, event("same-1", { version: 2 })),
    );
    expect(v2.duplicate).toBe(false); // a new version is a new event
    const outbox = await db.pool.query<{ n: string }>(
      "SELECT count(*) AS n FROM ingestion.outbox_events WHERE envelope->>'tenantId' = $1",
      [tenant],
    );
    expect(Number(outbox.rows[0]?.n)).toBe(2);
    const page = await usecase.listDeliveries(ta(tenant), { sourceId: src.id });
    expect(page.items.map((d) => d.outcome).sort()).toEqual(["ACCEPTED", "ACCEPTED", "DUPLICATE"]);
    expect(JSON.stringify(page)).not.toContain("full text");
    expect(first.eventId).not.toBeNull();
  });

  it("FR-WHK-03 rejections: unknown/disabled source, suspended tenant, bad signature, skew, replay, schema, size", async () => {
    const tenant = randomUUID();
    const src = await sources.create(ta(tenant), undefined, {
      sourceKey: `adv-${randomUUID().slice(0, 8)}`,
      displayName: "A",
    });
    const ok = event("adv-1");
    expect(await code(usecase.execute(gateway, delivery("no-such-source", src.signingSecret, ok)))).toBe(
      "WEBHOOK_SOURCE_NOT_FOUND",
    );
    expect(await code(usecase.execute(gateway, delivery(src.sourceKey, "wrong-secret", ok)))).toBe(
      "WEBHOOK_SIGNATURE_INVALID",
    );
    const truncated = delivery(src.sourceKey, src.signingSecret, ok);
    expect(
      await code(
        usecase.execute(gateway, {
          ...truncated,
          headers: { ...truncated.headers, "X-Aegis-Signature": truncated.headers["X-Aegis-Signature"]?.slice(0, -4) },
        }),
      ),
    ).toBe("WEBHOOK_SIGNATURE_INVALID");
    expect(
      await code(
        usecase.execute(gateway, {
          ...truncated,
          headers: { "X-Aegis-Timestamp": truncated.headers["X-Aegis-Timestamp"] },
        }),
      ),
    ).toBe("WEBHOOK_SIGNATURE_INVALID");
    const ts = Math.floor(nowMs / 1000);
    expect(await code(usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, ok, { ts: ts - 301 })))).toBe(
      "WEBHOOK_TIMESTAMP_SKEW",
    );
    expect(await code(usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, ok, { ts: ts + 301 })))).toBe(
      "WEBHOOK_TIMESTAMP_SKEW",
    );
    const replay = delivery(src.sourceKey, src.signingSecret, ok, { deliveryId: "same-delivery" });
    expect((await usecase.execute(gateway, replay)).duplicate).toBe(false);
    expect(await code(usecase.execute(gateway, replay))).toBe("WEBHOOK_REPLAY_DETECTED");
    expect(
      await code(
        usecase.execute(
          gateway,
          delivery(src.sourceKey, src.signingSecret, null, { rawOverride: Buffer.from("{not json") }),
        ),
      ),
    ).toBe("VALIDATION_ERROR");
    expect(
      await code(usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, { ...ok, category: "NOPE" }))),
    ).toBe("VALIDATION_ERROR");
    expect(
      await code(
        usecase.execute(
          gateway,
          delivery(src.sourceKey, src.signingSecret, null, { rawOverride: Buffer.alloc(1024 * 1024 + 1, 0x20) }),
        ),
      ),
    ).toBe("PAYLOAD_TOO_LARGE");
    suspended.add(tenant);
    expect(await code(usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, ok)))).toBe(
      "TENANT_SUSPENDED",
    );
    suspended = new Set();
    await sources.update(ta(tenant), undefined, { sourceId: src.id, status: "DISABLED" });
    expect(await code(usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, ok)))).toBe(
      "WEBHOOK_SOURCE_NOT_FOUND",
    );
    const user = ta(tenant);
    expect(await code(usecase.execute(user, delivery(src.sourceKey, src.signingSecret, ok)))).toBe("FORBIDDEN");
  });

  it("FR-WHK-07 the previous secret verifies for 72 h after a rotation, then stops", async () => {
    const tenant = randomUUID();
    const src = await sources.create(ta(tenant), undefined, {
      sourceKey: `rot-${randomUUID().slice(0, 8)}`,
      displayName: "R",
    });
    const rotated = await sources.rotate(ta(tenant), undefined, src.id);
    expect((await usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, event("r-1")))).duplicate).toBe(
      false,
    );
    expect(
      (await usecase.execute(gateway, delivery(src.sourceKey, rotated.signingSecret, event("r-2")))).duplicate,
    ).toBe(false);
    const listed = await usecase.listDeliveries(ta(tenant), { sourceId: src.id });
    expect(listed.items.map((d) => d.signatureSlot).sort()).toEqual(["CURRENT", "PREVIOUS"]);
    nowMs += 72 * 3600 * 1000 + 60_000;
    try {
      expect(await code(usecase.execute(gateway, delivery(src.sourceKey, src.signingSecret, event("r-3"))))).toBe(
        "WEBHOOK_SIGNATURE_INVALID",
      );
      expect(
        (await usecase.execute(gateway, delivery(src.sourceKey, rotated.signingSecret, event("r-4")))).duplicate,
      ).toBe(false);
    } finally {
      nowMs = Date.parse("2026-11-24T12:00:00Z");
    }
  });
});
