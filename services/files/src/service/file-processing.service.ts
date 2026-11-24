// Processing lifecycle for doc-extraction (FR-FILE-06; spec FR-FILE-01-13 §2 "Processing lifecycle"). SERVICE callers
// only (act[] checked by the route; user/integration tokens are refused here). They name a fileId, never a tenant: the
// tenant comes from the definer lookup files.file_tenant (ADR-0016), then everything runs under that tenant's RLS.
//   markProcessing          VALIDATED → PROCESSING (extractorVersion); PROCESSING/PROCESSED → idempotent current file
//   recordExtractionResult  PROCESSING → PROCESSED + artifact row (unique per extractor version) + doc.extraction.*;
//                           a repeat for an existing artifact returns the current file without a second event
//   recordProcessingFailure PROCESSING → FAILED when not retryable; retryable → logged, status unchanged
//   getInternalDownloadUrl  presigned GET on the in-cluster endpoint (VALIDATED|PROCESSING|PROCESSED)
import type { Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { withTenantTransaction, type OutboxRepository, type SqlPool } from "@aegispulse/ts-platform/outbox";
import type { FileRecord, FilesRepository } from "../db/files.repository.js";
import { docExtraction, fileStatusChanged } from "./events.js";
import type { FileStatusCache } from "./file-upload.service.js";

/** Presigned GET URLs; `audience` picks the signing host (in-cluster for services, PUBLIC_OBJECTS_URL for users). */
export interface DownloadSigner {
  presignGet(args: {
    bucket: string;
    key: string;
    ttlSeconds: number;
    filename: string;
    audience: "internal" | "public";
  }): Promise<string>;
}

export const DOWNLOAD_URL_TTL_SECONDS = 300;
const DOWNLOADABLE = new Set(["VALIDATED", "PROCESSING", "PROCESSED"]);

export function isDownloadable(file: FileRecord): boolean {
  return DOWNLOADABLE.has(file.status) && file.deletedAt === null;
}

export interface ExtractionResultInput {
  readonly fileId: string;
  readonly extractorVersion: string;
  readonly status: "COMPLETED" | "REVIEW_REQUIRED";
  readonly confidence: number;
  readonly artifactKeys: {
    readonly textKey?: string | undefined;
    readonly chunksKey?: string | undefined;
    readonly extractionKey: string;
    readonly rowErrorsKey?: string | undefined;
  };
  readonly rowsAccepted?: number | undefined;
  readonly rowsRejected?: number | undefined;
  readonly summary: {
    readonly eventTypeGuess: string;
    readonly mentionedEntities: readonly string[];
    readonly redFlags: readonly unknown[];
    readonly textExcerpt?: string | undefined;
  };
}

export interface ProcessingDeps {
  readonly pool: SqlPool;
  readonly files: FilesRepository;
  readonly outbox: OutboxRepository;
  readonly signer: DownloadSigner;
  readonly statusCache: FileStatusCache;
  readonly version: string;
  readonly logger: Logger;
}

export class FileProcessingService {
  constructor(private readonly deps: ProcessingDeps) {}

  async markProcessing(principal: Principal, input: { fileId: string; extractorVersion: string }): Promise<FileRecord> {
    const actor = serviceActor(principal);
    return this.inFileTenant(input.fileId, async (tx, file, tenantId) => {
      if (file.status === "PROCESSING" || file.status === "PROCESSED") return { file, changed: false };
      if (file.status !== "VALIDATED") throw conflict(file);
      const next = await this.deps.files.transition(tx, tenantId, {
        fileId: file.id,
        expectedVersion: file.version,
        from: "VALIDATED",
        to: "PROCESSING",
        reason: null,
        actor,
        eventId: null,
        patch: { extractorVersion: input.extractorVersion },
      });
      if (next === undefined) return { file: await this.reload(tx, file), changed: false };
      await this.deps.outbox.enqueue(tx, fileStatusChanged(this.deps.version, next, "VALIDATED", null));
      return { file: next, changed: true };
    });
  }

  async recordExtractionResult(principal: Principal, input: ExtractionResultInput): Promise<FileRecord> {
    const actor = serviceActor(principal);
    return this.inFileTenant(input.fileId, async (tx, file, tenantId) => {
      if (file.status === "PROCESSED") return { file, changed: false }; // replay after success
      if (file.status !== "PROCESSING") throw conflict(file);
      if (
        (input.rowsAccepted !== undefined || input.rowsRejected !== undefined) &&
        file.purpose !== "TRANSACTION_BATCH"
      ) {
        throw new DomainError("VALIDATION_ERROR", "row counts apply to TRANSACTION_BATCH files only", {
          details: [{ field: "rowsAccepted", message: "only for purpose TRANSACTION_BATCH" }],
        });
      }
      const inserted = await this.deps.files.insertArtifact(tx, {
        tenantId,
        fileId: file.id,
        extractorVersion: input.extractorVersion,
        resultStatus: input.status,
        confidence: input.confidence,
        textKey: input.artifactKeys.textKey ?? null,
        chunksKey: input.artifactKeys.chunksKey ?? null,
        extractionKey: input.artifactKeys.extractionKey,
        rowErrorsKey: input.artifactKeys.rowErrorsKey ?? null,
        rowsAccepted: input.rowsAccepted ?? null,
        rowsRejected: input.rowsRejected ?? null,
        summary: {
          eventTypeGuess: input.summary.eventTypeGuess,
          entityCount: input.summary.mentionedEntities.length,
          redFlags: input.summary.redFlags,
        },
      });
      if (!inserted) return { file, changed: false };
      const next = await this.deps.files.transition(tx, tenantId, {
        fileId: file.id,
        expectedVersion: file.version,
        from: "PROCESSING",
        to: "PROCESSED",
        reason: null,
        actor,
        eventId: null,
        patch: { extractorVersion: input.extractorVersion },
      });
      if (next === undefined) throw new DomainError("CONFLICT", "the file changed while recording the result");
      const keys: Record<string, string> = { extractionKey: input.artifactKeys.extractionKey };
      if (input.artifactKeys.textKey !== undefined) keys["textKey"] = input.artifactKeys.textKey;
      if (input.artifactKeys.chunksKey !== undefined) keys["chunksKey"] = input.artifactKeys.chunksKey;
      if (input.artifactKeys.rowErrorsKey !== undefined) keys["rowErrorsKey"] = input.artifactKeys.rowErrorsKey;
      await this.deps.outbox.enqueue(tx, fileStatusChanged(this.deps.version, next, "PROCESSING", null));
      await this.deps.outbox.enqueue(
        tx,
        docExtraction(this.deps.version, next, {
          extractorVersion: input.extractorVersion,
          status: input.status,
          confidence: input.confidence,
          eventTypeGuess: input.summary.eventTypeGuess,
          mentionedEntities: input.summary.mentionedEntities,
          redFlags: input.summary.redFlags,
          textExcerpt: input.summary.textExcerpt,
          artifactKeys: keys,
        }),
      );
      return { file: next, changed: true };
    });
  }

  async recordProcessingFailure(
    principal: Principal,
    input: { fileId: string; reason: string; retryable: boolean },
  ): Promise<FileRecord> {
    const actor = serviceActor(principal);
    const reason = input.reason.slice(0, 500);
    return this.inFileTenant(input.fileId, async (tx, file, tenantId) => {
      if (file.status === "FAILED") return { file, changed: false };
      if (file.status !== "PROCESSING") throw conflict(file);
      if (input.retryable) {
        this.deps.logger.warn({ tenantId, fileId: file.id, reason }, "file.processing.retryable_failure");
        return { file, changed: false };
      }
      const next = await this.deps.files.transition(tx, tenantId, {
        fileId: file.id,
        expectedVersion: file.version,
        from: "PROCESSING",
        to: "FAILED",
        reason,
        actor,
        eventId: null,
      });
      if (next === undefined) return { file: await this.reload(tx, file), changed: false };
      await this.deps.outbox.enqueue(tx, fileStatusChanged(this.deps.version, next, "PROCESSING", reason));
      return { file: next, changed: true };
    });
  }

  async getInternalDownloadUrl(
    principal: Principal,
    input: { fileId: string },
  ): Promise<{ url: string; expiresAt: string; filename: string }> {
    serviceActor(principal);
    const tenantId = await this.deps.files.fileTenant(this.deps.pool, input.fileId);
    if (tenantId === undefined) throw notFound();
    const file = await withTenantTransaction(this.deps.pool, tenantId, (tx) => this.deps.files.get(tx, input.fileId));
    if (file === undefined) throw notFound();
    if (!isDownloadable(file)) {
      throw new DomainError("FILE_NOT_DOWNLOADABLE", `a ${file.status} file cannot be downloaded`);
    }
    const url = await this.deps.signer.presignGet({
      bucket: file.storageBucket,
      key: file.storageKey,
      ttlSeconds: DOWNLOAD_URL_TTL_SECONDS,
      filename: file.filename,
      audience: "internal",
    });
    return {
      url,
      expiresAt: new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000).toISOString(),
      filename: file.filename,
    };
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async inFileTenant(
    fileId: string,
    work: (
      tx: Parameters<FilesRepository["get"]>[0],
      file: FileRecord,
      tenantId: string,
    ) => Promise<{ file: FileRecord; changed: boolean }>,
  ): Promise<FileRecord> {
    const tenantId = await this.deps.files.fileTenant(this.deps.pool, fileId);
    if (tenantId === undefined) throw notFound();
    const result = await withTenantTransaction(this.deps.pool, tenantId, async (tx) => {
      const file = await this.deps.files.get(tx, fileId);
      if (file === undefined || file.deletedAt !== null) throw notFound();
      return work(tx, file, tenantId);
    });
    if (result.changed) {
      await this.deps.statusCache.invalidate(fileId);
      this.deps.logger.info({ tenantId, fileId, status: result.file.status }, "file.processing.transition");
    }
    return result.file;
  }

  private async reload(tx: Parameters<FilesRepository["get"]>[0], file: FileRecord): Promise<FileRecord> {
    return (await this.deps.files.get(tx, file.id)) ?? file;
  }
}

/** FR-FILE-06: these actions are for doc-extraction's SERVICE token only (its act[] is checked by the route). */
function serviceActor(principal: Principal): string {
  if (principal.kind !== "service") throw new DomainError("FORBIDDEN", "this action is for internal services only");
  return `service:${principal.clientId}`;
}

function notFound(): DomainError {
  return new DomainError("NOT_FOUND", "file not found");
}

function conflict(file: FileRecord): DomainError {
  return new DomainError("CONFLICT", `illegal transition from ${file.status}`);
}
