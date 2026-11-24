// Envelopes events publishes through its Mongo outbox (§6.4, §6.7): classification.* on aegispulse.enrichment,
// ops.dead_letter.recorded / ops.audit.dead_letter_resolved on aegispulse.intelligence.
// They carry ids, the classification and entity mentions only — never payload bodies. Their own archive copy is
// terminal (rules-v1 loop prevention), so they never trigger another classification event.
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import { uuidv7 } from "@aegispulse/ts-platform/ids";
import type { OutboxMessage } from "@aegispulse/ts-platform/outbox";
import type { ArchivedEvent } from "../db/archive.repository.js";
import type { DeadLetterDoc } from "../db/dead-letter.repository.js";
import type { ResolveAction } from "../domain/dead-letter.js";

/** §6.4 producer `aegispulse-events@{git sha}`; non-image runs use the all-zero sha. */
export function producer(version: string): string {
  return `aegispulse-events@${/^[0-9a-f]{7,40}$/.test(version) ? version : "0000000"}`;
}

function envelope(
  version: string,
  cause: ArchivedEvent,
  eventType: string,
  payload: Record<string, unknown>,
): OutboxMessage {
  const eventId = uuidv7();
  const now = new Date().toISOString();
  const env = {
    eventId,
    correlationId: cause.correlationId,
    causationId: cause.eventId,
    tenantId: cause.tenantId,
    schemaVersion: "1.0.0",
    eventType,
    source: "service:events",
    producer: producer(version),
    occurredAt: now,
    ingestedAt: now,
    idempotencyKey: `${eventType}:${cause.eventId}:${String(cause.classification.revision)}`,
    classification: { sensitivity: "INTERNAL", status: "INGESTED", classification_source: "PRODUCER" },
    payload,
  } as CanonicalEnvelope;
  return { exchange: "aegispulse.enrichment", routingKey: eventType, envelope: env };
}

/** FR-CLS-02: classification.finalized for an archived event. */
export function classificationFinalized(version: string, e: ArchivedEvent): OutboxMessage {
  const c = e.classification;
  const mentioned = e.payload["mentionedEntities"];
  return envelope(version, e, "classification.finalized", {
    eventId: e.eventId,
    eventType: e.eventType,
    sensitivity: c.sensitivity,
    categories: c.categories,
    publisher_stated_severity: c.publisher_stated_severity,
    algorithm_severity: c.algorithm_severity,
    final_severity: c.final_severity,
    source: c.classification_source,
    mentionedEntities: Array.isArray(mentioned)
      ? mentioned.filter((m): m is string => typeof m === "string" && m !== "")
      : [],
    revision: c.revision,
  });
}

/** FR-CLS-03: Stage 2 request (recorded now; the events.classification.q consumer + scanner arrive in Phase 12). */
export function scanRequested(version: string, e: ArchivedEvent): OutboxMessage {
  return envelope(version, e, "classification.scan.requested", {
    eventId: e.eventId,
    revision: e.classification.revision,
  });
}

/** FR-CLS-07: classification.overridden (Cases records the audit entry, FR-AUD-02). Values only, never payloads. */
export function classificationOverridden(
  version: string,
  e: ArchivedEvent,
  o: {
    before: { sensitivity: string; final_severity: string };
    after: { sensitivity: string; final_severity: string };
    actorId: string;
    justification: string;
  },
): OutboxMessage {
  return envelope(version, e, "classification.overridden", {
    eventId: e.eventId,
    before: o.before,
    after: o.after,
    actorId: o.actorId,
    justification: o.justification,
  });
}

const CORRELATION = /^corr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** ops.* envelopes on aegispulse.intelligence (§6.7): operational ids + actor, never message bodies. */
function opsEnvelope(
  version: string,
  d: DeadLetterDoc,
  eventType: string,
  idempotencyKey: string,
  tenantId: string | null,
  payload: Record<string, unknown>,
): OutboxMessage {
  const now = new Date().toISOString();
  const original = d.envelope?.["correlationId"];
  const env = {
    eventId: uuidv7(),
    // The failed message's correlation chain when it had a valid one; poison gets a fresh chain.
    correlationId: typeof original === "string" && CORRELATION.test(original) ? original : `corr-${uuidv7()}`,
    causationId: d.eventId,
    tenantId,
    schemaVersion: "1.0.0",
    eventType,
    source: "service:events",
    producer: producer(version),
    occurredAt: now,
    ingestedAt: now,
    idempotencyKey,
    classification: { sensitivity: "INTERNAL", status: "INGESTED", classification_source: "PRODUCER" },
    payload,
  } as CanonicalEnvelope;
  return { exchange: "aegispulse.intelligence", routingKey: eventType, envelope: env };
}

/** FR-MSG-02: ops.dead_letter.recorded when a dead letter opens a registry record (alerting, intel facts). */
export function deadLetterRecorded(version: string, d: DeadLetterDoc): OutboxMessage {
  return opsEnvelope(
    version,
    d,
    "ops.dead_letter.recorded",
    `ops.dead_letter.recorded:${d._id.toHexString()}`,
    d.tenantId,
    {
      deadLetterId: d._id.toHexString(),
      queue: d.queue,
      originalEventId: d.eventId,
      routingKey: d.routingKey,
      errorCode: d.errorCode,
      retryCount: d.retryCount,
    },
  );
}

/**
 * FR-MSG-03 / FR-AUD-02: ops.audit.dead_letter_resolved (replay or discard) → cases audit chain. A dead letter
 * without a tenant (platform traffic or unreadable poison) is audited under the reserved platform tenant.
 */
export function deadLetterResolved(
  version: string,
  d: DeadLetterDoc,
  action: ResolveAction,
  actorId: string,
  platformTenantId: string,
): OutboxMessage {
  return opsEnvelope(
    version,
    d,
    "ops.audit.dead_letter_resolved",
    `ops.audit.dead_letter_resolved:${d._id.toHexString()}`,
    d.tenantId ?? platformTenantId,
    {
      deadLetterId: d._id.toHexString(),
      queue: d.queue,
      action,
      actorId,
      originalEventId: d.eventId,
      reason: d.reason,
    },
  );
}
