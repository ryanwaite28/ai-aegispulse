// FR-FILE-10/12 against real PostgreSQL (svc_files, RLS + V5 definers), Redis (files ACL) and SeaweedFS (files
// identity incl. the artifacts write grant): orphan flood, retention purge with tombstones, soft delete.
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { CreateBucketCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServicePrincipal, UserPrincipal } from "@aegispulse/ts-platform/auth";
import { IdempotencyRepository } from "@aegispulse/ts-platform/idempotency";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { OutboxRepository, withTenantTransaction } from "@aegispulse/ts-platform/outbox";
import {
  startObjectStore,
  startPostgres,
  startRedis,
  type ObjectStoreEnv,
  type PostgresEnv,
  type RedisEnv,
} from "../../../../packages/ts-platform/tests/integration/env.js";
import { FilesRepository } from "../../src/db/files.repository.js";
import type { FileStatus } from "../../src/domain/file.js";
import { FileMaintenanceService } from "../../src/service/file-maintenance.service.js";
import { FileQueryService } from "../../src/service/file-query.service.js";
import { FileUploadService } from "../../src/service/file-upload.service.js";
import {
  RedisDedupIndex,
  RedisFileStatusCache,
  RedisUploadSessions,
  S3DownloadSigner,
  S3MaintenanceStore,
  S3UploadStore,
} from "../../src/storage/upload-infra.js";

