// ingestion.webhook_sources + webhook_secrets under tenant RLS: callers pass a withTenantTransaction executor.
import type { SqlExecutor } from "@aegispulse/ts-platform/outbox";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { SealedSecret } from "../domain/crypto.js";
import type { SecretSlot, SourceStatus, TrustLevel, WebhookSource } from "../domain/webhook-source.js";

interface SourceRow {
  id: string;
  tenant_id: string;
  source_key: string;
  display_name: string;
  trust_level: TrustLevel;
  payload_profile: "AEGIS_MARKET_EVENT_V1";
  allowed_attachment_hosts: string[];
  status: SourceStatus;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS =
  "id, tenant_id, source_key, display_name, trust_level, payload_profile, allowed_attachment_hosts, status, created_at, updated_at";

function map(r: SourceRow): WebhookSource {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    sourceKey: r.source_key,
    displayName: r.display_name,
    trustLevel: r.trust_level,
    payloadProfile: r.payload_profile,
    allowedAttachmentHosts: r.allowed_attachment_hosts,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export interface NewSource {
  readonly tenantId: string;
  readonly sourceKey: string;
  readonly displayName: string;
  readonly trustLevel: TrustLevel;
  readonly allowedAttachmentHosts: readonly string[];
}

export interface SourcePatch {
  readonly displayName: string;
  readonly status: SourceStatus;
  readonly trustLevel: TrustLevel;
  readonly allowedAttachmentHosts: readonly string[];
}

export class WebhookSourceRepository {
  async insert(tx: SqlExecutor, s: NewSource): Promise<WebhookSource> {
    try {
      const r = await tx.query<SourceRow>(
        `INSERT INTO ingestion.webhook_sources (tenant_id, source_key, display_name, trust_level, allowed_attachment_hosts)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [s.tenantId, s.sourceKey, s.displayName, s.trustLevel, s.allowedAttachmentHosts],
      );
      return map(r.rows[0] as SourceRow);
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new DomainError("WEBHOOK_SOURCE_KEY_TAKEN", "this sourceKey is already in use");
      }
      throw error;
    }
  }

  /** Non-deleted source by id, locked for update. */
  async lock(tx: SqlExecutor, id: string): Promise<WebhookSource | undefined> {
    const r = await tx.query<SourceRow>(
      `SELECT ${COLUMNS} FROM ingestion.webhook_sources WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return r.rows[0] === undefined ? undefined : map(r.rows[0]);
  }

  async list(
    tx: SqlExecutor,
    after: { createdAt: string; id: string } | undefined,
    limit: number,
  ): Promise<WebhookSource[]> {
    const r = await tx.query<SourceRow>(
      `SELECT ${COLUMNS} FROM ingestion.webhook_sources
        WHERE deleted_at IS NULL ${after === undefined ? "" : "AND (created_at, id) > ($2::timestamptz, $3::uuid)"}
        ORDER BY created_at, id LIMIT $1`,
      after === undefined ? [limit] : [limit, after.createdAt, after.id],
    );
    return r.rows.map(map);
  }

  async update(tx: SqlExecutor, id: string, p: SourcePatch): Promise<WebhookSource> {
    const r = await tx.query<SourceRow>(
      `UPDATE ingestion.webhook_sources
          SET display_name = $2, status = $3, trust_level = $4, allowed_attachment_hosts = $5
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, p.displayName, p.status, p.trustLevel, p.allowedAttachmentHosts],
    );
    return map(r.rows[0] as SourceRow);
  }

  async softDelete(tx: SqlExecutor, id: string): Promise<void> {
    await tx.query("UPDATE ingestion.webhook_sources SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL", [
      id,
    ]);
  }

  async putSecret(
    tx: SqlExecutor,
    tenantId: string,
    sourceId: string,
    slot: SecretSlot,
    sealed: SealedSecret,
    expiresAt: Date | null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ingestion.webhook_secrets (tenant_id, source_id, slot, ciphertext, wrapped_data_key, nonce, kek_version, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_id, slot) DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
         wrapped_data_key = EXCLUDED.wrapped_data_key, nonce = EXCLUDED.nonce, kek_version = EXCLUDED.kek_version,
         expires_at = EXCLUDED.expires_at, created_at = now()`,
      [tenantId, sourceId, slot, sealed.ciphertext, sealed.wrappedDataKey, sealed.nonce, sealed.kekVersion, expiresAt],
    );
  }

  /** Moves CURRENT to PREVIOUS (replacing any PREVIOUS) with the given expiry; returns false if no CURRENT exists. */
  async demoteCurrent(tx: SqlExecutor, sourceId: string, expiresAt: Date): Promise<boolean> {
    await tx.query("DELETE FROM ingestion.webhook_secrets WHERE source_id = $1 AND slot = 'PREVIOUS'", [sourceId]);
    const r = await tx.query(
      "UPDATE ingestion.webhook_secrets SET slot = 'PREVIOUS', expires_at = $2 WHERE source_id = $1 AND slot = 'CURRENT'",
      [sourceId, expiresAt],
    );
    return (r.rowCount ?? 0) === 1;
  }
}
