// FR-FILE-01..04 against real PostgreSQL (svc_files, RLS), Redis (files ACL user) and SeaweedFS (files identity,
// presigned PUT through the S3 API). Tenant status is a port (the registry call is covered by the compose E2E).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { CreateBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PLATFORM_TENANT_ID, type Principal, type UserPrincipal } from "@aegispulse/ts-platform/auth";
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
import { STORAGE_QUOTA_BYTES } from "../../src/domain/file.js";
import { FileUploadService, type InitUploadInput } from "../../src/service/file-upload.service.js";
import {
  RedisDedupIndex,
  RedisFileStatusCache,
  RedisInitRateLimiter,
  RedisUploadSessions,
  S3UploadStore,
} from "../../src/storage/upload-infra.js";

const logger = createLogger({
  service: "files",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const BUCKET = "aegispulse-local-raw";

let db: PostgresEnv;
let cache: RedisEnv;
let store: ObjectStoreEnv;
let redis: Redis;
let s3: S3Client;
let presigner: S3Client;
let service: FileUploadService;
const suspended = new Set<string>();

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
  return (e as { code?: string }).code ?? `no error: ${JSON.stringify(e).slice(0, 200)}`;
};
function content(text = randomUUID()): { body: Buffer; input: InitUploadInput } {
  const body = Buffer.from(`%PDF-1.7 demo ${text}`);
  return {
    body,
    input: {
      filename: "report.pdf",
      contentType: "application/pdf",
      sizeBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      purpose: "FILING",
    },
  };
}
async function put(url: string, headers: Record<string, string>, body: Buffer): Promise<number> {
  return (await fetch(url, { method: "PUT", headers, body })).status;
}
async function outboxTypes(fileId: string): Promise<string[]> {
  const r = await db.pool.query<{ t: string }>(
    "SELECT routing_key AS t FROM files.outbox_events WHERE envelope->'payload'->>'fileId' = $1 ORDER BY created_at, routing_key",
    [fileId],
  );
  return r.rows.map((x) => x.t);
}

function s3Client(
  endpoint: string,
  key: string,
  secret: string,
  extra: Partial<ConstructorParameters<typeof S3Client>[0]> = {},
): S3Client {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: store.secrets[key] ?? "", secretAccessKey: store.secrets[secret] ?? "" },
    ...extra,
  });
}

