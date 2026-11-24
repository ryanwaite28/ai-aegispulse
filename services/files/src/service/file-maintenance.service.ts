// Sweeps, retention and delete (FR-FILE-10/12; spec FR-FILE-01-13 §2 "Sweeps, retention, delete").
//   sweepOrphans    scheduler (*/15): INITIATED > 1 h → EXPIRED (+ file.status.changed); then any landed object is
//                   deleted, a multipart upload aborted, the session and dedup pointer released, caches invalidated
//   purgeRetention  scheduler (daily): per tenant, files created before now − retentionDays (registry) lose their
//                   object and artifact objects first (idempotent deletes), then get a tombstone (purged_at); the row stays
//   deleteFile      TENANT_ADMIN: soft delete (deleted_at; the object stays until the purge), recorded in the file's
//                   history with the actor and audited via ops.audit.file_deleted (FR-AUD-02), caches invalidated
// Cross-tenant discovery uses the V5 definer functions (ADR-0016); every change runs under the owning tenant's RLS.
import type { Principal } from "@aegispulse/ts-platform/auth";
import { tenantAccess } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { withTenantTransaction, type OutboxRepository, type SqlPool } from "@aegispulse/ts-platform/outbox";
import type { FileRecord, FilesRepository } from "../db/files.repository.js";
import { fileDeleted, fileStatusChanged } from "./events.js";
import type { DedupIndex, FileStatusCache, UploadSessionStore } from "./file-upload.service.js";
import { rolesFor } from "./roles.js";

/** FR-FILE-10: an INITIATED file older than this is an orphan. */
export const ORPHAN_AGE_MS = 3600 * 1000;
const BATCH = 500;
const MAX_BATCHES = 20;
const DAY_MS = 86_400_000;

export interface MaintenanceObjectStore {
  readonly artifactsBucket: string;
  /** Idempotent: a missing object is fine. */
  deleteObject(bucket: string, key: string): Promise<void>;
  abortMultipart(bucket: string, key: string, uploadId: string): Promise<void>;
}

export interface TenantRetentionPort {
  /** undefined when the registry does not know the tenant (skipped, logged). */
  retentionDays(tenantId: string): Promise<number | undefined>;
}

export interface DownloadUrlInvalidator {
  invalidateDownloads(fileId: string): Promise<void>;
}

export interface JobRunSummary {
  readonly processedCount: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface MaintenanceDeps {
  readonly pool: SqlPool;
  readonly files: FilesRepository;
  readonly outbox: OutboxRepository;
  readonly objects: MaintenanceObjectStore;
  readonly sessions: UploadSessionStore;
  readonly dedup: DedupIndex;
  readonly statusCache: FileStatusCache;
  readonly downloads: DownloadUrlInvalidator;
  readonly tenants: TenantRetentionPort;
  readonly version: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class FileMaintenanceService {
  private readonly now: () => Date;

  constructor(private readonly deps: MaintenanceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async sweepOrphans(principal: Principal): Promise<JobRunSummary> {
    requireService(principal);
    const startedAt = this.now();
    const cutoff = new Date(startedAt.getTime() - ORPHAN_AGE_MS);
    let expired = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const candidates = await this.deps.files.orphanCandidates(this.deps.pool, cutoff, BATCH);
      const byTenant = new Map<string, string[]>();
      for (const c of candidates) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c.fileId]);
      for (const [tenantId, ids] of byTenant) {
        const done = await withTenantTransaction(this.deps.pool, tenantId, async (tx) => {
          const out: FileRecord[] = [];
          for (const id of ids) {
            const f = await this.deps.files.get(tx, id);
            if (f?.status !== "INITIATED") continue;
            const next = await this.deps.files.transition(tx, tenantId, {
              fileId: f.id,
              expectedVersion: f.version,
              from: "INITIATED",
              to: "EXPIRED",
              reason: "ORPHAN_TIMEOUT",
              actor: "service:files",
              eventId: null,
            });
            if (next === undefined) continue; // completed or aborted concurrently
            await this.deps.outbox.enqueue(
              tx,
              fileStatusChanged(this.deps.version, next, "INITIATED", "ORPHAN_TIMEOUT"),
            );
            out.push(next);
          }
          return out;
        });
        for (const f of done) await this.releaseOrphan(f);
        expired += done.length;
      }
      if (candidates.length < BATCH) break;
    }
    return this.summary("files.sweepOrphans", startedAt, expired);
  }

