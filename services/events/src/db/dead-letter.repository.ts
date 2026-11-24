// dead_letters (§7.6, FR-MSG-02/03). One OPEN record per (queue, failing message): the message is identified by its
// eventId, or by the body hash when the body carried none (poison). A repeat failure of the same message while the
// record is OPEN updates it (lastFailedAt, occurrences) instead of adding a row; after a replay or discard, a new
// failure opens a new record (unique {queue, eventId, lastFailedAt} keeps the history apart).
import { ObjectId, type ClientSession, type Collection, type Db, type Filter } from "mongodb";
import {
  resolvedExpireAt,
  type DeadLetterFacts,
  type DeadLetterStatus,
  type ResolveAction,
} from "../domain/dead-letter.js";

export interface DeadLetterDoc {
  _id: ObjectId;
  tenantId: string | null;
  eventId: string | null;
  eventType: string | null;
  queue: string;
  routingKey: string | null;
  envelope: Record<string, unknown> | null;
  rawBody: string | null;
  bodySha256: string;
  /** "{tenantId|-}|{eventId | sha256:{bodySha256}}": the OPEN-uniqueness key (migrations 20261124000001/2). */
  identityKey: string;
  /** The queue header disagreed with the routing key: never replayed. */
  queueHeaderMismatch?: boolean;
  /** Set on resolution (resolvedAt + 30 days); the TTL index deletes the record then. OPEN records have none. */
  expireAt?: Date | null;
  headers: Record<string, unknown>;
  errorCode: string;
  errorMessage: string;
  stackHash: string | null;
  retryCount: number;
  occurrences: number;
  firstFailedAt: Date;
  lastFailedAt: Date;
  status: DeadLetterStatus;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  reason: string | null;
}

export interface DeadLetterFilter {
  /** undefined = every tenant (PLATFORM_ADMIN without X-Aegis-Tenant). */
  readonly tenantId?: string | undefined;
  readonly queue?: string | undefined;
  readonly errorCode?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface DeadLetterKeyset {
  readonly lastFailedAt: Date;
  readonly id: ObjectId;
}

export function parseObjectId(id: string): ObjectId | null {
  return /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}

export class DeadLetterRepository {
  private readonly col: Collection<DeadLetterDoc>;

  constructor(db: Db) {
    this.col = db.collection<DeadLetterDoc>("dead_letters");
  }

  /**
   * Upserts the OPEN record for this failure; `created` is true when a new record was opened. A concurrent insert of
   * the same message violates the partial unique index (E11000); the service reruns its transaction, which then
   * updates the winner's record.
   */
  async recordFailure(
    session: ClientSession,
    facts: DeadLetterFacts,
    now: Date,
  ): Promise<{ doc: DeadLetterDoc; created: boolean }> {
    const identityKey = facts.identityKey;
    const result = await this.col.findOneAndUpdate(
      { queue: facts.queue, identityKey, status: "OPEN" },
      {
        $setOnInsert: {
          tenantId: facts.tenantId,
          eventId: facts.eventId,
          eventType: facts.eventType,
          routingKey: facts.routingKey,
          bodySha256: facts.bodySha256,
          firstFailedAt: now,
          resolvedBy: null,
          resolvedAt: null,
          reason: null,
        },
        $set: {
          envelope: facts.envelope,
          rawBody: facts.rawBody,
          headers: facts.headers,
          errorCode: facts.errorCode,
          errorMessage: facts.errorMessage,
          stackHash: facts.stackHash,
          retryCount: facts.retryCount,
          queueHeaderMismatch: facts.queueHeaderMismatch,
          lastFailedAt: now,
        },
        $inc: { occurrences: 1 },
      },
      { upsert: true, returnDocument: "after", includeResultMetadata: true, session },
    );
    if (result.value === null) throw new Error("dead_letters upsert returned no document");
    return { doc: result.value, created: result.lastErrorObject?.["updatedExisting"] !== true };
  }

  async list(filter: DeadLetterFilter, after: DeadLetterKeyset | undefined, limit: number): Promise<DeadLetterDoc[]> {
    const q: Filter<DeadLetterDoc> = {};
    if (filter.tenantId !== undefined) q.tenantId = filter.tenantId;
    if (filter.queue !== undefined) q.queue = filter.queue;
    if (filter.errorCode !== undefined) q.errorCode = filter.errorCode;
    const range: { $gte?: Date; $lte?: Date } = {};
    if (filter.from !== undefined) range.$gte = filter.from;
    if (filter.to !== undefined) range.$lte = filter.to;
    const and: Filter<DeadLetterDoc>[] = [q];
    if (range.$gte !== undefined || range.$lte !== undefined) and.push({ lastFailedAt: range });
    if (after !== undefined) {
      and.push({
        $or: [
          { lastFailedAt: { $lt: after.lastFailedAt } },
          { lastFailedAt: after.lastFailedAt, _id: { $lt: after.id } },
        ],
      });
    }
    return this.col
      .find(and.length === 1 ? q : { $and: and })
      .sort({ lastFailedAt: -1, _id: -1 })
      .limit(limit)
      .toArray();
  }

  /** `tenantId` undefined = any tenant (PLATFORM_ADMIN). */
  async find(id: ObjectId, tenantId: string | undefined, session?: ClientSession): Promise<DeadLetterDoc | null> {
    const q: Filter<DeadLetterDoc> = tenantId === undefined ? { _id: id } : { _id: id, tenantId };
    return this.col.findOne(q, session === undefined ? {} : { session });
  }

  /** OPEN → action, conditional on the record still being OPEN; null when another request resolved it first. */
  async resolve(
    session: ClientSession,
    id: ObjectId,
    action: ResolveAction,
    actor: string,
    reason: string | null,
    now: Date,
  ): Promise<DeadLetterDoc | null> {
    return this.col.findOneAndUpdate(
      { _id: id, status: "OPEN" },
      { $set: { status: action, resolvedBy: actor, resolvedAt: now, reason, expireAt: resolvedExpireAt(now) } },
      { returnDocument: "after", session },
    );
  }
}
