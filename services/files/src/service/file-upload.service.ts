// Upload lifecycle use cases (FR-FILE-01..04; spec FR-FILE-01-13 §2): initUpload, completeUpload, abortUpload.
// Order in initUpload: authorize → shape rules → tenant status → [tenant TX: Idempotency-Key → rate quota → dedup →
// storage quota → row INITIATED] → presigned PUT + Redis session. Object keys come from ids, never filenames.
import { randomUUID } from "node:crypto";
import type { Principal, TenantAccess } from "@aegispulse/ts-platform/auth";
import { tenantAccess } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { IdempotencyRepository } from "@aegispulse/ts-platform/idempotency";
import { sha256Hex } from "@aegispulse/ts-platform/idempotency";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { getContext } from "@aegispulse/ts-platform/logging";
import { withTenantTransaction, type OutboxRepository, type SqlPool } from "@aegispulse/ts-platform/outbox";
import {
  checkContentType,
  checkPartList,
  countsForDedup,
  DEDUP_TTL_SECONDS,
  MULTIPART_PART_BYTES,
  partSizes,
  PRESIGNED_PUT_TTL_SECONDS,
  rawObjectKey,
  sanitizeFilename,
  uploadMode,
  STORAGE_QUOTA_BYTES,
  UPLOAD_SESSION_TTL_SECONDS,
  type ContentType,
  type FileStatus,
  type Purpose,
} from "../domain/file.js";
import type { FileRecord, FilesRepository } from "../db/files.repository.js";
import { fileStatusChanged, fileUploaded } from "./events.js";
import { ANALYST_PLUS, rolesFor } from "./roles.js";

// ── Ports (implemented in src/storage) ───────────────────────────────────────

export interface UploadSession {
  readonly tenantId: string;
  /** TenantAccess.actor of the initiator: `user:{id}` or `integration:{clientId}`. */
  readonly uploader: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
}
export interface UploadSessionStore {
  put(fileId: string, session: UploadSession, ttlSeconds: number): Promise<void>;
  get(fileId: string): Promise<UploadSession | undefined>;
  delete(fileId: string): Promise<void>;
}
export interface DedupIndex {
  get(tenantId: string, sha256: string): Promise<string | undefined>;
  /** SET … EX; `onlyIfAbsent` keeps the first live file as the pointer. */
  set(tenantId: string, sha256: string, fileId: string, ttlSeconds: number, onlyIfAbsent: boolean): Promise<void>;
  /** Removes the pointer only while it still names `fileId`. */
  release(tenantId: string, sha256: string, fileId: string): Promise<void>;
}
export interface InitRateLimiter {
  /** FR-FILE-03 token bucket; false when the tenant is over 60 inits/min. */
  take(tenantId: string): Promise<boolean>;
}
export interface PresignedPut {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: string;
}
export interface UploadObjectStore {
  readonly bucket: string;
  presignPut(key: string, contentType: ContentType, sizeBytes: number, ttlSeconds: number): Promise<PresignedPut>;
  /** undefined when the object does not exist. */
  head(key: string): Promise<{ sizeBytes: number } | undefined>;
  delete(key: string): Promise<void>;
  /** FR-FILE-13 multipart: create, presign one part (signed Content-Length), complete with ETags, abort. */
  createMultipart(key: string, contentType: ContentType): Promise<string>;
  presignPart(
    key: string,
    uploadId: string,
    partNumber: number,
    sizeBytes: number,
    ttlSeconds: number,
  ): Promise<string>;
  /** Throws DomainError UPLOAD_NOT_FOUND_IN_STORAGE when the upload or a part is unknown to the store. */
  completeMultipart(
    key: string,
    uploadId: string,
    parts: readonly { partNumber: number; etag: string }[],
  ): Promise<void>;
  abortMultipart(key: string, uploadId: string): Promise<void>;
}
export interface FileStatusCache {
  invalidate(fileId: string): Promise<void>;
}
export interface TenantStatusPort {
  /** Registry status; NOT_FOUND propagates for unknown tenants. */
  status(tenantId: string): Promise<string>;
}

export interface InitUploadInput {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly purpose: Purpose;
  readonly relatedEntityIds?: readonly string[] | undefined;
  readonly allowDuplicate?: boolean | undefined;
}

export interface InitUploadResult {
  readonly httpStatus: 200 | 201;
  readonly body: {
    readonly fileId: string;
    readonly status: FileStatus;
    readonly deduplicated: boolean;
    readonly upload?: { method: "PUT"; url: string; headers: Readonly<Record<string, string>>; expiresAt: string };
    readonly multipart?: {
      uploadId: string;
      partSizeBytes: number;
      parts: readonly { partNumber: number; url: string }[];
    };
  };
}

