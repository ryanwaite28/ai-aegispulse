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
      `UPDATE files.files SET status = $1, failure_reason = COALESCE($2, failure_reason), version = version + 1
        WHERE id = $3 AND status = $4 AND version = $5 RETURNING *`,
      [t.to, t.to === "FAILED" ? t.reason : null, t.fileId, t.from, t.expectedVersion],
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
