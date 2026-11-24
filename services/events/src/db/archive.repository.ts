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

  /** false when {tenantId, eventId} already exists in either tier (duplicate = success, FR-EVT-02). */
  async insert(session: ClientSession, tier: Tier, doc: ArchivedEvent): Promise<boolean> {
    const other = await this.col(tier === "restricted" ? "standard" : "restricted").findOne(
      { tenantId: doc.tenantId, eventId: doc.eventId },
      { session, projection: { _id: 1 } },
    );
    if (other !== null) return false;
    try {
      await this.col(tier).insertOne(doc, { session });
      return true;
    } catch (error: unknown) {
      if ((error as { code?: number }).code === DUPLICATE_KEY) return false;
      throw error;
    }
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

  async find(tier: Tier, tenantId: string | null, eventId: string): Promise<ArchivedEvent | null> {
    return this.col(tier).findOne({ tenantId, eventId }, { projection: { _id: 0 } });
  }
}