export interface FileUploadDeps {
  readonly pool: SqlPool;
  readonly files: FilesRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;
  readonly sessions: UploadSessionStore;
  readonly dedup: DedupIndex;
  readonly rate: InitRateLimiter;
  readonly objects: UploadObjectStore;
  readonly statusCache: FileStatusCache;
  readonly tenants: TenantStatusPort;
  /** MULTIPART_UPLOADS_ENABLED (§10.4): 64–512 MiB uploads as 16 MiB parts (FR-FILE-13). */
  readonly multipartEnabled: boolean;
  readonly version: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class FileUploadService {
  private readonly now: () => Date;

  constructor(private readonly deps: FileUploadDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async initUpload(
    principal: Principal,
    actingTenant: string | undefined,
    idempotencyKey: string | undefined,
    input: InitUploadInput,
  ): Promise<InitUploadResult> {
    const access = tenantAccess(principal, actingTenant, rolesFor("initUpload"));
    if (input.allowDuplicate === true && !access.roles.some((r) => ANALYST_PLUS.includes(r))) {
      throw new DomainError("FORBIDDEN", "allowDuplicate requires ANALYST or above");
    }
    checkContentType(input.contentType);
    const contentType = input.contentType;
    const mode = uploadMode(input.sizeBytes, this.deps.multipartEnabled);
    await this.requireActiveTenant(access.tenantId);

    const tenantId = access.tenantId;
    const idem =
      idempotencyKey === undefined
        ? undefined
        : { tenantId, scope: "initUpload", key: idempotencyKey, requestSha256: sha256Hex(JSON.stringify(input)) };
    return withTenantTransaction(this.deps.pool, tenantId, async (tx) => {
      if (idem !== undefined) {
        const decision = await this.deps.idempotency.begin(tx, idem);
        if (decision.kind === "replay") {
          return { httpStatus: decision.status === 200 ? 200 : 201, body: decision.body as InitUploadResult["body"] };
        }
      }
      if (!(await this.deps.rate.take(tenantId))) {
        throw new DomainError("UPLOAD_RATE_LIMITED", "too many upload initiations; retry shortly");
      }
      if (input.allowDuplicate !== true) {
        const existing = await this.findDuplicate(tx, tenantId, input.sha256);
        if (existing !== undefined) {
          const body = { fileId: existing.id, status: existing.status, deduplicated: true };
          if (idem !== undefined) await this.deps.idempotency.complete(tx, idem, 200, body);
          this.deps.logger.info({ tenantId, fileId: existing.id }, "file.upload.deduplicated");
          return { httpStatus: 200, body };
        }
      }
      if ((await this.deps.files.storedBytes(tx)) + input.sizeBytes > STORAGE_QUOTA_BYTES) {
        throw new DomainError("STORAGE_QUOTA_EXCEEDED", "the tenant's storage quota is exhausted");
      }

      const fileId = randomUUID();
      const storageKey = rawObjectKey(tenantId, fileId, this.now());
      // Multipart: the upload id is created first so the row records it (the orphan sweep aborts it if unused).
      const uploadId = mode === "multipart" ? await this.deps.objects.createMultipart(storageKey, contentType) : null;
      const file = await this.deps.files.insert(
        tx,
        {
          id: fileId,
          tenantId,
          uploadedBy: access.userId,
          filename: sanitizeFilename(input.filename),
          storageBucket: this.deps.objects.bucket,
          storageKey,
          contentType,
          sizeBytes: input.sizeBytes,
          sha256: input.sha256,
          sourceType: "AD_HOC_UPLOAD",
          purpose: input.purpose,
          relatedEntityIds: input.relatedEntityIds ?? [],
          correlationId: correlationId(),
          multipartUploadId: uploadId,
        },
        access.actor,
      );
      const target =
        uploadId === null
          ? {
              upload: {
                method: "PUT" as const,
                ...(await this.deps.objects.presignPut(
                  storageKey,
                  contentType,
                  input.sizeBytes,
                  PRESIGNED_PUT_TTL_SECONDS,
                )),
              },
            }
          : {
              multipart: {
                uploadId,
                partSizeBytes: MULTIPART_PART_BYTES,
                parts: await Promise.all(
                  partSizes(input.sizeBytes).map(async (size, i) => ({
                    partNumber: i + 1,
                    url: await this.deps.objects.presignPart(
                      storageKey,
                      uploadId,
                      i + 1,
                      size,
                      PRESIGNED_PUT_TTL_SECONDS,
                    ),
                  })),
                ),
              },
            };
      await this.deps.sessions.put(
        fileId,
        { tenantId, uploader: access.actor, sizeBytes: input.sizeBytes, sha256: input.sha256, storageKey },
        UPLOAD_SESSION_TTL_SECONDS,
      );
      await this.deps.dedup.set(tenantId, input.sha256, fileId, DEDUP_TTL_SECONDS, true);
      const body = { fileId, status: file.status, deduplicated: false, ...target };
      if (idem !== undefined) await this.deps.idempotency.complete(tx, idem, 201, body);
      this.deps.logger.info(
        { tenantId, fileId, sizeBytes: input.sizeBytes, purpose: input.purpose, mode },
        "file.upload.initiated",
      );
      return { httpStatus: 201, body };
    });
  }

  /** FR-FILE-04: INITIATED → UPLOADED after HEAD + size check; any later status → idempotent 200 with the file. */
  async completeUpload(
    principal: Principal,
    actingTenant: string | undefined,
    idempotencyKey: string | undefined,
    input: { fileId: string; parts?: readonly { partNumber: number; etag: string }[] | undefined },
  ): Promise<FileRecord> {
    const access = tenantAccess(principal, actingTenant, rolesFor("completeUpload"));
    const result = await withTenantTransaction(this.deps.pool, access.tenantId, async (tx) => {
      const idem = this.idem(access, "completeUpload", idempotencyKey, input);
      if (idem !== undefined) {
        const decision = await this.deps.idempotency.begin(tx, idem);
        if (decision.kind === "replay") return { file: decision.body as FileRecord, changed: false };
      }
      const file = await this.deps.files.get(tx, input.fileId);
      if (file === undefined || file.deletedAt !== null) throw notFound();
      if (file.status !== "INITIATED") return this.finish(tx, idem, file, false);
      const session = await this.deps.sessions.get(file.id);
      if (session === undefined) throw new DomainError("UPLOAD_SESSION_EXPIRED", "the upload session has expired");
      this.requireUploaderOrAnalyst(access, file, session);
      let head = await this.deps.objects.head(file.storageKey);
      if (file.multipartUploadId === null && input.parts !== undefined) {
        throw new DomainError("VALIDATION_ERROR", "request failed validation", {
          details: [{ field: "parts", message: "only for multipart uploads" }],
        });
      }
      if (file.multipartUploadId !== null && head === undefined) {
        // FR-FILE-13: assemble the parts. A retry after the store already assembled them finds the object (HEAD).
        checkPartList(input.parts ?? [], partSizes(file.sizeBytes).length);
        await this.deps.objects.completeMultipart(file.storageKey, file.multipartUploadId, input.parts ?? []);
        head = await this.deps.objects.head(file.storageKey);
      }
      if (head === undefined) {
        throw new DomainError("UPLOAD_NOT_FOUND_IN_STORAGE", "no object was uploaded for this file");
      }
      if (head.sizeBytes !== file.sizeBytes) {
        throw new DomainError("UPLOAD_SIZE_MISMATCH", "the uploaded object's size differs from the declared size");
      }
      const updated = await this.deps.files.transition(tx, access.tenantId, {
        fileId: file.id,
        expectedVersion: file.version,
        from: "INITIATED",
        to: "UPLOADED",
        reason: null,
        actor: access.actor,
        eventId: null,
      });
      if (updated === undefined) {
        // A concurrent complete won: return what it produced (single transition, FR-FILE-04).
        return this.finish(tx, idem, (await this.deps.files.get(tx, file.id)) ?? file, false);
      }
      await this.deps.outbox.enqueue(tx, fileUploaded(this.deps.version, updated));
      await this.deps.outbox.enqueue(tx, fileStatusChanged(this.deps.version, updated, "INITIATED", null));
      return this.finish(tx, idem, updated, true);
    });
    if (result.changed) {
      await this.deps.sessions.delete(result.file.id);
      await this.deps.statusCache.invalidate(result.file.id);
      this.deps.logger.info({ tenantId: result.file.tenantId, fileId: result.file.id }, "file.upload.completed");
    }
    return result.file;
  }

  /** INITIATED → EXPIRED (uploader or ANALYST+); EXPIRED again → idempotent; any other status → 409 CONFLICT. */
  async abortUpload(
    principal: Principal,
    actingTenant: string | undefined,
    idempotencyKey: string | undefined,
    input: { fileId: string },
  ): Promise<FileRecord> {
    const access = tenantAccess(principal, actingTenant, rolesFor("abortUpload"));
    const result = await withTenantTransaction(this.deps.pool, access.tenantId, async (tx) => {
      const idem = this.idem(access, "abortUpload", idempotencyKey, input);
      if (idem !== undefined) {
        const decision = await this.deps.idempotency.begin(tx, idem);
        if (decision.kind === "replay") return { file: decision.body as FileRecord, changed: false };
      }
      const file = await this.deps.files.get(tx, input.fileId);
      if (file === undefined || file.deletedAt !== null) throw notFound();
      if (file.status === "EXPIRED") return this.finish(tx, idem, file, false);
      if (file.status !== "INITIATED") throw new DomainError("CONFLICT", `a ${file.status} file cannot be aborted`);
      this.requireUploaderOrAnalyst(access, file, await this.deps.sessions.get(file.id));
      const updated = await this.deps.files.transition(tx, access.tenantId, {
        fileId: file.id,
        expectedVersion: file.version,
        from: "INITIATED",
        to: "EXPIRED",
        reason: "aborted",
        actor: access.actor,
        eventId: null,
      });
      if (updated === undefined) {
        const current = (await this.deps.files.get(tx, file.id)) ?? file;
        if (current.status !== "EXPIRED")
          throw new DomainError("CONFLICT", `a ${current.status} file cannot be aborted`);
        return this.finish(tx, idem, current, false);
      }
      await this.deps.outbox.enqueue(tx, fileStatusChanged(this.deps.version, updated, "INITIATED", "aborted"));
      return this.finish(tx, idem, updated, true);
    });
    if (result.changed) {
      const f = result.file;
      await this.deps.objects.delete(f.storageKey); // a PUT may have landed before the abort
      if (f.multipartUploadId !== null) await this.deps.objects.abortMultipart(f.storageKey, f.multipartUploadId);
      await this.deps.sessions.delete(f.id);
      await this.deps.dedup.release(f.tenantId, f.sha256, f.id);
      await this.deps.statusCache.invalidate(f.id);
      this.deps.logger.info({ tenantId: f.tenantId, fileId: f.id }, "file.upload.aborted");
    }
    return result.file;
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async requireActiveTenant(tenantId: string): Promise<void> {
    if ((await this.deps.tenants.status(tenantId)) !== "ACTIVE") {
      throw new DomainError("TENANT_SUSPENDED", "the tenant is not active");
    }
  }

  /** FR-FILE-02: Redis pointer first (verified against the row), then the live-row index. */
  private async findDuplicate(
    tx: Parameters<FilesRepository["get"]>[0],
    tenantId: string,
    sha256: string,
  ): Promise<FileRecord | undefined> {
    const pointer = await this.deps.dedup.get(tenantId, sha256);
    if (pointer !== undefined) {
      const f = await this.deps.files.get(tx, pointer);
      if (f !== undefined && countsForDedup(f.status) && f.deletedAt === null) return f;
    }
    const live = await this.deps.files.findLiveBySha(tx, sha256);
    if (live !== undefined) await this.deps.dedup.set(tenantId, sha256, live.id, DEDUP_TTL_SECONDS, false);
    return live;
  }

  /** FR-FILE-04: the initiator (session or row) or ANALYST+ of the same tenant. */
  private requireUploaderOrAnalyst(access: TenantAccess, file: FileRecord, session: UploadSession | undefined): void {
    const isUploader =
      session?.uploader === access.actor || (file.uploadedBy !== null && file.uploadedBy === access.userId);
    if (!isUploader && !access.roles.some((r) => ANALYST_PLUS.includes(r))) {
      throw new DomainError("FORBIDDEN", "only the uploader or an analyst may change this upload");
    }
  }

  private idem(
    access: TenantAccess,
    scope: string,
    key: string | undefined,
    input: unknown,
  ): { tenantId: string; scope: string; key: string; requestSha256: string } | undefined {
    return key === undefined
      ? undefined
      : { tenantId: access.tenantId, scope, key, requestSha256: sha256Hex(JSON.stringify(input)) };
  }

  private async finish(
    tx: Parameters<IdempotencyRepository["complete"]>[0],
    idem: Parameters<IdempotencyRepository["complete"]>[1] | undefined,
    file: FileRecord,
    changed: boolean,
  ): Promise<{ file: FileRecord; changed: boolean }> {
    if (idem !== undefined) await this.deps.idempotency.complete(tx, idem, 200, file);
    return { file, changed };
  }
}

function notFound(): DomainError {
  return new DomainError("NOT_FOUND", "file not found");
}

function correlationId(): string {
  const current = getContext().correlationId;
  return current !== undefined && current.startsWith("corr-") ? current : `corr-${randomUUID()}`;
}
