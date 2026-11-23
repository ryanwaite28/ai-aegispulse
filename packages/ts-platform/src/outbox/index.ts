// Transactional outbox (PROJECT.md §6.6, §7.0, ADR-0004).
// - enqueue() runs inside the service's own transaction, next to the state change.
// - The relay polls every 250 ms: SELECT … FOR UPDATE SKIP LOCKED LIMIT 100 of due PENDING rows, publishes each with
//   publisher confirms, marks SENT; failures back off (available_at = now() + 2^attempts s, cap 5 min) and become
//   FAILED after 20 attempts. SENT rows are purged after 7 days. aegispulse_outbox_lag_seconds = age of oldest PENDING.
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import type { ExchangeName } from "@aegispulse/contracts/generated/ts/topology.ts";
import { describeError } from "../errors/index.js";
import type { Logger } from "../logging/index.js";
import { getMeter } from "../telemetry/index.js";
import { quoteSchema, withTransaction, type SqlExecutor, type SqlPool } from "./sql.js";

export * from "./sql.js";

export const OUTBOX_MAX_ATTEMPTS = 20;
export const OUTBOX_MAX_BACKOFF_SECONDS = 300;

export interface OutboxMessage {
  readonly exchange: ExchangeName;
  /** = envelope.eventType (§6.7). */
  readonly routingKey: string;
  readonly envelope: CanonicalEnvelope;
}

export interface OutboxRow {
  readonly id: string;
  readonly eventId: string;
  readonly tenantId: string | null;
  readonly exchange: ExchangeName;
  readonly routingKey: string;
  readonly envelope: CanonicalEnvelope;
  readonly attempts: number;
}

interface OutboxDbRow {
  id: string;
  event_id: string;
  tenant_id: string | null;
  exchange: ExchangeName;
  routing_key: string;
  envelope: CanonicalEnvelope;
  attempts: number;
}

/** Backoff after a failed attempt (attempts counts the failure just recorded). */
export function outboxBackoffSeconds(attempts: number): number {
  return Math.min(2 ** attempts, OUTBOX_MAX_BACKOFF_SECONDS);
}

export class OutboxRepository {
  private readonly table: string;

  constructor(schema: string) {
    this.table = `${quoteSchema(schema)}.outbox_events`;
  }

  /** Inserts a PENDING row in the caller's transaction. A duplicate eventId is a no-op (idempotent producers). */
  async enqueue(tx: SqlExecutor, message: OutboxMessage): Promise<boolean> {
    if (message.routingKey !== message.envelope.eventType) {
      throw new TypeError(`routing key ${message.routingKey} must equal eventType ${message.envelope.eventType}`);
    }
    const res = await tx.query(
      `INSERT INTO ${this.table} (tenant_id, event_id, exchange, routing_key, envelope)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        message.envelope.tenantId,
        message.envelope.eventId,
        message.exchange,
        message.routingKey,
        JSON.stringify(message.envelope),
      ],
    );
    return (res.rowCount ?? 0) === 1;
  }

  /** Locks up to `limit` due PENDING rows; other relay replicas skip them (SKIP LOCKED). */
  async claimBatch(tx: SqlExecutor, limit = 100): Promise<OutboxRow[]> {
    const res = await tx.query<OutboxDbRow>(
      `SELECT id, event_id, tenant_id, exchange, routing_key, envelope, attempts
         FROM ${this.table}
        WHERE status = 'PENDING' AND available_at <= now()
        ORDER BY available_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return res.rows.map((r) => ({
      id: r.id,
      eventId: r.event_id,
      tenantId: r.tenant_id,
      exchange: r.exchange,
      routingKey: r.routing_key,
      envelope: r.envelope,
      attempts: r.attempts,
    }));
  }

  async markSent(tx: SqlExecutor, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await tx.query(
      `UPDATE ${this.table} SET status = 'SENT', sent_at = now(), last_error = NULL WHERE id = ANY($1::uuid[])`,
      [ids],
    );
  }

  /** Records a failed publish: backs off, or FAILED once the attempt budget is spent. Returns the new status. */
  async markFailed(tx: SqlExecutor, row: OutboxRow, error: string): Promise<"PENDING" | "FAILED"> {
    const attempts = row.attempts + 1;
    const status = attempts >= OUTBOX_MAX_ATTEMPTS ? "FAILED" : "PENDING";
    await tx.query(
      `UPDATE ${this.table}
          SET attempts = $2, status = $3, last_error = $4,
              available_at = now() + make_interval(secs => $5)
        WHERE id = $1`,
      [row.id, attempts, status, error.slice(0, 1000), outboxBackoffSeconds(attempts)],
    );
    return status;
  }

  /** Deletes SENT rows older than `days` (default 7). Returns the number deleted. */
  async purgeSent(db: SqlExecutor, days = 7): Promise<number> {
    const res = await db.query(
      `DELETE FROM ${this.table} WHERE status = 'SENT' AND sent_at < now() - make_interval(days => $1)`,
      [days],
    );
    return res.rowCount ?? 0;
  }

  /** Age in seconds of the oldest PENDING row (0 when none). */
  async lagSeconds(db: SqlExecutor): Promise<number> {
    const res = await db.query<{ lag: string | number | null }>(
      `SELECT EXTRACT(EPOCH FROM (now() - min(created_at))) AS lag FROM ${this.table} WHERE status = 'PENDING'`,
    );
    const lag = res.rows[0]?.lag;
    return lag === null || lag === undefined ? 0 : Math.max(0, Number(lag));
  }
}

/** What the relay needs from the broker: a confirmed publish (amqp/ AmqpPublisher implements it). */
export interface EnvelopePublisher {
  publishEnvelope(message: OutboxMessage): Promise<void>;
}

export interface OutboxRelayOptions {
  readonly pool: SqlPool;
  readonly repository: OutboxRepository;
  readonly publisher: EnvelopePublisher;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly batchSize?: number;
  /** How often the lag gauge is refreshed. */
  readonly lagRefreshMs?: number;
}

export class OutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private lag = 0;
  private lastLagAt = 0;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly lagRefreshMs: number;

