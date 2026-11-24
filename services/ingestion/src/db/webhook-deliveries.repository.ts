// Webhook delivery persistence (FR-WHK-02/05/07). The source lookup runs before any tenant context through the
// SECURITY DEFINER ingestion.webhook_source_for_delivery (ADR-0016); delivery rows are written and read under RLS.
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { SqlExecutor } from "@aegispulse/ts-platform/outbox";
import type { SealedSecret } from "../domain/crypto.js";
import type { SecretSlot, SourceStatus, TrustLevel } from "../domain/webhook-source.js";

export interface SourceForDelivery {
  readonly sourceId: string;
  readonly tenantId: string;
  readonly sourceKey: string;
  readonly status: SourceStatus;
  readonly trustLevel: TrustLevel;
  readonly secrets: readonly { slot: SecretSlot; sealed: SealedSecret; expiresAt: Date | null }[];
}

interface LookupRow {
  source_id: string;
  tenant_id: string;
  source_key: string;
  status: SourceStatus;
  trust_level: TrustLevel;
  slot: SecretSlot;
  ciphertext: Buffer;
  wrapped_data_key: Buffer;
  nonce: Buffer;
  kek_version: number;
  expires_at: Date | null;
}

export interface NewDelivery {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceId: string;
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  readonly eventId: string;
  readonly externalId: string;
  readonly category: string;
  readonly rawStorageKey: string;
  readonly rawSha256: string;
  readonly signatureSlot: SecretSlot;
  readonly receivedAt: string;
  readonly correlationId: string;
}

export interface DeliveryRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly deliveryId: string;
  readonly idempotencyKey: string;
  readonly eventId: string | null;
  readonly outcome: "ACCEPTED" | "DUPLICATE";
  readonly externalId: string;
  readonly category: string;
  readonly rawSha256: string;
  readonly signatureSlot: SecretSlot;
  readonly attachmentNotes: readonly Record<string, unknown>[];
  readonly receivedAt: string;
  readonly correlationId: string;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";
}

export class WebhookDeliveryRepository {
  async sourceForDelivery(db: SqlExecutor, sourceKey: string): Promise<SourceForDelivery | undefined> {
    const r = await db.query<LookupRow>("SELECT * FROM ingestion.webhook_source_for_delivery($1)", [sourceKey]);
    const first = r.rows[0];
    if (first === undefined) return undefined;
    return {
      sourceId: first.source_id,
      tenantId: first.tenant_id,
      sourceKey: first.source_key,
      status: first.status,
      trustLevel: first.trust_level,
      secrets: r.rows.map((row) => ({
        slot: row.slot,
        sealed: {
          ciphertext: row.ciphertext,
          wrappedDataKey: row.wrapped_data_key,
          nonce: row.nonce,
          kekVersion: row.kek_version,
        },
        expiresAt: row.expires_at,
      })),
    };
  }

  /**
   * Inserts ACCEPTED, or DUPLICATE when an ACCEPTED row already holds the idempotency key (FR-WHK-05).
   * A repeated (source, deliveryId) is a replay (FR-WHK-03). Returns the stored outcome.
   */
  async insert(tx: SqlExecutor, d: NewDelivery): Promise<"ACCEPTED" | "DUPLICATE"> {
    try {
      const accepted = await tx.query(
        `INSERT INTO ingestion.webhook_deliveries (id, tenant_id, source_id, delivery_id, idempotency_key, event_id,
           outcome, external_id, category, raw_storage_key, raw_sha256, signature_slot, received_at, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACCEPTED', $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, idempotency_key) WHERE outcome = 'ACCEPTED' DO NOTHING`,
        [
          d.id,
          d.tenantId,
          d.sourceId,
          d.deliveryId,
          d.idempotencyKey,
          d.eventId,
          d.externalId,
          d.category,
          d.rawStorageKey,
          d.rawSha256,
          d.signatureSlot,
          d.receivedAt,
          d.correlationId,
        ],
      );
      if ((accepted.rowCount ?? 0) === 1) return "ACCEPTED";
      await tx.query(
        `INSERT INTO ingestion.webhook_deliveries (id, tenant_id, source_id, delivery_id, idempotency_key, event_id,
           outcome, external_id, category, raw_storage_key, raw_sha256, signature_slot, received_at, correlation_id)
         VALUES ($1, $2, $3, $4, $5, NULL, 'DUPLICATE', $6, $7, $8, $9, $10, $11, $12)`,
        [
          d.id,
          d.tenantId,
          d.sourceId,
          d.deliveryId,
          d.idempotencyKey,
          d.externalId,
          d.category,
          d.rawStorageKey,
          d.rawSha256,
          d.signatureSlot,
          d.receivedAt,
          d.correlationId,
        ],
      );
      return "DUPLICATE";
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new DomainError("WEBHOOK_REPLAY_DETECTED", "this delivery id was already received");
      }
      throw error;
    }
  }

  async list(
    tx: SqlExecutor,
    q: { sourceId: string; outcome?: string | undefined; from?: string | undefined; to?: string | undefined },
    after: { receivedAt: string; id: string } | undefined,
    limit: number,
  ): Promise<DeliveryRecord[]> {
    const where: string[] = ["source_id = $1"];
    const params: unknown[] = [q.sourceId];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      where.push(sql.replace("?", `$${String(params.length)}`));
    };
    if (q.outcome !== undefined) add("outcome = ?", q.outcome);
    if (q.from !== undefined) add("received_at >= ?::timestamptz", q.from);
    if (q.to !== undefined) add("received_at < ?::timestamptz", q.to);
    if (after !== undefined) {
      params.push(after.receivedAt, after.id);
      where.push(`(received_at, id) < ($${String(params.length - 1)}::timestamptz, $${String(params.length)}::uuid)`);
    }
    params.push(limit);
    const r = await tx.query<{
      id: string;
      source_id: string;
      delivery_id: string;
      idempotency_key: string;
      event_id: string | null;
      outcome: "ACCEPTED" | "DUPLICATE";
      external_id: string;
      category: string;
      raw_sha256: string;
      signature_slot: SecretSlot;
      attachment_notes: Record<string, unknown>[];
      received_at: Date;
      correlation_id: string;
    }>(
      `SELECT id, source_id, delivery_id, idempotency_key, event_id, outcome, external_id, category, raw_sha256,
              signature_slot, attachment_notes, received_at, correlation_id
         FROM ingestion.webhook_deliveries WHERE ${where.join(" AND ")}
        ORDER BY received_at DESC, id DESC LIMIT $${String(params.length)}`,
      params,
    );
    return r.rows.map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      deliveryId: row.delivery_id,
      idempotencyKey: row.idempotency_key,
      eventId: row.event_id,
      outcome: row.outcome,
      externalId: row.external_id,
      category: row.category,
      rawSha256: row.raw_sha256,
      signatureSlot: row.signature_slot,
      attachmentNotes: row.attachment_notes,
      receivedAt: row.received_at.toISOString(),
      correlationId: row.correlation_id,
    }));
  }

  /** True when the source exists (non-deleted) in the caller's tenant scope. */
  async sourceVisible(tx: SqlExecutor, sourceId: string): Promise<boolean> {
    const r = await tx.query("SELECT 1 FROM ingestion.webhook_sources WHERE id = $1 AND deleted_at IS NULL", [
      sourceId,
    ]);
    return (r.rowCount ?? 0) === 1;
  }
}
