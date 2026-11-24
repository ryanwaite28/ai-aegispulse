// Publishes the Mongo outbox (ADR-0004) with publisher confirms through the kit's EnvelopePublisher. One entry at a
// time via an atomic claim with a lease, so several replicas can run it; failures back off exponentially (≤ 60 s).
// Delivery is at-least-once: consumers dedupe by eventId (NFR-02).
import type { EnvelopePublisher } from "@aegispulse/ts-platform/outbox";
import { describeError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { getMeter } from "@aegispulse/ts-platform/telemetry";
import type { MongoOutboxRepository } from "../db/outbox.repository.js";

export interface MongoOutboxRelayOptions {
  readonly repository: MongoOutboxRepository;
  readonly publisher: EnvelopePublisher;
  readonly logger: Logger;
  readonly intervalMs?: number;
  readonly leaseMs?: number;
  readonly now?: () => Date;
}

export class MongoOutboxRelay {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;
  private lag = 0;

  constructor(private readonly o: MongoOutboxRelayOptions) {
    getMeter()
      .createObservableGauge("aegispulse_outbox_lag_seconds", {
        description: "Age of the oldest unsent outbox entry",
        unit: "s",
      })
      .addCallback((r) => r.observe(this.lag, { store: "mongo" }));
  }

  start(): void {
    this.stopped = false;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.running;
  }

  /** Publishes everything due now; returns how many entries were sent (tests call it directly). */
  async drain(): Promise<number> {
    const now = (): Date => this.o.now?.() ?? new Date();
    let sent = 0;
    for (;;) {
      const doc = await this.o.repository.claim(now(), this.o.leaseMs ?? 30_000);
      if (doc === null) break;
      try {
        await this.o.publisher.publishEnvelope({
          exchange: doc.exchange,
          routingKey: doc.routingKey,
          envelope: doc.envelope,
        });
        await this.o.repository.markSent(doc.eventId, now());
        sent += 1;
      } catch (error: unknown) {
        const attempts = doc.attempts + 1;
        const delayMs = Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
        await this.o.repository.markFailed(
          doc.eventId,
          attempts,
          new Date(now().getTime() + delayMs),
          describeError(error),
        );
        this.o.logger.warn(
          { eventId: doc.eventId, attempts, err: describeError(error) },
          "outbox publish failed; will retry",
        );
        break; // broker trouble: back off instead of spinning through the queue
      }
    }
    this.lag = await this.o.repository.lagSeconds(now());
    return sent;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.drain()
        .catch((error: unknown) => this.o.logger.error({ err: describeError(error) }, "outbox relay pass failed"))
        .then(() => undefined)
        .finally(() => this.schedule(this.o.intervalMs ?? 250));
    }, delayMs);
  }
}
