// files.files + files.file_status_history (§7.3). Every call runs inside the caller's tenant transaction, so RLS
// scopes rows to that tenant (ADR-0016); no query names another tenant.
import type { SqlExecutor } from "@aegispulse/ts-platform/outbox";
import type { ContentType, FileStatus, Purpose, SourceType } from "../domain/file.js";

export interface FileRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly uploadedBy: string | null;
  readonly filename: string;
  readonly storageBucket: string;
  readonly storageKey: string;
  readonly contentType: ContentType;
  readonly detectedType: string | null;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly verifiedSha256: string | null;
  readonly sourceType: SourceType;
  readonly sourceUrl: string | null;
  readonly purpose: Purpose;
  readonly relatedEntityIds: readonly string[];
  readonly status: FileStatus;
  readonly failureReason: string | null;
  readonly extractorVersion: string | null;
  readonly multipartUploadId: string | null;
  readonly correlationId: string;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface Row {
  id: string;
  tenant_id: string;
  uploaded_by: string | null;
  original_filename: string;
  storage_bucket: string;
  storage_key: string;
  content_type: ContentType;
  detected_type: string | null;
  size_bytes: string;
  sha256_checksum: string;
  verified_sha256: string | null;
  source_type: SourceType;
  source_url: string | null;
  purpose: Purpose;
  related_entity_ids: string[];
  status: FileStatus;
  failure_reason: string | null;
  extractor_version: string | null;
  multipart_upload_id: string | null;
  correlation_id: string;
  version: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function map(r: Row): FileRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    uploadedBy: r.uploaded_by,
    filename: r.original_filename,
    storageBucket: r.storage_bucket,
    storageKey: r.storage_key,
    contentType: r.content_type,
    detectedType: r.detected_type,
    sizeBytes: Number(r.size_bytes),
    sha256: r.sha256_checksum,
    verifiedSha256: r.verified_sha256,
    sourceType: r.source_type,
    sourceUrl: r.source_url,
    purpose: r.purpose,
    relatedEntityIds: r.related_entity_ids,
    status: r.status,
    failureReason: r.failure_reason,
    extractorVersion: r.extractor_version,
    multipartUploadId: r.multipart_upload_id,
    correlationId: r.correlation_id,
    version: r.version,
    deletedAt: r.deleted_at === null ? null : r.deleted_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export interface NewFile {
  readonly id: string;
  readonly tenantId: string;
  readonly uploadedBy: string | null;
  readonly filename: string;
  readonly storageBucket: string;
  readonly storageKey: string;
  readonly contentType: ContentType;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sourceType: SourceType;
  readonly purpose: Purpose;
  readonly relatedEntityIds: readonly string[];
  readonly correlationId: string;
}

export interface Transition {
  readonly fileId: string;
  readonly expectedVersion: number;
  readonly from: FileStatus;
  readonly to: FileStatus;
  readonly reason: string | null;
  readonly actor: string;
  readonly eventId: string | null;
  /** Columns set together with the status (validation results, quarantine move). */
  readonly patch?: {
    readonly detectedType?: string | undefined;
    readonly verifiedSha256?: string | undefined;
    readonly storageBucket?: string | undefined;
    readonly storageKey?: string | undefined;
    readonly extractorVersion?: string | undefined;
  };
}

export interface NewArtifact {
  readonly tenantId: string;
  readonly fileId: string;
  readonly extractorVersion: string;
  readonly resultStatus: "COMPLETED" | "REVIEW_REQUIRED";
  readonly confidence: number;
  readonly textKey: string | null;
  readonly chunksKey: string | null;
  readonly extractionKey: string;
  readonly rowErrorsKey: string | null;
  readonly rowsAccepted: number | null;
  readonly rowsRejected: number | null;
  readonly summary: Record<string, unknown>;
}

export interface ArtifactSummary {
  readonly extractorVersion: string;
  readonly resultStatus: "COMPLETED" | "REVIEW_REQUIRED";
  readonly confidence: number;
  readonly rowsAccepted: number | null;
  readonly rowsRejected: number | null;
  readonly summary: Record<string, unknown>;
  readonly createdAt: string;
}

export interface FileListFilter {
  readonly status?: string | undefined;
  readonly purpose?: string | undefined;
  readonly uploadedBy?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export class FilesRepository {
  async insert(tx: SqlExecutor, f: NewFile, actor: string): Promise<FileRecord> {
    const r = await tx.query<Row>(
      `INSERT INTO files.files (id, tenant_id, uploaded_by, original_filename, storage_bucket, storage_key, content_type,
                                size_bytes, sha256_checksum, source_type, purpose, related_entity_ids, status, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'INITIATED', $13) RETURNING *`,
      [
        f.id,
        f.tenantId,
        f.uploadedBy,
        f.filename,
        f.storageBucket,
        f.storageKey,
        f.contentType,
        f.sizeBytes,
        f.sha256,
        f.sourceType,
        f.purpose,
        f.relatedEntityIds,
        f.correlationId,
      ],
    );
    await this.history(tx, {
      tenantId: f.tenantId,
      fileId: f.id,
      from: null,
      to: "INITIATED",
      reason: null,
      actor,
      eventId: null,
    });
    return map(r.rows[0] as Row);
  }

  async get(tx: SqlExecutor, fileId: string): Promise<FileRecord | undefined> {
    const r = await tx.query<Row>("SELECT * FROM files.files WHERE id = $1", [fileId]);
    const row = r.rows[0];
    return row === undefined ? undefined : map(row);
  }

  /** FR-FILE-02: the live file with this content (ix_files_tenant_sha), oldest first. */
  async findLiveBySha(tx: SqlExecutor, sha256: string): Promise<FileRecord | undefined> {
    const r = await tx.query<Row>(
      `SELECT * FROM files.files
        WHERE sha256_checksum = $1 AND status NOT IN ('FAILED','EXPIRED') AND deleted_at IS NULL
        ORDER BY created_at LIMIT 1`,
      [sha256],
    );
    const row = r.rows[0];
    return row === undefined ? undefined : map(row);
  }

  /** FR-FILE-03: bytes held by the tenant (every file not EXPIRED and not purged). */
  async storedBytes(tx: SqlExecutor): Promise<number> {
    const r = await tx.query<{ total: string | null }>(
      "SELECT sum(size_bytes)::text AS total FROM files.files WHERE status <> 'EXPIRED' AND purged_at IS NULL",
    );
    return Number(r.rows[0]?.total ?? 0);
  }

  /**
   * Optimistic transition: applies only if the row is still at (from, expectedVersion). Returns the new record, or
   * undefined when another writer moved it first (the caller re-reads and decides).
   */
  async transition(tx: SqlExecutor, tenantId: string, t: Transition): Promise<FileRecord | undefined> {
    const r = await tx.query<Row>(
      `UPDATE files.files SET status = $1, failure_reason = COALESCE($2, failure_reason), version = version + 1,
              detected_type = COALESCE($6, detected_type), verified_sha256 = COALESCE($7, verified_sha256),
              storage_bucket = COALESCE($8, storage_bucket), storage_key = COALESCE($9, storage_key),
              extractor_version = COALESCE($10, extractor_version)
        WHERE id = $3 AND status = $4 AND version = $5 RETURNING *`,
      [
        t.to,
        t.to === "FAILED" || t.to === "QUARANTINED" ? t.reason : null,
        t.fileId,
        t.from,
        t.expectedVersion,
        t.patch?.detectedType ?? null,
        t.patch?.verifiedSha256 ?? null,
        t.patch?.storageBucket ?? null,
        t.patch?.storageKey ?? null,
        t.patch?.extractorVersion ?? null,
      ],
    );
    const row = r.rows[0];
    if (row === undefined) return undefined;
    await this.history(tx, {
      tenantId,
      fileId: t.fileId,
      from: t.from,
      to: t.to,
      reason: t.reason,
      actor: t.actor,
      eventId: t.eventId,
    });
    return map(row);
  }

  /** Pre-tenant lookup for SERVICE callers that only name a fileId (definer files.file_tenant, ADR-0016). */
  async fileTenant(db: SqlExecutor, fileId: string): Promise<string | undefined> {
    const r = await db.query<{ t: string | null }>("SELECT files.file_tenant($1) AS t", [fileId]);
    return r.rows[0]?.t ?? undefined;
  }

  /** FR-FILE-06: one artifact per (file, extractor version); false when it already exists (idempotent replay). */
  async insertArtifact(tx: SqlExecutor, a: NewArtifact): Promise<boolean> {
    const r = await tx.query(
      `INSERT INTO files.file_artifacts (tenant_id, file_id, extractor_version, result_status, confidence, text_key,
                                         chunks_key, extraction_key, row_errors_key, rows_accepted, rows_rejected, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (file_id, extractor_version) DO NOTHING`,
      [
        a.tenantId,
        a.fileId,
        a.extractorVersion,
        a.resultStatus,
        a.confidence,
        a.textKey,
        a.chunksKey,
        a.extractionKey,
        a.rowErrorsKey,
        a.rowsAccepted,
        a.rowsRejected,
        JSON.stringify(a.summary),
      ],
    );
    return (r.rowCount ?? 0) === 1;
  }

  async artifacts(tx: SqlExecutor, fileId: string): Promise<ArtifactSummary[]> {
    const r = await tx.query<{
      extractor_version: string;
      result_status: "COMPLETED" | "REVIEW_REQUIRED";
      confidence: string;
      rows_accepted: number | null;
      rows_rejected: number | null;
      summary: Record<string, unknown>;
      created_at: Date;
    }>(
      `SELECT extractor_version, result_status, confidence, rows_accepted, rows_rejected, summary, created_at
         FROM files.file_artifacts WHERE file_id = $1 ORDER BY created_at`,
      [fileId],
    );
    return r.rows.map((x) => ({
      extractorVersion: x.extractor_version,
      resultStatus: x.result_status,
      confidence: Number(x.confidence),
      rowsAccepted: x.rows_accepted,
      rowsRejected: x.rows_rejected,
      summary: x.summary,
      createdAt: x.created_at.toISOString(),
    }));
  }

  /** FR-FILE-09: newest first, keyset (created_at, id); soft-deleted files are excluded. */
  async list(
    tx: SqlExecutor,
    filter: FileListFilter,
    after: { createdAt: string; id: string } | undefined,
    limit: number,
  ): Promise<FileRecord[]> {
    const where: string[] = ["deleted_at IS NULL"];
    const args: unknown[] = [];
    const add = (sql: string, v: unknown): void => {
      args.push(v);
      where.push(sql.replace("?", `$${String(args.length)}`));
    };
    if (filter.status !== undefined) add("status = ?", filter.status);
    if (filter.purpose !== undefined) add("purpose = ?", filter.purpose);
    if (filter.uploadedBy !== undefined) add("uploaded_by = ?", filter.uploadedBy);
    if (filter.from !== undefined) add("created_at >= ?", filter.from);
    if (filter.to !== undefined) add("created_at < ?", filter.to);
    if (after !== undefined) {
      args.push(after.createdAt, after.id);
      where.push(`(created_at, id) < ($${String(args.length - 1)}::timestamptz, $${String(args.length)}::uuid)`);
    }
    args.push(limit);
    const r = await tx.query<Row>(
      `SELECT * FROM files.files WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${String(args.length)}`,
      args,
    );
    return r.rows.map(map);
  }

  /** FR-FILE-10 cross-tenant candidates (definer files.orphan_candidates, ADR-0016). */
  async orphanCandidates(
    db: SqlExecutor,
    cutoff: Date,
    limit: number,
  ): Promise<{ fileId: string; tenantId: string }[]> {
    const r = await db.query<{ file_id: string; tenant_id: string }>(
      "SELECT file_id, tenant_id FROM files.orphan_candidates($1, $2)",
      [cutoff, limit],
    );
    return r.rows.map((x) => ({ fileId: x.file_id, tenantId: x.tenant_id }));
  }

  /** FR-FILE-12 tenants holding unpurged files (definer files.retention_tenants). */
  async retentionTenants(db: SqlExecutor): Promise<string[]> {
    const r = await db.query<{ t: string }>("SELECT t FROM files.retention_tenants() AS t");
    return r.rows.map((x) => x.t);
  }

  /** Files of the current tenant created before the cutoff and not yet purged (oldest first). */
  async retentionCandidates(tx: SqlExecutor, cutoff: Date, limit: number): Promise<FileRecord[]> {
    const r = await tx.query<Row>(
      "SELECT * FROM files.files WHERE created_at < $1 AND purged_at IS NULL ORDER BY created_at LIMIT $2",
      [cutoff, limit],
    );
    return r.rows.map(map);
  }

  /** Every artifact object key recorded for the file (§7.8 artifacts/…). */
  async artifactKeys(tx: SqlExecutor, fileId: string): Promise<string[]> {
    const r = await tx.query<{ k: string | null }>(
      `SELECT unnest(ARRAY[text_key, chunks_key, extraction_key, row_errors_key]) AS k
         FROM files.file_artifacts WHERE file_id = $1`,
      [fileId],
    );
    return r.rows.flatMap((x) => (x.k === null ? [] : [x.k]));
  }

  /**
   * FR-FILE-12 tombstone: sets purged_at (and deleted_at if unset), removes artifact rows, records the purge in
   * the history. The row itself stays.
   */
  async markPurged(tx: SqlExecutor, tenantId: string, file: FileRecord, actor: string): Promise<boolean> {
    const r = await tx.query(
      "UPDATE files.files SET purged_at = now(), deleted_at = COALESCE(deleted_at, now()) WHERE id = $1 AND purged_at IS NULL",
      [file.id],
    );
    if ((r.rowCount ?? 0) === 0) return false;
    await tx.query("DELETE FROM files.file_artifacts WHERE file_id = $1", [file.id]);
    await this.history(tx, {
      tenantId,
      fileId: file.id,
      from: file.status,
      to: file.status,
      reason: "RETENTION_PURGE",
      actor,
      eventId: null,
    });
    return true;
  }

  /** FR-FILE-12 soft delete (idempotent); false when it was already deleted. */
  async softDelete(tx: SqlExecutor, tenantId: string, file: FileRecord, actor: string): Promise<boolean> {
    const r = await tx.query("UPDATE files.files SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [
      file.id,
    ]);
    if ((r.rowCount ?? 0) === 0) return false;
    await this.history(tx, {
      tenantId,
      fileId: file.id,
      from: file.status,
      to: file.status,
      reason: "DELETED",
      actor,
      eventId: null,
    });
    return true;
  }

  private async history(
    tx: SqlExecutor,
    h: {
      tenantId: string;
      fileId: string;
      from: FileStatus | null;
      to: FileStatus;
      reason: string | null;
      actor: string;
      eventId: string | null;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO files.file_status_history (tenant_id, file_id, from_status, to_status, reason, actor, event_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [h.tenantId, h.fileId, h.from, h.to, h.reason, h.actor, h.eventId],
    );
  }
}
