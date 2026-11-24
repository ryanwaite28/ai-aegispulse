// validateFile (FR-FILE-05; spec FR-FILE-01-13 §2 "Validation"). Consumer action for `file.uploaded`:
//   1. Load the file under the tenant's RLS. Not UPLOADED → no-op ack (a QUARANTINED file first finishes its move).
//   2. One streaming pass over the object: SHA-256, byte count, head for sniffing, and clamd INSTREAM (when enabled).
//      Reading stops once the object exceeds its declared size.
//   3. Verdict (domain/validation.decide). QUARANTINED → server-side copy to quarantine/{tenantId}/{fileId} first.
//   4. One tenant TX: processed_messages (NFR-02) → optimistic transition (+ detected type, verified sha, location)
//      → outbox file.status.changed + doc.file.ready (VALIDATED) or notification.requested N-03 (QUARANTINED).
//   5. After commit: QUARANTINED → delete the raw object; invalidate the status cache.
// A crash between steps is safe: the copy and delete are idempotent, and a redelivery of a QUARANTINED file only
// finishes the delete.
import { createHash } from "node:crypto";
import { PermanentError } from "@aegispulse/ts-platform/errors";
import type { ProcessedMessagesRepository } from "@aegispulse/ts-platform/idempotency";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { withTenantTransaction, type OutboxRepository, type SqlPool } from "@aegispulse/ts-platform/outbox";
import { decide, sniff, SNIFF_BYTES, type Measurements } from "../domain/validation.js";
import type { FileRecord, FilesRepository } from "../db/files.repository.js";
import { docFileReady, fileQuarantinedNotice, fileStatusChanged } from "./events.js";
import type { FileStatusCache } from "./file-upload.service.js";

/** One streaming AV scan (clamd INSTREAM). */
export interface AvSession {
  write(chunk: Uint8Array): Promise<void>;
  finish(): Promise<{ clean: boolean; signature: string | null }>;
  abort(): void;
}
export interface AvScanner {
  open(): Promise<AvSession>;
}

export interface ValidationObjectStore {
  /** Streams the object; undefined when it does not exist. */
  read(key: string): Promise<AsyncIterable<Uint8Array> | undefined>;
  /** Server-side copy into the quarantine bucket at quarantine/{tenantId}/{fileId}; idempotent. */
  quarantine(rawKey: string, tenantId: string, fileId: string): Promise<{ bucket: string; key: string }>;
  deleteRaw(key: string): Promise<void>;
}

export interface TenantSlugPort {
  slug(tenantId: string): Promise<string>;
}

export interface ValidationDeps {
  readonly pool: SqlPool;
  readonly files: FilesRepository;
  readonly outbox: OutboxRepository;
  readonly processed: ProcessedMessagesRepository;
  readonly objects: ValidationObjectStore;
  /** undefined when FILES_AV_ENABLED=false. */
  readonly av: AvScanner | undefined;
  readonly tenants: TenantSlugPort;
  readonly statusCache: FileStatusCache;
  readonly version: string;
  readonly logger: Logger;
}

export interface ValidateFileInput {
  readonly eventId: string;
  readonly replayGeneration: number;
  readonly tenantId: string;
  readonly fileId: string;
  /** The raw key from file.uploaded (used to finish an interrupted quarantine move). */
  readonly storageKey: string;
}

export const VALIDATION_CONSUMER = "files.validation.q";

export class FileValidationService {
  constructor(private readonly deps: ValidationDeps) {}

