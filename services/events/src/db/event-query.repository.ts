// Read side of the archive (FR-EVT-04..06). Every query goes through `scoped`, which refuses a missing tenant: there
// is no code path that reads across tenants ("repository wrapper rejects tenantless queries", §11).
import type { Collection, Db, Filter } from "mongodb";
import { SEVERITIES, type Severity } from "../domain/classification/severity.js";
import type { ArchivedEvent, EventStatus, Tier } from "./archive.repository.js";

export interface EventSearch {
  readonly correlationId?: string | undefined;
  /** Prefix match on eventType. */
  readonly eventTypePrefix?: string | undefined;
  /** final_severity ≥ this. */
  readonly finalSeverity?: Severity | undefined;
  readonly status?: EventStatus | undefined;
  readonly source?: string | undefined;
  readonly entity?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
}

export interface Keyset {
  readonly occurredAt: Date;
  readonly eventId: string;
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class EventQueryRepository {
  private readonly cols: Record<Tier, Collection<ArchivedEvent>>;

  constructor(db: Db) {
    this.cols = {
      standard: db.collection<ArchivedEvent>("events_archive"),
      restricted: db.collection<ArchivedEvent>("events_restricted_audit"),
    };
  }

  private scoped(tenantId: string, extra: Filter<ArchivedEvent>): Filter<ArchivedEvent> {
    if (typeof tenantId !== "string" || tenantId === "") throw new Error("tenantless archive query refused");
    return { ...extra, tenantId };
  }

  /** FR-EVT-04: newest first, keyset on (occurredAt, eventId). */
  async search(
    tier: Tier,
    tenantId: string,
    q: EventSearch,
    after: Keyset | undefined,
    limit: number,
  ): Promise<ArchivedEvent[]> {
    const f: Filter<ArchivedEvent> = {};
    if (q.correlationId !== undefined) f.correlationId = q.correlationId;
    if (q.eventTypePrefix !== undefined) f.eventType = { $regex: `^${escapeRegex(q.eventTypePrefix)}` };
    if (q.finalSeverity !== undefined) {
      f["classification.final_severity"] = { $in: SEVERITIES.slice(SEVERITIES.indexOf(q.finalSeverity)) };
    }
    if (q.status !== undefined) f.status = q.status;
    if (q.source !== undefined) f.source = q.source;
    if (q.entity !== undefined) f.mentionedEntityIds = q.entity;
    const time: Record<string, Date> = {};
    if (q.from !== undefined) time["$gte"] = q.from;
    if (q.to !== undefined) time["$lt"] = q.to;
    if (Object.keys(time).length > 0) f.occurredAt = time;
    if (after !== undefined) {
      f.$or = [
        { occurredAt: { $lt: after.occurredAt } },
        { occurredAt: after.occurredAt, eventId: { $lt: after.eventId } },
      ];
    }
    return this.cols[tier]
      .find(this.scoped(tenantId, f), { projection: { _id: 0 } })
      .sort({ occurredAt: -1, eventId: -1 })
      .limit(limit)
      .toArray();
  }

  async get(tier: Tier, tenantId: string, eventId: string): Promise<ArchivedEvent | null> {
    return this.cols[tier].findOne(this.scoped(tenantId, { eventId }), { projection: { _id: 0 } });
  }

  /** FR-EVT-05: every event of the correlation (standard tier), oldest first; the service orders it causally. */
  async correlation(tenantId: string, correlationId: string, max = 500): Promise<ArchivedEvent[]> {
    return this.cols.standard
      .find(this.scoped(tenantId, { correlationId }), { projection: { _id: 0 } })
      .sort({ occurredAt: 1, eventId: 1 })
      .limit(max)
      .toArray();
  }

  /** FR-EVT-06: events mentioning any of the entities, of the given types (exact or `prefix.*`), since a time. */
  async forEntities(
    tenantId: string,
    entityIds: readonly string[],
    eventTypes: readonly string[],
    since: Date,
    limit: number,
  ): Promise<ArchivedEvent[]> {
    const types = eventTypes.map((t) =>
      t.endsWith(".*") ? { eventType: { $regex: `^${escapeRegex(t.slice(0, -1))}` } } : { eventType: t },
    );
    return this.cols.standard
      .find(
        this.scoped(tenantId, { mentionedEntityIds: { $in: [...entityIds] }, occurredAt: { $gte: since }, $or: types }),
        { projection: { _id: 0 } },
      )
      .sort({ occurredAt: -1, eventId: -1 })
      .limit(limit)
      .toArray();
  }
}
