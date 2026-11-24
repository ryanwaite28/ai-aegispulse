// Envelopes events publishes through its Mongo outbox (§6.4, §6.7): classification.* on aegispulse.enrichment.
// They carry ids, the classification and entity mentions only — never payload bodies. Their own archive copy is
// terminal (rules-v1 loop prevention), so they never trigger another classification event.
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import { uuidv7 } from "@aegispulse/ts-platform/ids";
import type { OutboxMessage } from "@aegispulse/ts-platform/outbox";
import type { ArchivedEvent } from "../db/archive.repository.js";

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