  async purgeRetention(principal: Principal): Promise<JobRunSummary> {
    requireService(principal);
    const startedAt = this.now();
    let purged = 0;
    for (const tenantId of await this.deps.files.retentionTenants(this.deps.pool)) {
      const days = await this.deps.tenants.retentionDays(tenantId);
      if (days === undefined) {
        this.deps.logger.warn({ tenantId }, "files.purgeRetention: tenant unknown to the registry; skipped");
        continue;
      }
      const cutoff = new Date(startedAt.getTime() - days * DAY_MS);
      for (let batch = 0; batch < MAX_BATCHES; batch++) {
        const due = await withTenantTransaction(this.deps.pool, tenantId, (tx) =>
          this.deps.files.retentionCandidates(tx, cutoff, BATCH),
        );
        for (const f of due) if (await this.purgeOne(tenantId, f)) purged += 1;
        if (due.length < BATCH) break;
      }
    }
    return this.summary("files.purgeRetention", startedAt, purged);
  }

  async deleteFile(principal: Principal, actingTenant: string | undefined, input: { fileId: string }): Promise<void> {
    const access = tenantAccess(principal, actingTenant, rolesFor("deleteFile"));
    const actorId = access.userId;
    if (actorId === null) throw new DomainError("FORBIDDEN", "deleting a file requires a user");
    const changed = await withTenantTransaction(this.deps.pool, access.tenantId, async (tx) => {
      const f = await this.deps.files.get(tx, input.fileId);
      if (f === undefined || f.deletedAt !== null) throw new DomainError("NOT_FOUND", "file not found");
      const deleted = await this.deps.files.softDelete(tx, access.tenantId, f, access.actor);
      // FR-AUD-02: the deletion joins the cases audit chain (same transaction as the soft delete).
      if (deleted) await this.deps.outbox.enqueue(tx, fileDeleted(this.deps.version, f, actorId));
      return deleted;
    });
    if (changed) {
      await this.deps.statusCache.invalidate(input.fileId);
      await this.deps.downloads.invalidateDownloads(input.fileId);
      this.deps.logger.warn({ tenantId: access.tenantId, fileId: input.fileId, actor: access.actor }, "file.deleted");
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private async releaseOrphan(f: FileRecord): Promise<void> {
    await this.deps.objects.deleteObject(f.storageBucket, f.storageKey); // a PUT may have landed without a complete
    if (f.multipartUploadId !== null) {
      await this.deps.objects.abortMultipart(f.storageBucket, f.storageKey, f.multipartUploadId);
    }
    await this.deps.sessions.delete(f.id);
    await this.deps.dedup.release(f.tenantId, f.sha256, f.id);
    await this.deps.statusCache.invalidate(f.id);
  }

  /** Objects first (idempotent), then the tombstone: a crash in between is finished by the next run. */
  private async purgeOne(tenantId: string, f: FileRecord): Promise<boolean> {
    const artifactKeys = await withTenantTransaction(this.deps.pool, tenantId, (tx) =>
      this.deps.files.artifactKeys(tx, f.id),
    );
    await this.deps.objects.deleteObject(f.storageBucket, f.storageKey);
    for (const key of artifactKeys) await this.deps.objects.deleteObject(this.deps.objects.artifactsBucket, key);
    const marked = await withTenantTransaction(this.deps.pool, tenantId, (tx) =>
      this.deps.files.markPurged(tx, tenantId, f, "service:files"),
    );
    if (marked) {
      await this.deps.statusCache.invalidate(f.id);
      await this.deps.downloads.invalidateDownloads(f.id);
    }
    return marked;
  }

  private summary(job: string, startedAt: Date, processed: number): JobRunSummary {
    const finishedAt = this.now();
    this.deps.logger.info(
      { job, processedCount: processed, durationMs: finishedAt.getTime() - startedAt.getTime() },
      "files maintenance run",
    );
    return { processedCount: processed, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString() };
  }
}

function requireService(principal: Principal): void {
  if (principal.kind !== "service") throw new DomainError("FORBIDDEN", "this is a scheduled action");
}