beforeAll(async () => {
  [db, cache, store] = await Promise.all([
    startPostgres("files"),
    startRedis("files", "REDIS_PASSWORD_FILES"),
    startObjectStore(),
  ]);
  const admin = s3Client(store.endpoint, "S3_ADMIN_ACCESS_KEY", "S3_ADMIN_SECRET_KEY");
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
  s3 = s3Client(store.endpoint, "S3_FILES_ACCESS_KEY", "S3_FILES_SECRET_KEY");
  presigner = s3Client(store.endpoint, "S3_FILES_ACCESS_KEY", "S3_FILES_SECRET_KEY", {
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
  redis = new Redis(cache.url, { maxRetriesPerRequest: 1 });
  service = new FileUploadService({
    pool: db.pool,
    files: new FilesRepository(),
    outbox: new OutboxRepository("files"),
    idempotency: new IdempotencyRepository("files"),
    sessions: new RedisUploadSessions(redis),
    dedup: new RedisDedupIndex(redis),
    rate: new RedisInitRateLimiter(redis),
    objects: new S3UploadStore(s3, presigner, BUCKET),
    statusCache: new RedisFileStatusCache(redis),
    tenants: { status: (t) => Promise.resolve(suspended.has(t) ? "SUSPENDED" : "ACTIVE") },
    version: "abc1234",
    logger,
  });
}, 900_000);

afterAll(async () => {
  redis?.disconnect();
  s3?.destroy();
  presigner?.destroy();
  await Promise.all([db?.stop(), cache?.stop(), store?.stop()]);
});

describe("uploads (FR-FILE-01..04)", () => {
  it("FR-FILE-01/04 init → presigned PUT (signed type + length) → complete → UPLOADED with file.uploaded + file.status.changed", async () => {
    const tenant = randomUUID();
    const integ: Principal = {
      kind: "integration",
      clientId: "int-feed",
      tenantId: tenant,
      tenantSlug: "t",
      roles: ["INTEGRATION"],
      tokenId: "x",
    };
    const { body, input } = content();
    const init = await service.initUpload(integ, undefined, undefined, input);
    expect(init.httpStatus).toBe(201);
    expect(init.body).toMatchObject({ status: "INITIATED", deduplicated: false, upload: { method: "PUT" } });
    const upload = init.body.upload;
    if (upload === undefined) throw new Error("no upload");
    const fileId = init.body.fileId;
    expect(upload.url).toContain(`/raw/${tenant}/`);
    expect(upload.url).toContain(fileId);
    expect(upload.url).not.toContain("report.pdf");
    // The signature covers Content-Type and Content-Length: a different type is refused by the object store.
    expect(await put(upload.url, { ...upload.headers, "Content-Type": "text/plain" }, body)).toBe(403);
    expect(await put(upload.url, upload.headers as Record<string, string>, body)).toBe(200);

    const done = await service.completeUpload(integ, undefined, undefined, { fileId });
    expect(done.status).toBe("UPLOADED");
    expect(await outboxTypes(fileId)).toEqual(["file.status.changed", "file.uploaded"]);
    expect(await redis.exists(`upload:session:${fileId}`)).toBe(0);
    // Double complete: idempotent 200 with the current status, no second event.
    expect((await service.completeUpload(integ, undefined, undefined, { fileId })).status).toBe("UPLOADED");
    expect(await outboxTypes(fileId)).toHaveLength(2);
    const history = await withTenantTransaction(
      db.pool,
      tenant,
      async (tx) =>
        (
          await tx.query<{ to_status: string; actor: string }>(
            "SELECT to_status, actor FROM files.file_status_history WHERE file_id = $1 ORDER BY created_at",
            [fileId],
          )
        ).rows,
    );
    expect(history).toEqual([
      { to_status: "INITIATED", actor: "integration:int-feed" },
      { to_status: "UPLOADED", actor: "integration:int-feed" },
    ]);
  });

  it("FR-FILE-04 complete without a PUT → 409 UPLOAD_NOT_FOUND_IN_STORAGE; size mismatch → 409; concurrent completes → one transition", async () => {
    const tenant = randomUUID();
    const p = user(tenant);
    const a = content();
    const init = await service.initUpload(p, undefined, undefined, a.input);
    expect(await code(service.completeUpload(p, undefined, undefined, { fileId: init.body.fileId }))).toBe(
      "UPLOAD_NOT_FOUND_IN_STORAGE",
    );

    const b = content();
    const initB = await service.initUpload(p, undefined, undefined, { ...b.input, sizeBytes: b.body.length + 1 });
    const urlB = initB.body.upload?.url ?? "";
    // The signed Content-Length refuses a short body through the URL …
    expect(
      await put(urlB, { "Content-Type": "application/pdf", "Content-Length": String(b.body.length) }, b.body),
    ).toBe(403);
    // … so a mismatch can only come from elsewhere (simulated with a direct write); complete still refuses it.
    const keyB = await withTenantTransaction(
      db.pool,
      tenant,
      async (tx) =>
        (await tx.query<{ k: string }>("SELECT storage_key AS k FROM files.files WHERE id = $1", [initB.body.fileId]))
          .rows[0]?.k ?? "",
    );
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: keyB, Body: b.body, ContentType: "application/pdf" }));
    expect(await code(service.completeUpload(p, undefined, undefined, { fileId: initB.body.fileId }))).toBe(
      "UPLOAD_SIZE_MISMATCH",
    );

    const c = content();
    const initC = await service.initUpload(p, undefined, undefined, c.input);
    const upC = initC.body.upload;
    if (upC === undefined) throw new Error("no upload");
    expect(await put(upC.url, upC.headers as Record<string, string>, c.body)).toBe(200);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => service.completeUpload(p, undefined, undefined, { fileId: initC.body.fileId })),
    );
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(["UPLOADED"]));
    expect(await outboxTypes(initC.body.fileId)).toEqual(["file.status.changed", "file.uploaded"]);
  });

  it("FR-FILE-02 a second init of the same content returns the existing id (200, no URL); allowDuplicate is ANALYST+", async () => {
    const tenant = randomUUID();
    const { input } = content();
    const first = await service.initUpload(user(tenant), undefined, undefined, input);
    const again = await service.initUpload(user(tenant), undefined, undefined, { ...input, filename: "other.pdf" });
    expect(again).toEqual({
      httpStatus: 200,
      body: { fileId: first.body.fileId, status: "INITIATED", deduplicated: true },
    });
    // Redis pointer lost → the DB index still finds it.
    await redis.del(`file:dedup:${tenant}:${input.sha256}`);
    expect((await service.initUpload(user(tenant), undefined, undefined, input)).body.fileId).toBe(first.body.fileId);
    // Another tenant never sees it.
    expect((await service.initUpload(user(randomUUID()), undefined, undefined, input)).body.deduplicated).toBe(false);
    const forced = await service.initUpload(user(tenant), undefined, undefined, { ...input, allowDuplicate: true });
    expect(forced.httpStatus).toBe(201);
    expect(forced.body.fileId).not.toBe(first.body.fileId);
    const integ: Principal = {
      kind: "integration",
      clientId: "c",
      tenantId: tenant,
      tenantSlug: "t",
      roles: ["INTEGRATION"],
      tokenId: "x",
    };
    expect(await code(service.initUpload(integ, undefined, undefined, { ...input, allowDuplicate: true }))).toBe(
      "FORBIDDEN",
    );
    // Aborting the original releases the pointer: the next init creates a new file.
    await service.abortUpload(user(tenant), undefined, undefined, { fileId: first.body.fileId });
    await service.abortUpload(user(tenant), undefined, undefined, { fileId: forced.body.fileId });
    expect((await service.initUpload(user(tenant), undefined, undefined, input)).body.deduplicated).toBe(false);
  });

  it("FR-FILE-03 60 inits/min per tenant → 429; storage quota → 413; suspended tenant → 403", async () => {
    const tenant = randomUUID();
    const p = user(tenant);
    // Bucket of 60 refilling at 1/s: 66 concurrent inits leave at least one refused and at most ~60 + elapsed seconds accepted.
    const started = Date.now();
    const settled = await Promise.allSettled(
      Array.from({ length: 66 }, () => service.initUpload(p, undefined, undefined, content().input)),
    );
    const elapsedS = Math.ceil((Date.now() - started) / 1000);
    const limited = settled.filter(
      (r) => r.status === "rejected" && (r.reason as { code?: string }).code === "UPLOAD_RATE_LIMITED",
    );
    const accepted = settled.filter((r) => r.status === "fulfilled");
    expect(limited.length + accepted.length).toBe(66);
    expect(limited.length).toBeGreaterThanOrEqual(1);
    expect(accepted.length).toBeGreaterThanOrEqual(60);
    expect(accepted.length).toBeLessThanOrEqual(60 + elapsedS);
    // The bucket is per tenant.
    expect((await service.initUpload(user(randomUUID()), undefined, undefined, content().input)).httpStatus).toBe(201);

    const full = randomUUID();
    await withTenantTransaction(db.pool, full, async (tx) => {
      await tx.query(
        `INSERT INTO files.files (tenant_id, original_filename, storage_bucket, storage_key, content_type, size_bytes,
                                  sha256_checksum, source_type, purpose, status, correlation_id)
         SELECT $1, 'big', 'b', 'k-' || g, 'application/pdf', 536870912, repeat('a', 64), 'AD_HOC_UPLOAD', 'OTHER', 'VALIDATED', 'c'
           FROM generate_series(1, $2::int) g`,
        [full, STORAGE_QUOTA_BYTES / 536_870_912],
      );
    });
    expect(await code(service.initUpload(user(full), undefined, undefined, content().input))).toBe(
      "STORAGE_QUOTA_EXCEEDED",
    );

    const s = randomUUID();
    suspended.add(s);
    expect(await code(service.initUpload(user(s), undefined, undefined, content().input))).toBe("TENANT_SUSPENDED");
  });

  it("FR-FILE-01 shape rules; the filename never reaches the key; PLATFORM_ADMIN acts via X-Aegis-Tenant only", async () => {
    const tenant = randomUUID();
    const p = user(tenant);
    expect(
      await code(service.initUpload(p, undefined, undefined, { ...content().input, contentType: "application/zip" })),
    ).toBe("FILE_TYPE_NOT_ALLOWED");
    expect(
      await code(service.initUpload(p, undefined, undefined, { ...content().input, sizeBytes: 64 * 1024 * 1024 + 1 })),
    ).toBe("FILE_TOO_LARGE");
    const evil = await service.initUpload(p, undefined, undefined, { ...content().input, filename: "..\u0000passwd" });
    const row = await withTenantTransaction(
      db.pool,
      tenant,
      async (tx) =>
        (
          await tx.query<{ original_filename: string; storage_key: string }>(
            "SELECT original_filename, storage_key FROM files.files WHERE id = $1",
            [evil.body.fileId],
          )
        ).rows[0],
    );
    expect(row?.original_filename).toBe("passwd");
    expect(row?.storage_key).toBe(
      `raw/${tenant}/${new Date().toISOString().slice(0, 10).replaceAll("-", "/")}/${evil.body.fileId}`,
    );

    const pa = user(PLATFORM_TENANT_ID, ["PLATFORM_ADMIN"]);
    expect(await code(service.initUpload(pa, undefined, undefined, content().input))).toBe("FORBIDDEN");
    expect((await service.initUpload(pa, tenant, undefined, content().input)).httpStatus).toBe(201);
    expect(await code(service.initUpload(user(tenant, ["VIEWER"]), undefined, undefined, content().input))).toBe(
      "FORBIDDEN",
    );
  });

  it("FR-FILE-04 only the uploader or ANALYST+ may complete/abort; other tenants see 404; abort deletes a landed object", async () => {
    const tenant = randomUUID();
    const integA: Principal = {
      kind: "integration",
      clientId: "a",
      tenantId: tenant,
      tenantSlug: "t",
      roles: ["INTEGRATION"],
      tokenId: "x",
    };
    const integB: Principal = {
      kind: "integration",
      clientId: "b",
      tenantId: tenant,
      tenantSlug: "t",
      roles: ["INTEGRATION"],
      tokenId: "y",
    };
    const { body, input } = content();
    const init = await service.initUpload(integA, undefined, undefined, input);
    const up = init.body.upload;
    if (up === undefined) throw new Error("no upload");
    expect(await put(up.url, up.headers as Record<string, string>, body)).toBe(200);
    expect(await code(service.completeUpload(integB, undefined, undefined, { fileId: init.body.fileId }))).toBe(
      "FORBIDDEN",
    );
    expect(
      await code(service.completeUpload(user(randomUUID()), undefined, undefined, { fileId: init.body.fileId })),
    ).toBe("NOT_FOUND");
    const aborted = await service.abortUpload(user(tenant), undefined, undefined, { fileId: init.body.fileId });
    expect(aborted.status).toBe("EXPIRED");
    const key = await withTenantTransaction(
      db.pool,
      tenant,
      async (tx) =>
        (await tx.query<{ k: string }>("SELECT storage_key AS k FROM files.files WHERE id = $1", [init.body.fileId]))
          .rows[0]?.k ?? "",
    );
    expect(
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })).then(
        () => "exists",
        () => "gone",
      ),
    ).toBe("gone");
    expect((await service.abortUpload(user(tenant), undefined, undefined, { fileId: init.body.fileId })).status).toBe(
      "EXPIRED",
    );
    // Completing an aborted upload reports its current state; it never revives it.
    expect((await service.completeUpload(integA, undefined, undefined, { fileId: init.body.fileId })).status).toBe(
      "EXPIRED",
    );
  });

  it("NFR-02 Idempotency-Key replays init (same body) and refuses a different body", async () => {
    const tenant = randomUUID();
    const key = `k-${randomBytes(6).toString("hex")}`;
    const { input } = content();
    const first = await service.initUpload(user(tenant), undefined, key, input);
    const replay = await service.initUpload(user(tenant), undefined, key, input);
    expect(replay.body.fileId).toBe(first.body.fileId);
    expect(await code(service.initUpload(user(tenant), undefined, key, content().input))).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
  });
});
