// FR-FILE-05 validateFile against real PostgreSQL (svc_files, RLS) and SeaweedFS (files identity: raw read/write,
// quarantine write). AV is a fake scanner that flags the EICAR string (real clamd is exercised by the compose E2E).
import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { CreateBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProcessedMessagesRepository } from "@aegispulse/ts-platform/idempotency";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { OutboxRepository, withTenantTransaction } from "@aegispulse/ts-platform/outbox";
import {
  startObjectStore,
  startPostgres,
  type ObjectStoreEnv,
  type PostgresEnv,
} from "../../../../packages/ts-platform/tests/integration/env.js";
import { FilesRepository } from "../../src/db/files.repository.js";
import type { ContentType } from "../../src/domain/file.js";
import { FileValidationService, type AvScanner } from "../../src/service/file-validation.service.js";
import { S3ValidationStore } from "../../src/storage/validation-infra.js";

const logger = createLogger({
  service: "files",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const RAW = "aegispulse-local-raw";
const QUARANTINE = "aegispulse-local-quarantine";
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

/** Fake clamd: accumulates the stream, flags EICAR. */
const fakeAv: AvScanner = {
  open: () => {
    const parts: Uint8Array[] = [];
    return Promise.resolve({
      write: (c: Uint8Array) => {
        parts.push(c);
        return Promise.resolve();
      },
      finish: () => {
        const infected = Buffer.concat(parts).includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE"));
        return Promise.resolve({ clean: !infected, signature: infected ? "Eicar-Test-Signature" : null });
      },
      abort: () => undefined,
    });
  },
};

let db: PostgresEnv;
let store: ObjectStoreEnv;
let s3: S3Client;
let service: FileValidationService;

const sha = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/** An UPLOADED file row + its raw object, as completeUpload leaves it. */
async function uploaded(
  tenant: string,
  body: Buffer,
  contentType: ContentType,
  declared: { sha256?: string; sizeBytes?: number; putObject?: boolean } = {},
): Promise<{ fileId: string; key: string; eventId: string }> {
  const fileId = randomUUID();
  const key = `raw/${tenant}/2026/11/24/${fileId}`;
  await withTenantTransaction(db.pool, tenant, async (tx) => {
    await tx.query(
      `INSERT INTO files.files (id, tenant_id, original_filename, storage_bucket, storage_key, content_type, size_bytes,
                                sha256_checksum, source_type, purpose, status, correlation_id)
       VALUES ($1, $2, 'f', $3, $4, $5, $6, $7, 'AD_HOC_UPLOAD', 'FILING', 'UPLOADED', 'corr-test')`,
      [fileId, tenant, RAW, key, contentType, declared.sizeBytes ?? body.length, declared.sha256 ?? sha(body)],
    );
  });
  if (declared.putObject !== false) {
    await s3.send(new PutObjectCommand({ Bucket: RAW, Key: key, Body: body, ContentType: contentType }));
  }
  return { fileId, key, eventId: randomUUID() };
}

async function row(tenant: string, fileId: string): Promise<Record<string, unknown>> {
  return withTenantTransaction(
    db.pool,
    tenant,
    async (tx) =>
      (
        await tx.query(
          "SELECT status, failure_reason, detected_type, verified_sha256, storage_bucket, storage_key, version FROM files.files WHERE id = $1",
          [fileId],
        )
      ).rows[0] as Record<string, unknown>,
  );
}

async function events(fileId: string): Promise<{ type: string; exchange: string; payload: Record<string, unknown> }[]> {
  const r = await db.pool.query<{ t: string; x: string; p: Record<string, unknown> }>(
    `SELECT routing_key AS t, exchange AS x, envelope->'payload' AS p FROM files.outbox_events
      WHERE envelope->'payload'->>'fileId' = $1 OR envelope->'payload'->'vars'->>'fileId' = $1 ORDER BY routing_key`,
    [fileId],
  );
  return r.rows.map((x) => ({ type: x.t, exchange: x.x, payload: x.p }));
}

const exists = (bucket: string, key: string): Promise<boolean> =>
  s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key })).then(
    () => true,
    () => false,
  );

beforeAll(async () => {
  [db, store] = await Promise.all([startPostgres("files"), startObjectStore()]);
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
  service = new FileValidationService({
    pool: db.pool,
    files: new FilesRepository(),
    outbox: new OutboxRepository("files"),
    processed: new ProcessedMessagesRepository("files"),
    objects: new S3ValidationStore(s3, RAW, QUARANTINE),
    av: fakeAv,
    tenants: { slug: () => Promise.resolve("tenant-acme-capital") },
    statusCache: { invalidate: () => Promise.resolve() },
    version: "abc1234",
    logger,
  });
}, 900_000);

afterAll(async () => {
  s3?.destroy();
  await Promise.all([db?.stop(), store?.stop()]);
});

