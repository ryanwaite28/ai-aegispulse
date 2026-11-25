// events_archive / events_restricted_audit (§7.6). Every query names the tenant (FR-EVT-04 "mandatory tenant
// filter"); inserts rely on the unique {tenantId, eventId} index for idempotency (FR-EVT-02).
import type { ClientSession, Collection, Db } from "mongodb";
import type { Category, Sensitivity, Severity } from "../domain/classification/severity.js";
import type { Redaction } from "../domain/classification/rules-v1.js";

export type Tier = "standard" | "restricted";
export type EventStatus =
  "INGESTED" | "RULE_SCANNED" | "AI_SCANNED" | "CLASSIFIED" | "OVERRIDDEN" | "ARCHIVED" | "REPLAYED";

export interface StoredClassification {
  sensitivity: Sensitivity;
  categories: Category[];
  publisher_stated_severity: Severity | null;
  source_trust_level: "TRUSTED" | "UNTRUSTED";
  algorithm_severity: Severity;
  algorithm_confidence: number | null;
  final_severity: Severity;
  classification_source: "RULES" | "AI_SCANNER" | "ANALYST";
  rule_version: string;
  classifier_version: string | null;
  revision: number;
}

export interface ArchivedEvent {
  tenantId: string | null;
  eventId: string;
  correlationId: string;
  causationId: string | null;
  eventType: string;
  source: string;
  producer: string;
  exchange: string;
  routingKey: string;
  schemaVersion: string;
  occurredAt: Date;
  ingestedAt: Date;
  archivedAt: Date;
  idempotencyKey: string;
  classification: StoredClassification;
  status: EventStatus;
  statusHistory: { status: EventStatus; at: Date; by: string }[];
  classificationHistory: {
    stage: "RULES" | "AI_SCANNER" | "ANALYST";
    source: "RULES" | "AI_SCANNER" | "ANALYST";
    sensitivity: Sensitivity;
    severity: Severity;
    confidence: number | null;
    version: string;
    at: Date;
    actor?: string;
    justification?: string;
  }[];
  payload: Record<string, unknown>;
  redactions: Redaction[];
  payloadSha256: string;
  mentionedEntityIds: string[];
  pendingAiScan: boolean;
  replay: { count: number; lastReplayedAt: Date | null; lastJobId: string | null };
  expireAt: Date;
}

const DUPLICATE_KEY = 11000;

/** E11000 from an insert (possibly wrapped by the driver's transaction helper). */
export function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown }).code === DUPLICATE_KEY;
}

export class ArchiveRepository {
  private readonly standard: Collection<ArchivedEvent>;
  private readonly restricted: Collection<ArchivedEvent>;

  constructor(db: Db) {
    this.standard = db.collection<ArchivedEvent>("events_archive");
    this.restricted = db.collection<ArchivedEvent>("events_restricted_audit");
  }

  private col(tier: Tier): Collection<ArchivedEvent> {
    return tier === "restricted" ? this.restricted : this.standard;
  }

  /**
   * false when {tenantId, eventId} already exists in either tier (duplicate = success, FR-EVT-02). A concurrent
   * duplicate that wins the unique index between the check and the insert surfaces as E11000 (see
   * isDuplicateKey): inside a transaction the server has already aborted it, so the caller must treat that error as
   * "duplicate" outside the transaction (catching it here and committing would fail with NoSuchTransaction, 251).
   */
  async insert(session: ClientSession, tier: Tier, doc: ArchivedEvent): Promise<boolean> {
    for (const t of ["standard", "restricted"] as const) {
      const existing = await this.col(t).findOne(
        { tenantId: doc.tenantId, eventId: doc.eventId },
        { session, projection: { _id: 1 } },
      );
      if (existing !== null) return false;
    }
    await this.col(tier).insertOne(doc, { session });
    return true;
  }

  /** FR-EVT-02 replay: bump replay metadata only; never creates a record. false when the event is not archived. */
  async recordReplay(tenantId: string | null, eventId: string, jobId: string, at: Date): Promise<boolean> {
    for (const tier of ["standard", "restricted"] as const) {
      const r = await this.col(tier).updateOne(
        { tenantId, eventId },
        { $inc: { "replay.count": 1 }, $set: { "replay.lastReplayedAt": at, "replay.lastJobId": jobId } },
      );
      if (r.matchedCount > 0) return true;
    }
    return false;
  }

  /** Optimistic write (FR-CLS-05/07): replaces the record only while its classification revision is unchanged. */
  async replaceIfRevision(session: ClientSession, tier: Tier, revision: number, next: ArchivedEvent): Promise<boolean> {
    const r = await this.col(tier).replaceOne(
      { tenantId: next.tenantId, eventId: next.eventId, "classification.revision": revision },
      next,
      { session },
    );
    return r.matchedCount === 1;
  }

  /** Standard → restricted in one transaction (sensitivity raised to RESTRICTED); revision-guarded like replace. */
  async moveToRestricted(session: ClientSession, revision: number, next: ArchivedEvent): Promise<boolean> {
    const removed = await this.standard.deleteOne(
      { tenantId: next.tenantId, eventId: next.eventId, "classification.revision": revision },
      { session },
    );
    if (removed.deletedCount !== 1) return false;
    await this.restricted.insertOne(next, { session });
    return true;
  }

  async find(tier: Tier, tenantId: string | null, eventId: string): Promise<ArchivedEvent | null> {
    return this.col(tier).findOne({ tenantId, eventId }, { projection: { _id: 0 } });
  }
}