  constructor(private readonly options: OutboxRelayOptions) {
    this.intervalMs = options.intervalMs ?? 250;
    this.batchSize = options.batchSize ?? 100;
    this.lagRefreshMs = options.lagRefreshMs ?? 5_000;
    getMeter()
      .createObservableGauge("aegispulse_outbox_lag_seconds", {
        description: "Age of the oldest PENDING outbox row",
        unit: "s",
      })
      .addCallback((result) => result.observe(this.lag));
  }

  get lagSeconds(): number {
    return this.lag;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  /** Stops polling and waits for the in-flight batch to finish (NFR-11 "flush outbox relay batch"). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One poll: publish due rows. Returns the number of rows processed. Public for tests and drain. */
  async runOnce(): Promise<number> {
    const { pool, repository, publisher, logger } = this.options;
    const processed = await withTransaction(pool, async (tx) => {
      const rows = await repository.claimBatch(tx, this.batchSize);
      if (rows.length === 0) return 0;
      const results = await Promise.allSettled(
        rows.map((row) =>
          publisher.publishEnvelope({ exchange: row.exchange, routingKey: row.routingKey, envelope: row.envelope }),
        ),
      );
      const sent: string[] = [];
      for (const [i, result] of results.entries()) {
        const row = rows[i];
        if (row === undefined) continue;
        if (result.status === "fulfilled") {
          sent.push(row.id);
          continue;
        }
        const reason = describeError(result.reason);
        const status = await repository.markFailed(tx, row, reason);
        const log = { eventId: row.eventId, tenantId: row.tenantId, attempts: row.attempts + 1, err: reason };
        if (status === "FAILED") logger.error(log, "outbox row FAILED after max attempts");
        else logger.warn(log, "outbox publish failed; backing off");
      }
      await repository.markSent(tx, sent);
      return rows.length;
    });
    if (Date.now() - this.lastLagAt >= this.lagRefreshMs) {
      this.lastLagAt = Date.now();
      this.lag = await repository.lagSeconds(pool);
    }
    return processed;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let processed = 0;
    try {
      processed = await this.runOnce();
    } catch (error: unknown) {
      this.options.logger.error({ err: describeError(error) }, "outbox relay poll failed");
    }
    // A full batch means more rows are probably due: poll again immediately.
    this.schedule(processed >= this.batchSize ? 0 : this.intervalMs);
  }
}
