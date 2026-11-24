// Mongo transactional outbox (ADR-0004, §7.6 `outbox`): envelopes are inserted in the same transaction as the archive
// change and published by MongoOutboxRelay. Unique {eventId}; TTL on sentAt (7 d).
import type { ClientSession, Collection, Db } from "mongodb";
import type { ExchangeName } from "@aegispulse/contracts/generated/ts/topology.ts";
import type { OutboxMessage } from "@aegispulse/ts-platform/outbox";

export interface OutboxDoc {
  eventId: string;
  exchange: ExchangeName;
  routingKey: string;
  envelope: OutboxMessage["envelope"];
  status: "PENDING" | "SENDING" | "SENT";
  attempts: number;
  availableAt: Date;
  claimedUntil: Date | null;
  sentAt: Date | null;
  lastError: string | null;
}

export class MongoOutboxRepository {
  private readonly col: Collection<OutboxDoc>;

  constructor(db: Db) {
    this.col = db.collection<OutboxDoc>("outbox");
  }

  async enqueue(session: ClientSession, message: OutboxMessage, now = new Date()): Promise<void> {
    await this.col.insertOne(
      {
        eventId: message.envelope.eventId,
        exchange: message.exchange,
        routingKey: message.routingKey,
        envelope: message.envelope,
        status: "PENDING",
        attempts: 0,
        availableAt: now,
        claimedUntil: null,
        sentAt: null,
        lastError: null,
      },
      { session },
    );
  }

  /** Atomically claims one due entry (PENDING, or SENDING whose claim lapsed) for `leaseMs`. */
  async claim(now: Date, leaseMs: number): Promise<OutboxDoc | null> {
    return this.col.findOneAndUpdate(
      {
        $or: [
          { status: "PENDING", availableAt: { $lte: now } },
          { status: "SENDING", claimedUntil: { $lt: now } },
        ],
      },
      { $set: { status: "SENDING", claimedUntil: new Date(now.getTime() + leaseMs) } },
      { sort: { availableAt: 1 }, returnDocument: "after" },
    );
  }

  async markSent(eventId: string, now: Date): Promise<void> {
    await this.col.updateOne(
      { eventId },
      { $set: { status: "SENT", sentAt: now, claimedUntil: null, lastError: null } },
    );
  }

  async markFailed(eventId: string, attempts: number, retryAt: Date, error: string): Promise<void> {
    await this.col.updateOne(
      { eventId },
      {
        $set: { status: "PENDING", attempts, availableAt: retryAt, claimedUntil: null, lastError: error.slice(0, 500) },
      },
    );
  }

  /** Age of the oldest pending entry in seconds (lag gauge). */
  async lagSeconds(now: Date): Promise<number> {
    const oldest = await this.col
      .find({ status: { $ne: "SENT" } })
      .sort({ availableAt: 1 })
      .limit(1)
      .next();
    return oldest === null ? 0 : Math.max(0, (now.getTime() - oldest.availableAt.getTime()) / 1000);
  }
}
