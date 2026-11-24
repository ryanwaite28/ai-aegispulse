// FR-FILE-06..09 against real PostgreSQL (svc_files, RLS + definer tenant lookup), Redis (files ACL) and SeaweedFS
// (files identity; presigned GETs fetched for real).
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { CreateBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServicePrincipal, UserPrincipal } from "@aegispulse/ts-platform/auth";
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
import { FileProcessingService, type ExtractionResultInput } from "../../src/service/file-processing.service.js";
import { FileQueryService } from "../../src/service/file-query.service.js";
import { RedisFileStatusCache, S3DownloadSigner } from "../../src/storage/upload-infra.js";

const logger = createLogger({
  service: "files",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const RAW = "aegispulse-local-raw";
const QUARANTINE = "aegispulse-local-quarantine";
const docx: ServicePrincipal = {
  kind: "service",
  clientId: "svc-doc-extraction",
  actions: [
    "files.markProcessing",
    "files.recordExtractionResult",
    "files.recordProcessingFailure",
    "files.getInternalDownloadUrl",
  ],
};

let db: PostgresEnv;
let cache: RedisEnv;
let store: ObjectStoreEnv;
let redis: Redis;
let s3: S3Client;
let processing: FileProcessingService;
let queries: FileQueryService;

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

async function seed(
  tenant: string,
  status: FileStatus,
  opts: { purpose?: string; body?: string; filename?: string } = {},
): Promise<{ fileId: string; body: string; key: string; bucket: string }> {
  const fileId = randomUUID();
  const body = opts.body ?? `%PDF-1.7 lifecycle ${fileId}`;
  const quarantined = status === "QUARANTINED";
  const bucket = quarantined ? QUARANTINE : RAW;
  const key = quarantined ? `quarantine/${tenant}/${fileId}` : `raw/${tenant}/2026/11/24/${fileId}`;
  await withTenantTransaction(db.pool, tenant, async (tx) => {
    await tx.query(
      `INSERT INTO files.files (id, tenant_id, original_filename, storage_bucket, storage_key, content_type, size_bytes,
                                sha256_checksum, source_type, purpose, status, correlation_id)
       VALUES ($1, $2, $3, $4, $5, 'application/pdf', $6, $7, 'AD_HOC_UPLOAD', $8, $9, 'corr-test')`,
      [
        fileId,
        tenant,
        opts.filename ?? "Q3 report.pdf",
        bucket,
        key,
        body.length,
        createHash("sha256").update(body).digest("hex"),
        opts.purpose ?? "FILING",
        status,
      ],
    );
  });
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
  return { fileId, body, key, bucket };
}

async function outbox(
  fileId: string,
): Promise<{ type: string; payload: Record<string, unknown>; sensitivity: string }[]> {
  const r = await db.pool.query<{ t: string; p: Record<string, unknown>; s: string }>(
    `SELECT routing_key AS t, envelope->'payload' AS p, envelope->'classification'->>'sensitivity' AS s
       FROM files.outbox_events WHERE envelope->'payload'->>'fileId' = $1 ORDER BY created_at, routing_key`,
    [fileId],
  );
  return r.rows.map((x) => ({ type: x.t, payload: x.p, sensitivity: x.s }));
}

const result = (fileId: string, tenant: string, over: Partial<ExtractionResultInput> = {}): ExtractionResultInput => ({
  fileId,
  extractorVersion: "extract-1.0.0",
  status: "COMPLETED",
  confidence: 0.91,
  artifactKeys: {
    extractionKey: `artifacts/${tenant}/${fileId}/extract-1.0.0/extraction.json`,
    textKey: `artifacts/${tenant}/${fileId}/extract-1.0.0/text.txt`,
  },
  summary: {
    eventTypeGuess: "IPO_FILED",
    mentionedEntities: ["ACME Holdings"],
    redFlags: [],
    textExcerpt: "ACME files for IPO",
  },
  ...over,
});

beforeAll(async () => {
  [db, cache, store] = await Promise.all([
    startPostgres("files"),
    startRedis("files", "REDIS_PASSWORD_FILES"),
    startObjectStore(),
  ]);
  const client = (k: string, s: string): S3Client =>
    new S3Client({
      endpoint: store.endpoint,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: { accessKeyId: store.secrets[k] ?? "", secretAccessKey: store.secrets[s] ?? "" },
    });
  const admin = client("S3_ADMIN_ACCESS_KEY", "S3_ADMIN_SECRET_KEY");
  for (const bucket of [RAW, QUARANTINE]) {
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
  admin.destroy();
  s3 = client("S3_FILES_ACCESS_KEY", "S3_FILES_SECRET_KEY");
  redis = new Redis(cache.url, { maxRetriesPerRequest: 1 });
  const statusCache = new RedisFileStatusCache(redis);
  const signer = new S3DownloadSigner(s3, s3); // one endpoint in tests: internal and public are the same host
  const common = {
    pool: db.pool,
    files: new FilesRepository(),
    outbox: new OutboxRepository("files"),
    signer,
    version: "abc1234",
    logger,
  };
  processing = new FileProcessingService({ ...common, statusCache });
  queries = new FileQueryService({ ...common, cache: statusCache });
}, 900_000);

afterAll(async () => {
  redis?.disconnect();
  s3?.destroy();
  await Promise.all([db?.stop(), cache?.stop(), store?.stop()]);
});

describe("processing lifecycle for doc-extraction (FR-FILE-06)", () => {
  it("VALIDATED → PROCESSING → PROCESSED with one artifact and doc.extraction.completed; every step idempotent", async () => {
    const tenant = randomUUID();
    const f = await seed(tenant, "VALIDATED");
    const marked = await processing.markProcessing(docx, { fileId: f.fileId, extractorVersion: "extract-1.0.0" });
    expect(marked).toMatchObject({ status: "PROCESSING", extractorVersion: "extract-1.0.0" });
    expect(
      (await processing.markProcessing(docx, { fileId: f.fileId, extractorVersion: "extract-1.0.0" })).status,
    ).toBe("PROCESSING");

    const dl = await processing.getInternalDownloadUrl(docx, { fileId: f.fileId });
    const got = await fetch(dl.url);
    expect(await got.text()).toBe(f.body);
    expect(got.headers.get("content-disposition")).toContain("attachment");

    const done = await processing.recordExtractionResult(docx, result(f.fileId, tenant));
    expect(done.status).toBe("PROCESSED");
    expect((await processing.recordExtractionResult(docx, result(f.fileId, tenant))).status).toBe("PROCESSED");
    const ev = await outbox(f.fileId);
    expect(ev.map((e) => e.type).sort()).toEqual([
      "doc.extraction.completed",
      "file.status.changed",
      "file.status.changed",
    ]);
    const extraction = ev.filter((e) => e.type === "doc.extraction.completed");
    expect(extraction).toHaveLength(1);
    expect(extraction[0]?.sensitivity).toBe("CONFIDENTIAL");
    expect(extraction[0]?.payload).toMatchObject({
      fileId: f.fileId,
      extractorVersion: "extract-1.0.0",
      eventTypeGuess: "IPO_FILED",
      confidence: 0.91,
      artifactKeys: { extractionKey: `artifacts/${tenant}/${f.fileId}/extract-1.0.0/extraction.json` },
    });
    expect(ev.filter((e) => e.type === "file.status.changed").map((e) => e.payload["to"])).toEqual([
      "PROCESSING",
      "PROCESSED",
    ]);
    const detail = await queries.getFile(user(tenant), undefined, f.fileId);
    expect(detail.artifacts).toEqual([
      expect.objectContaining({ extractorVersion: "extract-1.0.0", resultStatus: "COMPLETED", confidence: 0.91 }),
    ]);
  });

  it("REVIEW_REQUIRED, failures, illegal transitions and principals", async () => {
    const tenant = randomUUID();
    const r = await seed(tenant, "VALIDATED");
    await processing.markProcessing(docx, { fileId: r.fileId, extractorVersion: "extract-1.0.0" });
    await processing.recordExtractionResult(
      docx,
      result(r.fileId, tenant, { status: "REVIEW_REQUIRED", confidence: 0.4 }),
    );
    expect((await outbox(r.fileId)).map((e) => e.type)).toContain("doc.extraction.review_required");

    const fl = await seed(tenant, "VALIDATED");
    await processing.markProcessing(docx, { fileId: fl.fileId, extractorVersion: "extract-1.0.0" });
    expect(
      (await processing.recordProcessingFailure(docx, { fileId: fl.fileId, reason: "OCR timeout", retryable: true }))
        .status,
    ).toBe("PROCESSING");
    expect(
      (await processing.recordProcessingFailure(docx, { fileId: fl.fileId, reason: "unparseable", retryable: false }))
        .status,
    ).toBe("FAILED");
    expect(
      (await processing.recordProcessingFailure(docx, { fileId: fl.fileId, reason: "again", retryable: false })).status,
    ).toBe("FAILED");

    const up = await seed(tenant, "UPLOADED");
    expect(await code(processing.markProcessing(docx, { fileId: up.fileId, extractorVersion: "x" }))).toBe("CONFLICT");
    const val = await seed(tenant, "VALIDATED");
    expect(await code(processing.recordExtractionResult(docx, result(val.fileId, tenant)))).toBe("CONFLICT");
    expect(await code(processing.getInternalDownloadUrl(docx, { fileId: up.fileId }))).toBe("FILE_NOT_DOWNLOADABLE");
    expect(await code(processing.markProcessing(docx, { fileId: randomUUID(), extractorVersion: "x" }))).toBe(
      "NOT_FOUND",
    );
    expect(
      await code(
        processing.markProcessing(user(tenant, ["TENANT_ADMIN"]), { fileId: val.fileId, extractorVersion: "x" }),
      ),
    ).toBe("FORBIDDEN");
    await processing.markProcessing(docx, { fileId: val.fileId, extractorVersion: "extract-1.0.0" });
    expect(await code(processing.recordExtractionResult(docx, result(val.fileId, tenant, { rowsAccepted: 3 })))).toBe(
      "VALIDATION_ERROR",
    );
  });
});

describe("reads and downloads (FR-FILE-07..09)", () => {
  it("getFile is cached 30 s, invalidated on transition, and never served to another tenant", async () => {
    const tenant = randomUUID();
    const f = await seed(tenant, "VALIDATED");
    expect((await queries.getFile(user(tenant), undefined, f.fileId)).file.status).toBe("VALIDATED");
    expect(await redis.exists(`file:status:${f.fileId}`)).toBe(1);
    await processing.markProcessing(docx, { fileId: f.fileId, extractorVersion: "extract-1.0.0" });
    expect(await redis.exists(`file:status:${f.fileId}`)).toBe(0);
    expect((await queries.getFile(user(tenant), undefined, f.fileId)).file.status).toBe("PROCESSING");
    expect(await code(queries.getFile(user(randomUUID()), undefined, f.fileId))).toBe("NOT_FOUND"); // cache entry exists
  });

  it("listFiles filters and pages newest first", async () => {
    const tenant = randomUUID();
    for (const s of ["VALIDATED", "VALIDATED", "VALIDATED", "FAILED"] as const) await seed(tenant, s);
    const p1 = await queries.listFiles(user(tenant), undefined, { status: "VALIDATED", limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await queries.listFiles(user(tenant), undefined, {
      status: "VALIDATED",
      limit: 2,
      cursor: p1.nextCursor,
    });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    expect(new Set([...p1.items, ...p2.items].map((x) => x.id)).size).toBe(3);
    expect((await queries.listFiles(user(tenant), undefined, { status: "FAILED" })).items).toHaveLength(1);
    expect((await queries.listFiles(user(randomUUID()), undefined, {})).items).toHaveLength(0);
  });

  it("getDownloadUrl: attachment URL cached per actor; not downloadable → 409; quarantine needs TENANT_ADMIN + ack, audited each time", async () => {
    const tenant = randomUUID();
    const analyst = user(tenant);
    const f = await seed(tenant, "VALIDATED", { filename: 'Résumé "Q3".pdf' });
    const a = await queries.getDownloadUrl(analyst, undefined, { fileId: f.fileId });
    const res = await fetch(a.url);
    expect(await res.text()).toBe(f.body);
    expect(res.headers.get("content-disposition")).toContain(`filename*=UTF-8''R%C3%A9sum%C3%A9`);
    expect((await queries.getDownloadUrl(analyst, undefined, { fileId: f.fileId })).url).toBe(a.url); // cached

    const up = await seed(tenant, "UPLOADED");
    expect(await code(queries.getDownloadUrl(analyst, undefined, { fileId: up.fileId }))).toBe("FILE_NOT_DOWNLOADABLE");

    const q = await seed(tenant, "QUARANTINED", { body: "quarantined bytes" });
    const ta = user(tenant, ["TENANT_ADMIN"]);
    expect(
      await code(queries.getDownloadUrl(analyst, undefined, { fileId: q.fileId, acknowledgeQuarantine: true })),
    ).toBe("FILE_QUARANTINED");
    expect(await code(queries.getDownloadUrl(ta, undefined, { fileId: q.fileId }))).toBe("FILE_QUARANTINED");
    const qa = await queries.getDownloadUrl(ta, undefined, { fileId: q.fileId, acknowledgeQuarantine: true });
    expect(await (await fetch(qa.url)).text()).toBe("quarantined bytes");
    await queries.getDownloadUrl(ta, undefined, { fileId: q.fileId, acknowledgeQuarantine: true });
    const audits = (await outbox(q.fileId)).filter((e) => e.type === "ops.audit.quarantine_download");
    expect(audits).toHaveLength(2);
    expect(audits[0]?.payload).toEqual({ fileId: q.fileId, actorId: ta.userId });
    expect(
      await code(
        queries.getDownloadUrl(user(randomUUID(), ["TENANT_ADMIN"]), undefined, {
          fileId: q.fileId,
          acknowledgeQuarantine: true,
        }),
      ),
    ).toBe("NOT_FOUND");
  });
});
