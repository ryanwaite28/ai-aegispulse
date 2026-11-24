// Idempotency helpers (NFR-02, §7.0).
// - Consumer dedup: processed_messages(consumer, event_id, replay_generation), marked inside the same transaction
//   as the service's state change, so a redelivery after commit is detected and a crash before commit retries cleanly.
// - HTTP Idempotency-Key: idempotency_records stores the request body SHA-256 and the response for 24 h; the same key
//   with a different body is 409 IDEMPOTENCY_KEY_REUSED.
import { createHash } from "node:crypto";
import { DomainError } from "../errors/index.js";
import { quoteSchema, type SqlExecutor } from "../outbox/sql.js";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export interface MessageKey {
  /** Queue name, e.g. "files.validation.q". */
  readonly consumer: string;
  readonly eventId: string;
  /** 0 = original delivery; replays carry x-aegis-replay-generation. */
  readonly replayGeneration: number;
}

export class ProcessedMessagesRepository {
  private readonly table: string;

  constructor(schema: string) {
    this.table = `${quoteSchema(schema)}.processed_messages`;
  }

  /**
   * Marks the message processed in the caller's transaction. Returns false when it was already processed
   * (duplicate: the caller skips its work and the kit acks).
   */
  async markProcessed(tx: SqlExecutor, key: MessageKey): Promise<boolean> {
    const res = await tx.query(
      `INSERT INTO ${this.table} (consumer, event_id, replay_generation) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [key.consumer, key.eventId, key.replayGeneration],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /** 14-day retention (NFR-02). */
  async purge(db: SqlExecutor, days = 14): Promise<number> {
    const res = await db.query(`DELETE FROM ${this.table} WHERE processed_at < now() - make_interval(days => $1)`, [
      days,
    ]);
    return res.rowCount ?? 0;
  }
}

export interface IdempotencyKey {
  readonly tenantId: string;
  /** Action name, e.g. "submitTransaction". */
  readonly scope: string;
  readonly key: string;
  /** sha256Hex of the raw request body. */
  readonly requestSha256: string;
}

export type IdempotencyDecision =
  { readonly kind: "new" } | { readonly kind: "replay"; readonly status: number; readonly body: unknown };

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/; // printable ASCII, bounded

export class IdempotencyRepository {
  private readonly table: string;
  private readonly schema: string;

  constructor(
    schema: string,
    private readonly ttlHours = 24,
  ) {
    this.schema = quoteSchema(schema);
    this.table = `${this.schema}.idempotency_records`;
  }

  /**
   * Claims the key in the caller's transaction. A concurrent request with the same key blocks on the primary key
   * until the first commits, then sees its stored response. Throws IDEMPOTENCY_KEY_REUSED on a body mismatch.
   * After `new`, the caller does its work and calls complete() in the same transaction.
   * `tx` must come from withTenantTransaction(id.tenantId): the table is under RLS and fails closed otherwise.
   */
  async begin(tx: SqlExecutor, id: IdempotencyKey): Promise<IdempotencyDecision> {
    if (!KEY_PATTERN.test(id.key)) {
      throw new DomainError("VALIDATION_ERROR", "invalid Idempotency-Key", {
        details: [{ field: "Idempotency-Key", message: "1-255 printable ASCII characters" }],
      });
    }
    const inserted = await tx.query(
      `INSERT INTO ${this.table} (tenant_id, scope, idempotency_key, request_sha256, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5))
       ON CONFLICT DO NOTHING`,
      [id.tenantId, id.scope, id.key, id.requestSha256, this.ttlHours],
    );
    if ((inserted.rowCount ?? 0) === 1) return { kind: "new" };

    const existing = await tx.query<{
      request_sha256: string;
      response_status: number | null;
      response_body: unknown;
      expired: boolean;
    }>(
      `SELECT request_sha256, response_status, response_body, expires_at <= now() AS expired
         FROM ${this.table} WHERE tenant_id = $1 AND scope = $2 AND idempotency_key = $3 FOR UPDATE`,
      [id.tenantId, id.scope, id.key],
    );
    const row = existing.rows[0];
    if (row === undefined || row.expired || row.response_status === null) {
      // Expired (or an orphan from a rolled-back attempt): take it over.
      await tx.query(
        `UPDATE ${this.table}
            SET request_sha256 = $4, response_status = NULL, response_body = NULL,
                expires_at = now() + make_interval(hours => $5), created_at = now()
          WHERE tenant_id = $1 AND scope = $2 AND idempotency_key = $3`,
        [id.tenantId, id.scope, id.key, id.requestSha256, this.ttlHours],
      );
      return { kind: "new" };
    }
    if (row.request_sha256 !== id.requestSha256) {
      throw new DomainError("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request body");
    }
    return { kind: "replay", status: row.response_status, body: row.response_body };
  }

  async complete(
    tx: SqlExecutor,
    id: Omit<IdempotencyKey, "requestSha256">,
    status: number,
    body: unknown,
  ): Promise<void> {
    await tx.query(
      `UPDATE ${this.table} SET response_status = $4, response_body = $5::jsonb
        WHERE tenant_id = $1 AND scope = $2 AND idempotency_key = $3`,
      [id.tenantId, id.scope, id.key, status, JSON.stringify(body)],
    );
  }

  /**
   * Cross-tenant retention purge (NFR-02). RLS cannot be lifted from a service session, so this calls the
   * migration-defined SECURITY DEFINER function owned by `{schema}_platform` (ADR-0016).
   */
  async purgeExpired(db: SqlExecutor): Promise<number> {
    const res = await db.query<{ n: number }>(`SELECT ${this.schema}.purge_expired_idempotency_records() AS n`);
    return res.rows[0]?.n ?? 0;
  }
}