const logger = createLogger({
  service: "files",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const RAW = "aegispulse-local-raw";
const QUARANTINE = "aegispulse-local-quarantine";
const ARTIFACTS = "aegispulse-local-artifacts";
const scheduler: ServicePrincipal = {
  kind: "service",
  clientId: "svc-scheduler-trigger",
  actions: ["files.sweepOrphans", "files.purgeRetention"],
};

let db: PostgresEnv;
let cache: RedisEnv;
let store: ObjectStoreEnv;
let redis: Redis;
let s3: S3Client;
let admin: S3Client;
let uploads: FileUploadService;
let maintenance: FileMaintenanceService;
let queries: FileQueryService;
const retention = new Map<string, number>();

const user = (tenantId: string, roles: string[] = ["ANALYST"]): UserPrincipal => ({
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
const objectsUnder = async (bucket: string, prefix: string): Promise<number> =>
  (await admin.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))).KeyCount ?? 0;

/** SCAN, not KEYS: the files ACL user has no @dangerous commands (the service uses SCAN too). */
async function scanKeys(pattern: string): Promise<string[]> {
  const out: string[] = [];
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    out.push(...keys);
    cursor = next;
  } while (cursor !== "0");
  return out;
}

async function backdate(tenant: string, fileId: string, ms: number): Promise<void> {
  await withTenantTransaction(db.pool, tenant, async (tx) => {
    await tx.query("UPDATE files.files SET created_at = now() - make_interval(secs => $2) WHERE id = $1", [
      fileId,
      ms / 1000,
    ]);
  });
}

async function seed(
  tenant: string,
  status: FileStatus,
  ageDays: number,
  withArtifact = false,
): Promise<{ fileId: string; key: string; bucket: string; artifactKey?: string }> {
  const fileId = randomUUID();
  const bucket = status === "QUARANTINED" ? QUARANTINE : RAW;
  const key = status === "QUARANTINED" ? `quarantine/${tenant}/${fileId}` : `raw/${tenant}/2025/01/01/${fileId}`;
  const body = `%PDF-1.7 ${fileId}`;
  await withTenantTransaction(db.pool, tenant, async (tx) => {
    await tx.query(
      `INSERT INTO files.files (id, tenant_id, original_filename, storage_bucket, storage_key, content_type, size_bytes,
                                sha256_checksum, source_type, purpose, status, correlation_id, created_at)
       VALUES ($1, $2, 'f.pdf', $3, $4, 'application/pdf', $5, $6, 'AD_HOC_UPLOAD', 'FILING', $7, 'corr-test',
               now() - make_interval(days => $8))`,
      [fileId, tenant, bucket, key, body.length, createHash("sha256").update(body).digest("hex"), status, ageDays],
    );
  });
  await admin.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  if (!withArtifact) return { fileId, key, bucket };
  const artifactKey = `artifacts/${tenant}/${fileId}/extract-1.0.0/extraction.json`;
  await admin.send(new PutObjectCommand({ Bucket: ARTIFACTS, Key: artifactKey, Body: "{}" }));
  await withTenantTransaction(db.pool, tenant, async (tx) => {
    await tx.query(
      `INSERT INTO files.file_artifacts (tenant_id, file_id, extractor_version, result_status, confidence, extraction_key, summary)
       VALUES ($1, $2, 'extract-1.0.0', 'COMPLETED', 0.9, $3, '{}')`,
      [tenant, fileId, artifactKey],
    );
  });
  return { fileId, key, bucket, artifactKey };
}

beforeAll(async () => {
  [db, cache, store] = await Promise.all([
    startPostgres("files"),
    startRedis("files", "REDIS_PASSWORD_FILES"),
    startObjectStore(),
  ]);
  const client = (k: string, s: string, extra: Partial<ConstructorParameters<typeof S3Client>[0]> = {}): S3Client =>
    new S3Client({
      endpoint: store.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: store.secrets[k] ?? "", secretAccessKey: store.secrets[s] ?? "" },
      ...extra,
    });
  admin = client("S3_ADMIN_ACCESS_KEY", "S3_ADMIN_SECRET_KEY");
  for (const bucket of [RAW, QUARANTINE, ARTIFACTS]) {
    for (let attempt = 0; ; attempt++) {
      try {
        await admin.send(new CreateBucketCommand({ Bucket: bucket }));
        break;
      } catch (error: unknown) {
        if (attempt > 30) throw error;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
  s3 = client("S3_FILES_ACCESS_KEY", "S3_FILES_SECRET_KEY");
  const presigner = client("S3_FILES_ACCESS_KEY", "S3_FILES_SECRET_KEY", {
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  redis = new Redis(cache.url, { maxRetriesPerRequest: 1 });
  const statusCache = new RedisFileStatusCache(redis);
  const common = {
    pool: db.pool,
    files: new FilesRepository(),
    outbox: new OutboxRepository("files"),
    version: "abc1234",
    logger,
  };
  uploads = new FileUploadService({
    ...common,
    idempotency: new IdempotencyRepository("files"),
    sessions: new RedisUploadSessions(redis),
    dedup: new RedisDedupIndex(redis),
    rate: { take: () => Promise.resolve(true) }, // the flood is about orphans, not the 60/min quota
    objects: new S3UploadStore(s3, presigner, RAW),
    statusCache,
    tenants: { status: () => Promise.resolve("ACTIVE") },
  });
  maintenance = new FileMaintenanceService({
    ...common,
    objects: new S3MaintenanceStore(s3, ARTIFACTS),
    sessions: new RedisUploadSessions(redis),
    dedup: new RedisDedupIndex(redis),
    statusCache,
    downloads: statusCache,
    tenants: { retentionDays: (t) => Promise.resolve(retention.get(t)) },
  });
  queries = new FileQueryService({ ...common, signer: new S3DownloadSigner(s3, s3), cache: statusCache });
}, 900_000);

afterAll(async () => {
  redis?.disconnect();
  s3?.destroy();
  admin?.destroy();
  await Promise.all([db?.stop(), cache?.stop(), store?.stop()]);
});

describe("orphan sweep (FR-FILE-10)", () => {
  it("orphan flood: 100 inits without complete → all EXPIRED after 1 h, no leaked objects, sessions/dedup released; young ones kept", async () => {
    const tenant = randomUUID();
    const p = user(tenant);
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const body = Buffer.from(`orphan ${String(i)} ${randomUUID()}`);
      const init = await uploads.initUpload(p, undefined, undefined, {
        filename: "o.txt",
        contentType: "text/plain",
        sizeBytes: body.length,
        sha256: createHash("sha256").update(body).digest("hex"),
        purpose: "OTHER",
      });
      ids.push(init.body.fileId);
      if (i % 4 === 0) {
        // Some clients PUT but never call complete: those objects must not leak either.
        const up = init.body.upload;
        if (up === undefined) throw new Error("no upload");
        expect(
          (await fetch(up.url, { method: "PUT", headers: up.headers as Record<string, string>, body })).status,
        ).toBe(200);
      }
      await backdate(tenant, init.body.fileId, 2 * 3600 * 1000);
    }
    const young = await uploads.initUpload(p, undefined, undefined, {
      filename: "y.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      sha256: createHash("sha256").update("young").digest("hex"),
      purpose: "OTHER",
    });
    expect(await objectsUnder(RAW, `raw/${tenant}/`)).toBe(25);

    const run = await maintenance.sweepOrphans(scheduler);
    expect(run.processedCount).toBeGreaterThanOrEqual(100);
    const statuses = await withTenantTransaction(
      db.pool,
      tenant,
      async (tx) =>
        (
          await tx.query<{ status: string; n: string }>(
            "SELECT status, count(*) AS n FROM files.files GROUP BY status ORDER BY status",
          )
        ).rows,
    );
    expect(statuses).toEqual([
      { status: "EXPIRED", n: "100" },
      { status: "INITIATED", n: "1" },
    ]);
    expect(await objectsUnder(RAW, `raw/${tenant}/`)).toBe(0);
    expect(await redis.exists(`upload:session:${String(ids[0])}`)).toBe(0);
    expect(await redis.exists(`upload:session:${young.body.fileId}`)).toBe(1);
    const events = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM files.outbox_events
        WHERE routing_key = 'file.status.changed' AND envelope->'payload'->>'reason' = 'ORPHAN_TIMEOUT' AND envelope->>'tenantId' = $1`,
      [tenant],
    );
    expect(events.rows[0]?.n).toBe("100");
    // Idempotent: nothing left for this tenant; a user token may not run it.
    await maintenance.sweepOrphans(scheduler);
    expect(await code(maintenance.sweepOrphans(p))).toBe("FORBIDDEN");
  });
});

describe("retention purge and delete (FR-FILE-12)", () => {
  it("purges objects + artifacts past retentionDays into tombstones; younger files and unknown tenants untouched", async () => {
    const tenant = randomUUID();
    retention.set(tenant, 30);
    const old = await seed(tenant, "PROCESSED", 40, true);
    const oldQ = await seed(tenant, "QUARANTINED", 45);
    const fresh = await seed(tenant, "VALIDATED", 10);
    const unknownTenant = randomUUID(); // no retention entry → registry "unknown" → skipped
    const orphanTenantFile = await seed(unknownTenant, "VALIDATED", 4000);

    const run = await maintenance.purgeRetention(scheduler);
    expect(run.processedCount).toBe(2);
    expect(await objectsUnder(RAW, old.key)).toBe(0);
    expect(await objectsUnder(QUARANTINE, oldQ.key)).toBe(0);
    expect(await objectsUnder(ARTIFACTS, old.artifactKey ?? "")).toBe(0);
    expect(await objectsUnder(RAW, fresh.key)).toBe(1);
    expect(await objectsUnder(RAW, orphanTenantFile.key)).toBe(1);
    const rows = await withTenantTransaction(
      db.pool,
      tenant,
      async (tx) =>
        (
          await tx.query<{ id: string; purged: boolean; deleted: boolean; artifacts: string }>(
            `SELECT f.id, f.purged_at IS NOT NULL AS purged, f.deleted_at IS NOT NULL AS deleted,
                  (SELECT count(*) FROM files.file_artifacts a WHERE a.file_id = f.id) AS artifacts
             FROM files.files f ORDER BY f.created_at`,
          )
        ).rows,
    );
    expect(rows).toEqual([
      { id: oldQ.fileId, purged: true, deleted: true, artifacts: "0" },
      { id: old.fileId, purged: true, deleted: true, artifacts: "0" },
      { id: fresh.fileId, purged: false, deleted: false, artifacts: "0" },
    ]);
    expect((await maintenance.purgeRetention(scheduler)).processedCount).toBe(0);
    expect(await code(queries.getFile(user(tenant), undefined, old.fileId))).toBe("NOT_FOUND");
  });

  it("deleteFile: TENANT_ADMIN soft delete (object kept), audited in history, caches dropped; others 403; repeat 404", async () => {
    const tenant = randomUUID();
    const f = await seed(tenant, "VALIDATED", 1);
    const analyst = user(tenant);
    await queries.getFile(analyst, undefined, f.fileId);
    await queries.getDownloadUrl(analyst, undefined, { fileId: f.fileId });
    expect(await scanKeys(`file:dlurl:${f.fileId}:*`)).toHaveLength(1);

    expect(await code(maintenance.deleteFile(analyst, undefined, { fileId: f.fileId }))).toBe("FORBIDDEN");
    const ta = user(tenant, ["TENANT_ADMIN"]);
    await maintenance.deleteFile(ta, undefined, { fileId: f.fileId });
    expect(await redis.exists(`file:status:${f.fileId}`)).toBe(0);
    expect(await scanKeys(`file:dlurl:${f.fileId}:*`)).toHaveLength(0);
    expect(await code(queries.getFile(analyst, undefined, f.fileId))).toBe("NOT_FOUND");
    expect(await code(queries.getDownloadUrl(analyst, undefined, { fileId: f.fileId }))).toBe("NOT_FOUND");
    expect((await queries.listFiles(analyst, undefined, {})).items.map((x) => x.id)).not.toContain(f.fileId);
    expect(await objectsUnder(RAW, f.key)).toBe(1); // retained until the purge
    const history = await withTenantTransaction(
      db.pool,
      tenant,
      async (tx) =>
        (
          await tx.query<{ reason: string; actor: string }>(
            "SELECT reason, actor FROM files.file_status_history WHERE file_id = $1 AND reason = 'DELETED'",
            [f.fileId],
          )
        ).rows,
    );
    expect(history).toEqual([{ reason: "DELETED", actor: `user:${ta.userId}` }]);
    const audit = await db.pool.query<{ x: string; p: Record<string, unknown> }>(
      "SELECT exchange AS x, envelope->'payload' AS p FROM files.outbox_events WHERE routing_key = 'ops.audit.file_deleted' AND envelope->'payload'->>'fileId' = $1",
      [f.fileId],
    );
    expect(audit.rows).toEqual([{ x: "aegispulse.intelligence", p: { fileId: f.fileId, actorId: ta.userId } }]);
    expect(await code(maintenance.deleteFile(ta, undefined, { fileId: f.fileId }))).toBe("NOT_FOUND");
    expect(
      await code(maintenance.deleteFile(user(randomUUID(), ["TENANT_ADMIN"]), undefined, { fileId: randomUUID() })),
    ).toBe("NOT_FOUND");
  });
});
