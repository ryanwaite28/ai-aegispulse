// ingestion.transaction_submissions (FR-TXN-01/06), always under the tenant's RLS (withTenantTransaction).
import type { SqlExecutor } from "@aegispulse/ts-platform/outbox";
import type { Channel } from "../domain/transaction.js";

export interface TransactionRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly eventId: string;
  readonly correlationId: string;
  readonly accountId: string;
  readonly counterpartyId: string;
  readonly counterpartyName: string;
  /** NUMERIC(22,4) as text, e.g. "1250.5000". */
  readonly amount: string;
  readonly currency: string;
  readonly country: string;
  readonly channel: Channel;
  readonly occurredAt: Date;
  readonly metadata: Record<string, unknown>;
  readonly sourceFileId: string | null;
  readonly sourceRow: number | null;
  readonly submittedBy: string;
  readonly createdAt: Date;
}

export type NewTransaction = Omit<TransactionRecord, "createdAt" | "amount" | "sourceFileId" | "sourceRow"> & {
  readonly amount: string;
};

interface Row {
  id: string;
  tenant_id: string;
  idempotency_key: string;
  request_sha256: string;
  event_id: string;
  correlation_id: string;
  account_id: string;
  counterparty_id: string;
  counterparty_name: string;
  amount: string;
  currency: string;
  country: string;
  channel: Channel;
  occurred_at: Date;
  metadata: Record<string, unknown>;
  source_file_id: string | null;
  source_row: number | null;
  submitted_by: string;
  created_at: Date;
}

const COLUMNS = `id, tenant_id, idempotency_key, request_sha256, event_id, correlation_id, account_id, counterparty_id,
  counterparty_name, amount::text AS amount, currency, country, channel, occurred_at, metadata, source_file_id,
  source_row, submitted_by, created_at`;

function toRecord(r: Row): TransactionRecord {
  return {
    id: r.id,
    tenantId: r.tenant_id,
    idempotencyKey: r.idempotency_key,
    requestSha256: r.request_sha256,
    eventId: r.event_id,
    correlationId: r.correlation_id,
    accountId: r.account_id,
    counterpartyId: r.counterparty_id,
    counterpartyName: r.counterparty_name,
    amount: r.amount,
    currency: r.currency,
    country: r.country,
    channel: r.channel,
    occurredAt: r.occurred_at,
    metadata: r.metadata,
    sourceFileId: r.source_file_id,
    sourceRow: r.source_row,
    submittedBy: r.submitted_by,
    createdAt: r.created_at,
  };
}

export class TransactionRepository {
  /** Inserts unless the (tenant, idempotency key) exists; null when it does (the caller re-reads the winner). */
  async insert(tx: SqlExecutor, t: NewTransaction): Promise<TransactionRecord | null> {
    const r = await tx.query<Row>(
      `INSERT INTO ingestion.transaction_submissions
         (id, tenant_id, idempotency_key, request_sha256, event_id, correlation_id, account_id, counterparty_id,
          counterparty_name, amount, currency, country, channel, occurred_at, metadata, submitted_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::numeric,$11,$12,$13,$14,$15::jsonb,$16)
       ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        t.id,
        t.tenantId,
        t.idempotencyKey,
        t.requestSha256,
        t.eventId,
        t.correlationId,
        t.accountId,
        t.counterpartyId,
        t.counterpartyName,
        t.amount,
        t.currency,
        t.country,
        t.channel,
        t.occurredAt,
        JSON.stringify(t.metadata),
        t.submittedBy,
      ],
    );
    const row = r.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByIdempotencyKey(tx: SqlExecutor, tenantId: string, key: string): Promise<TransactionRecord | null> {
    const r = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM ingestion.transaction_submissions WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, key],
    );
    const row = r.rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findById(tx: SqlExecutor, tenantId: string, id: string): Promise<TransactionRecord | null> {
    const r = await tx.query<Row>(
      `SELECT ${COLUMNS} FROM ingestion.transaction_submissions WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const row = r.rows[0];
    return row === undefined ? null : toRecord(row);
  }
}