describe("validateFile (FR-FILE-05)", () => {
  it("a clean PDF → VALIDATED with detected type + verified sha; doc.file.ready + file.status.changed; redelivery no-op", async () => {
    const tenant = randomUUID();
    const body = Buffer.from(`%PDF-1.7\n${"x".repeat(20_000)}`);
    const f = await uploaded(tenant, body, "application/pdf");
    const input = { eventId: f.eventId, replayGeneration: 0, tenantId: tenant, fileId: f.fileId, storageKey: f.key };
    expect(await service.validateFile(input)).toBe("processed");
    expect(await row(tenant, f.fileId)).toMatchObject({
      status: "VALIDATED",
      detected_type: "application/pdf",
      verified_sha256: sha(body),
      storage_key: f.key,
    });
    const ev = await events(f.fileId);
    expect(ev.map((e) => [e.type, e.exchange])).toEqual([
      ["doc.file.ready", "aegispulse.enrichment"],
      ["file.status.changed", "aegispulse.enrichment"],
    ]);
    expect(ev[1]?.payload).toEqual({ fileId: f.fileId, from: "UPLOADED", to: "VALIDATED", reason: null });
    expect(await service.validateFile(input)).toBe("duplicate"); // same message
    expect(await service.validateFile({ ...input, eventId: randomUUID() })).toBe("duplicate"); // not UPLOADED any more
    expect(await events(f.fileId)).toHaveLength(2);
  });

  it("EICAR → QUARANTINED: moved to quarantine/{tenantId}/{fileId}, raw deleted, N-03 notification", async () => {
    const tenant = randomUUID();
    const f = await uploaded(tenant, Buffer.from(EICAR), "text/plain");
    await service.validateFile({
      eventId: f.eventId,
      replayGeneration: 0,
      tenantId: tenant,
      fileId: f.fileId,
      storageKey: f.key,
    });
    const r = await row(tenant, f.fileId);
    expect(r).toMatchObject({
      status: "QUARANTINED",
      failure_reason: "MALWARE:Eicar-Test-Signature",
      storage_bucket: QUARANTINE,
      storage_key: `quarantine/${tenant}/${f.fileId}`,
    });
    expect(await exists(QUARANTINE, `quarantine/${tenant}/${f.fileId}`)).toBe(true);
    expect(await exists(RAW, f.key)).toBe(false);
    const notice = (await events(f.fileId)).find((e) => e.type === "notification.requested");
    expect(notice?.payload).toEqual({
      templateId: "N-03",
      severity: "HIGH",
      notificationKey: `N-03:${f.fileId}`,
      vars: { fileId: f.fileId, reason: "MALWARE:Eicar-Test-Signature", tenantSlug: "tenant-acme-capital" },
    });
  });

  it("a PDF declared as CSV → QUARANTINED (TYPE_MISMATCH); checksum mismatch → FAILED; missing object → FAILED", async () => {
    const tenant = randomUUID();
    const pdfAsCsv = await uploaded(tenant, Buffer.from("%PDF-1.4 sneaky"), "text/csv");
    await service.validateFile({
      eventId: pdfAsCsv.eventId,
      replayGeneration: 0,
      tenantId: tenant,
      fileId: pdfAsCsv.fileId,
      storageKey: pdfAsCsv.key,
    });
    expect(await row(tenant, pdfAsCsv.fileId)).toMatchObject({
      status: "QUARANTINED",
      failure_reason: "TYPE_MISMATCH:application/pdf",
    });
    expect((await events(pdfAsCsv.fileId)).find((e) => e.type === "notification.requested")?.payload).toMatchObject({
      severity: "MEDIUM",
    });

    const tampered = await uploaded(tenant, Buffer.from("id,amount\n1,2\n"), "text/csv", { sha256: "0".repeat(64) });
    await service.validateFile({
      eventId: tampered.eventId,
      replayGeneration: 0,
      tenantId: tenant,
      fileId: tampered.fileId,
      storageKey: tampered.key,
    });
    expect(await row(tenant, tampered.fileId)).toMatchObject({ status: "FAILED", failure_reason: "CHECKSUM_MISMATCH" });
    expect((await events(tampered.fileId)).map((e) => e.type)).toEqual(["file.status.changed"]);

    const longer = await uploaded(tenant, Buffer.from("id,amount\n1,2\n3,4\n"), "text/csv", { sizeBytes: 5 });
    await service.validateFile({
      eventId: longer.eventId,
      replayGeneration: 0,
      tenantId: tenant,
      fileId: longer.fileId,
      storageKey: longer.key,
    });
    expect(await row(tenant, longer.fileId)).toMatchObject({ status: "FAILED", failure_reason: "SIZE_MISMATCH" });

    const gone = await uploaded(tenant, Buffer.from("hello"), "text/plain", { putObject: false });
    await service.validateFile({
      eventId: gone.eventId,
      replayGeneration: 0,
      tenantId: tenant,
      fileId: gone.fileId,
      storageKey: gone.key,
    });
    expect(await row(tenant, gone.fileId)).toMatchObject({ status: "FAILED", failure_reason: "OBJECT_MISSING" });
  });

  it("a redelivery after an interrupted quarantine move finishes it (raw deleted); other tenants' files → permanent NOT_FOUND", async () => {
    const tenant = randomUUID();
    const f = await uploaded(tenant, Buffer.from(EICAR), "text/plain");
    await service.validateFile({
      eventId: f.eventId,
      replayGeneration: 0,
      tenantId: tenant,
      fileId: f.fileId,
      storageKey: f.key,
    });
    // Simulate a crash after commit but before the raw delete: the raw object is back.
    await s3.send(new PutObjectCommand({ Bucket: RAW, Key: f.key, Body: Buffer.from(EICAR) }));
    expect(
      await service.validateFile({
        eventId: f.eventId,
        replayGeneration: 0,
        tenantId: tenant,
        fileId: f.fileId,
        storageKey: f.key,
      }),
    ).toBe("duplicate");
    expect(await exists(RAW, f.key)).toBe(false);

    await expect(
      service.validateFile({
        eventId: randomUUID(),
        replayGeneration: 0,
        tenantId: randomUUID(),
        fileId: f.fileId,
        storageKey: f.key,
      }),
    ).rejects.toMatchObject({ name: "PermanentError", code: "NOT_FOUND" });
  });
});