  async validateFile(input: ValidateFileInput): Promise<"processed" | "duplicate"> {
    const file = await withTenantTransaction(this.deps.pool, input.tenantId, (tx) =>
      this.deps.files.get(tx, input.fileId),
    );
    if (file === undefined) {
      throw new PermanentError("NOT_FOUND", "file.uploaded for a file that does not exist in its tenant");
    }
    if (file.status === "QUARANTINED") {
      if (file.storageKey !== input.storageKey) await this.deps.objects.deleteRaw(input.storageKey);
      return "duplicate";
    }
    if (file.status !== "UPLOADED") return "duplicate";

    const measured = await this.measure(file);
    const verdict =
      measured === undefined
        ? ({ to: "FAILED", reason: "OBJECT_MISSING" } as const)
        : decide({ sizeBytes: file.sizeBytes, sha256: file.sha256, contentType: file.contentType }, measured);

    let location: { bucket: string; key: string } | undefined;
    let tenantSlug = "";
    if (verdict.to === "QUARANTINED") {
      tenantSlug = await this.deps.tenants.slug(file.tenantId);
      location = await this.deps.objects.quarantine(file.storageKey, file.tenantId, file.id);
    }

    const updated = await withTenantTransaction(this.deps.pool, file.tenantId, async (tx) => {
      const fresh = await this.deps.processed.markProcessed(tx, {
        consumer: VALIDATION_CONSUMER,
        eventId: input.eventId,
        replayGeneration: input.replayGeneration,
      });
      if (!fresh) return undefined;
      const next = await this.deps.files.transition(tx, file.tenantId, {
        fileId: file.id,
        expectedVersion: file.version,
        from: "UPLOADED",
        to: verdict.to,
        reason: verdict.reason,
        actor: "service:files",
        eventId: input.eventId,
        patch: {
          detectedType: measured?.detected,
          verifiedSha256: measured?.sha256,
          storageBucket: location?.bucket,
          storageKey: location?.key,
        },
      });
      if (next === undefined) return undefined; // another delivery moved it first
      await this.deps.outbox.enqueue(tx, fileStatusChanged(this.deps.version, next, "UPLOADED", verdict.reason));
      if (next.status === "VALIDATED") await this.deps.outbox.enqueue(tx, docFileReady(this.deps.version, next));
      if (next.status === "QUARANTINED") {
        await this.deps.outbox.enqueue(
          tx,
          fileQuarantinedNotice(this.deps.version, next, verdict.reason ?? "QUARANTINED", tenantSlug),
        );
      }
      return next;
    });
    if (updated === undefined) return "duplicate";
    if (updated.status === "QUARANTINED") await this.deps.objects.deleteRaw(file.storageKey);
    await this.deps.statusCache.invalidate(file.id);
    this.deps.logger.info(
      {
        tenantId: file.tenantId,
        fileId: file.id,
        outcome: updated.status,
        reason: verdict.reason,
        detected: measured?.detected,
      },
      "file.validated",
    );
    return "processed";
  }

  /** One pass: hash, count, sniff head, AV stream. undefined when the object is gone. */
  private async measure(file: FileRecord): Promise<Measurements | undefined> {
    const body = await this.deps.objects.read(file.storageKey);
    if (body === undefined) return undefined;
    const hash = createHash("sha256");
    const head: Uint8Array[] = [];
    let headBytes = 0;
    let size = 0;
    const av = this.deps.av === undefined ? undefined : await this.deps.av.open();
    try {
      for await (const chunk of body) {
        size += chunk.length;
        if (size > file.sizeBytes) break; // larger than declared: SIZE_MISMATCH, stop reading
        hash.update(chunk);
        if (headBytes < SNIFF_BYTES) {
          head.push(chunk.subarray(0, SNIFF_BYTES - headBytes));
          headBytes += Math.min(chunk.length, SNIFF_BYTES - headBytes);
        }
        if (av !== undefined) await av.write(chunk);
      }
      const verdict = av === undefined ? null : await av.finish();
      const headBuf = Buffer.concat(head);
      return {
        sizeBytes: size,
        sha256: hash.digest("hex"),
        detected: sniff(headBuf, size > headBuf.length),
        av: verdict,
      };
    } catch (error: unknown) {
      av?.abort();
      throw error;
    }
  }
}
