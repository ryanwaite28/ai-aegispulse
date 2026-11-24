// Reads and downloads (FR-FILE-07..09; spec FR-FILE-01-13 §2 "Reads"). Tenant principals via tenantAccess.
//   getFile        metadata + status + artifact summary; Redis `file:status:{fileId}` 30 s, invalidated on every
//                  transition (the cache entry carries tenantId and is ignored for any other tenant)
//   listFiles      filters status/purpose/uploadedBy/from/to; keyset (createdAt, id) newest first
//   getDownloadUrl presigned GET (5 min, attachment, sanitized filename) for VALIDATED|PROCESSING|PROCESSED, cached
//                  240 s per (file, actor); QUARANTINED only for TENANT_ADMIN with acknowledgeQuarantine (never cached,
//                  audited as ops.audit.quarantine_download); other statuses → 409 FILE_NOT_DOWNLOADABLE
import type { Principal } from "@aegispulse/ts-platform/auth";
import { tenantAccess } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { withTenantTransaction, type OutboxRepository, type SqlPool } from "@aegispulse/ts-platform/outbox";
import type { ArtifactSummary, FileListFilter, FileRecord, FilesRepository } from "../db/files.repository.js";
import { quarantineDownload } from "./events.js";
import { DOWNLOAD_URL_TTL_SECONDS, isDownloadable, type DownloadSigner } from "./file-processing.service.js";
import { rolesFor } from "./roles.js";

export const STATUS_CACHE_TTL_SECONDS = 30;
export const DOWNLOAD_URL_CACHE_TTL_SECONDS = 240;

export interface FileDetail {
  readonly file: FileRecord;
  readonly artifacts: readonly ArtifactSummary[];
}

export interface DownloadUrl {
  readonly url: string;
  readonly expiresAt: string;
  readonly filename: string;
}

/** Hot caches (§7.7 file:status:*, file:dlurl:*). */
export interface FileReadCache {
  getDetail(fileId: string): Promise<FileDetail | undefined>;
  putDetail(fileId: string, detail: FileDetail, ttlSeconds: number): Promise<void>;
  getDownloadUrl(fileId: string, actor: string): Promise<DownloadUrl | undefined>;
  putDownloadUrl(fileId: string, actor: string, url: DownloadUrl, ttlSeconds: number): Promise<void>;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}

export interface QueryDeps {
  readonly pool: SqlPool;
  readonly files: FilesRepository;
  readonly outbox: OutboxRepository;
  readonly signer: DownloadSigner;
  readonly cache: FileReadCache;
  readonly version: string;
  readonly logger: Logger;
}

const DEFAULT_LIMIT = 25;

export class FileQueryService {
  constructor(private readonly deps: QueryDeps) {}

  async getFile(principal: Principal, actingTenant: string | undefined, fileId: string): Promise<FileDetail> {
    const access = tenantAccess(principal, actingTenant, rolesFor("getFile"));
    const cached = await this.deps.cache.getDetail(fileId);
    if (cached !== undefined && cached.file.tenantId === access.tenantId && cached.file.deletedAt === null)
      return cached;
    const detail = await withTenantTransaction(this.deps.pool, access.tenantId, async (tx) => {
      const file = await this.deps.files.get(tx, fileId);
      if (file === undefined || file.deletedAt !== null) throw notFound();
      return { file, artifacts: await this.deps.files.artifacts(tx, fileId) };
    });
    await this.deps.cache.putDetail(fileId, detail, STATUS_CACHE_TTL_SECONDS);
    return detail;
  }

  async listFiles(
    principal: Principal,
    actingTenant: string | undefined,
    query: FileListFilter & { limit?: number | undefined; cursor?: string | undefined },
  ): Promise<Page<FileRecord>> {
    const access = tenantAccess(principal, actingTenant, rolesFor("listFiles"));
    const limit = query.limit ?? DEFAULT_LIMIT;
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    return withTenantTransaction(this.deps.pool, access.tenantId, async (tx) => {
      const rows = await this.deps.files.list(tx, query, after, limit + 1);
      if (rows.length <= limit) return { items: rows, nextCursor: undefined };
      const page = rows.slice(0, limit);
      const last = page[page.length - 1] as FileRecord;
      return { items: page, nextCursor: encodeCursor(last.createdAt, last.id) };
    });
  }

  async getDownloadUrl(
    principal: Principal,
    actingTenant: string | undefined,
    input: { fileId: string; acknowledgeQuarantine?: boolean | undefined },
  ): Promise<DownloadUrl> {
    const access = tenantAccess(principal, actingTenant, rolesFor("getFileDownloadUrl"));
    const cached = await this.deps.cache.getDownloadUrl(input.fileId, access.actor);
    if (cached !== undefined) return cached;

    return withTenantTransaction(this.deps.pool, access.tenantId, async (tx) => {
      const file = await this.deps.files.get(tx, input.fileId);
      if (file === undefined || file.deletedAt !== null) throw notFound();
      if (file.status === "QUARANTINED") {
        if (input.acknowledgeQuarantine !== true || !access.roles.includes("TENANT_ADMIN") || access.userId === null) {
          throw new DomainError(
            "FILE_QUARANTINED",
            "quarantined files are downloadable only by a TENANT_ADMIN with acknowledgeQuarantine=true",
          );
        }
        const url = await this.sign(file);
        await this.deps.outbox.enqueue(tx, quarantineDownload(this.deps.version, file, access.userId));
        this.deps.logger.warn(
          { tenantId: file.tenantId, fileId: file.id, actor: access.actor },
          "file.quarantine.download",
        );
        return url; // never cached: every quarantined download is audited
      }
      if (!isDownloadable(file)) {
        throw new DomainError("FILE_NOT_DOWNLOADABLE", `a ${file.status} file cannot be downloaded`);
      }
      const url = await this.sign(file);
      await this.deps.cache.putDownloadUrl(file.id, access.actor, url, DOWNLOAD_URL_CACHE_TTL_SECONDS);
      return url;
    });
  }

  private async sign(file: FileRecord): Promise<DownloadUrl> {
    const url = await this.deps.signer.presignGet({
      bucket: file.storageBucket,
      key: file.storageKey,
      ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
      filename: file.filename,
      audience: "public",
    });
    return {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      filename: file.filename,
    };
  }
}

function notFound(): DomainError {
  return new DomainError("NOT_FOUND", "file not found");
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (
    createdAt === undefined ||
    id === undefined ||
    Number.isNaN(Date.parse(createdAt)) ||
    !/^[0-9a-f-]{36}$/.test(id)
  ) {
    throw new DomainError("VALIDATION_ERROR", "request failed validation", {
      details: [{ field: "cursor", message: "invalid cursor" }],
    });
  }
  return { createdAt, id };
}
