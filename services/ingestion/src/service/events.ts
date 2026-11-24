// Envelopes ingestion publishes through its outbox (§6.4, §6.7). Producers set sensitivity + INGESTED; the events
// service is the classification authority. Payloads carry ids and names only, never secrets or bodies.
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import type { ExchangeName } from "@aegispulse/contracts/generated/ts/topology.ts";
import { uuidv7 } from "@aegispulse/ts-platform/ids";
import { getContext } from "@aegispulse/ts-platform/logging";
import type { OutboxMessage } from "@aegispulse/ts-platform/outbox";

/** §6.4 producer `aegispulse-ingestion@{git sha}`; non-image runs use the all-zero sha. */
export function producer(version: string): string {
  return `aegispulse-ingestion@${/^[0-9a-f]{7,40}$/.test(version) ? version : "0000000"}`;
}

export function correlationId(eventId: string): string {
  const current = getContext().correlationId;
  return current !== undefined && current.startsWith("corr-") ? current : `corr-${eventId}`;
}

/** ops.audit.source_trust_changed (FR-WHK-07, FR-AUD-02) on aegispulse.intelligence. */
export function sourceTrustChanged(args: {
  version: string;
  tenantId: string;
  sourceId: string;
  sourceKey: string;
  before: string;
  after: string;
  actorId: string;
}): OutboxMessage {
  const eventId = uuidv7();
  const now = new Date().toISOString();
  const envelope = {
    eventId,
    correlationId: correlationId(eventId),
    causationId: null,
    tenantId: args.tenantId,
    schemaVersion: "1.0.0",
    eventType: "ops.audit.source_trust_changed",
    source: "service:ingestion",
    producer: producer(args.version),
    occurredAt: now,
    ingestedAt: now,
    idempotencyKey: `ops.audit.source_trust_changed:${eventId}`,
    classification: { sensitivity: "INTERNAL", status: "INGESTED", classification_source: "PRODUCER" },
    payload: {
      sourceId: args.sourceId,
      sourceKey: args.sourceKey,
      before: args.before,
      after: args.after,
      actorId: args.actorId,
    },
  } as CanonicalEnvelope;
  const exchange: ExchangeName = "aegispulse.intelligence";
  return { exchange, routingKey: envelope.eventType, envelope };
}
