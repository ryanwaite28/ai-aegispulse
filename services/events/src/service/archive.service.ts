// archiveEvent (FR-EVT-01..03, FR-CLS-01/02; spec FR-EVT-CLS-phase-06). Consumer action for events.archive.q:
//   replay-tagged delivery → bump replay metadata only (never a new record);
//   otherwise Stage 1 (rules-v1, synchronous) → tier (RESTRICTED → events_restricted_audit) → severity resolution
//   (§1.4.3, publisher severity only for TRUSTED sources) → one Mongo transaction: insert the archive record (unique
//   {tenantId, eventId}; duplicate = success) + outbox classification.finalized (no Stage 2) or
//   classification.scan.requested (Stage 2; pendingAiScan, status RULE_SCANNED, final = rule resolution until then).
//   Terminal families (classification.*, intel.*, ops.*, registry.*, correlation.*, notification.*) emit nothing.
// The envelope was already schema-validated by the kit consumer (invalid → DLQ ENVELOPE_INVALID, FR-EVT-01).
import { createHash } from "node:crypto";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { getMeter } from "@aegispulse/ts-platform/telemetry";
import type { ClientSession, MongoClient } from "mongodb";
import { classifyStage1, RULE_VERSION } from "../domain/classification/rules-v1.js";
import { resolveSeverity } from "../domain/classification/severity-resolver.js";
import { isSeverity } from "../domain/classification/severity.js";
import { expireAt } from "../domain/retention.js";
import { isDuplicateKey, type ArchiveRepository, type ArchivedEvent, type Tier } from "../db/archive.repository.js";
import type { MongoOutboxRepository } from "../db/outbox.repository.js";
import { classificationFinalized, scanRequested } from "./events.js";

export interface TenantRetentionPort {
  /** retentionDays from the registry (kit cache); the default (400) for tenantless envelopes. */
  retentionDays(tenantId: string | null): Promise<number>;
}

export interface DeliveryMeta {
  readonly exchange: string;
  readonly routingKey: string;
  readonly replayJob: string | undefined;
}

export interface ArchiveDeps {
  readonly client: MongoClient;
  readonly archive: ArchiveRepository;
  readonly outbox: MongoOutboxRepository;
  readonly tenants: TenantRetentionPort;
  readonly version: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export type ArchiveOutcome = "archived" | "duplicate" | "replay";

export class ArchiveService {
  private readonly now: () => Date;
  private readonly stage1Ms = getMeter().createHistogram("aegispulse_classification_stage1_seconds", {
    description: "Stage 1 rule classification time per event (FR-CLS-01 budget p95 ≤ 5 ms)",
    unit: "s",
  });

  constructor(private readonly deps: ArchiveDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async archiveEvent(envelope: CanonicalEnvelope, delivery: DeliveryMeta): Promise<ArchiveOutcome> {
    const archivedAt = this.now();
    if (delivery.replayJob !== undefined) {
      const found = await this.deps.archive.recordReplay(
        envelope.tenantId,
        envelope.eventId,
        delivery.replayJob,
        archivedAt,
      );
      if (!found)
        this.deps.logger.warn(
          { eventId: envelope.eventId, replayJob: delivery.replayJob },
          "replay of an event that is not archived",
        );
      return "replay";
    }

    const original = (envelope.payload ?? {}) as Record<string, unknown>;
    const t0 = process.hrtime.bigint();
    const stage1 = classifyStage1(envelope.eventType, original);
    this.stage1Ms.record(Number(process.hrtime.bigint() - t0) / 1e9, { event_type: envelope.eventType });

    const produced = envelope.classification;
    const publisher = isSeverity(produced.publisher_stated_severity) ? produced.publisher_stated_severity : null;
    const trust = produced.source_trust_level === "TRUSTED" ? "TRUSTED" : "UNTRUSTED";
    const resolution = resolveSeverity({ rule: stage1.severity, publisher, trustedSource: trust === "TRUSTED" });
    const finalNow = !stage1.needsStage2;
    const tier: Tier = stage1.sensitivity === "RESTRICTED" ? "restricted" : "standard";
    const retention = await this.deps.tenants.retentionDays(envelope.tenantId);

    const doc: ArchivedEvent = {
      tenantId: envelope.tenantId,
      eventId: envelope.eventId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId ?? null,
      eventType: envelope.eventType,
      source: envelope.source,
      producer: envelope.producer,
      exchange: delivery.exchange,
      routingKey: delivery.routingKey,
      schemaVersion: envelope.schemaVersion,
      occurredAt: new Date(envelope.occurredAt),
      ingestedAt: new Date(envelope.ingestedAt),
      archivedAt,
      idempotencyKey: envelope.idempotencyKey,
      classification: {
        sensitivity: stage1.sensitivity,
        categories: [...stage1.categories],
        publisher_stated_severity: publisher,
        source_trust_level: trust,
        algorithm_severity: resolution.algorithm,
        algorithm_confidence: null,
        final_severity: resolution.final,
        classification_source: "RULES",
        rule_version: RULE_VERSION,
        classifier_version: null,
        revision: 1,
      },
      status: finalNow ? "CLASSIFIED" : "RULE_SCANNED",
      statusHistory: [
        { status: "INGESTED", at: new Date(envelope.ingestedAt), by: envelope.producer },
        { status: "RULE_SCANNED", at: archivedAt, by: RULE_VERSION },
        ...(finalNow ? [{ status: "CLASSIFIED" as const, at: archivedAt, by: "severity-resolver-v1" }] : []),
      ],
      classificationHistory: [
        {
          stage: "RULES",
          source: "RULES",
          sensitivity: stage1.sensitivity,
          severity: stage1.severity,
          confidence: null,
          version: RULE_VERSION,
          at: archivedAt,
        },
      ],
      payload: stage1.payload,
      redactions: [...stage1.redactions],
      payloadSha256: createHash("sha256").update(JSON.stringify(original)).digest("hex"),
      mentionedEntityIds: [],
      pendingAiScan: stage1.needsStage2,
      replay: { count: 0, lastReplayedAt: null, lastJobId: null },
      expireAt: expireAt(archivedAt, tier, retention),
    };

    const archiveOnce = (): Promise<boolean> =>
      this.inTransaction(async (session) => {
        if (!(await this.deps.archive.insert(session, tier, doc))) return false;
        if (!stage1.terminal) {
          await this.deps.outbox.enqueue(
            session,
            finalNow ? classificationFinalized(this.deps.version, doc) : scanRequested(this.deps.version, doc),
            archivedAt,
          );
        }
        return true;
      });
    // A concurrent delivery of the same event won the unique index: the aborted transaction wrote nothing (NFR-02).
    const inserted = await archiveOnce().catch((error: unknown) => {
      if (isDuplicateKey(error)) return false;
      throw error;
    });
    if (!inserted) return "duplicate";
    this.deps.logger.info(
      {
        eventId: doc.eventId,
        eventType: doc.eventType,
        tier,
        sensitivity: doc.classification.sensitivity,
        finalSeverity: doc.classification.final_severity,
        status: doc.status,
        redactions: doc.redactions.length,
      },
      "event.archived",
    );
    return "archived";
  }

  private async inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.deps.client.withSession((session) => session.withTransaction(() => work(session)));
  }
}
