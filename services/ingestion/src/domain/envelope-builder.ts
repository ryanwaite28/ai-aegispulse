// Canonical envelope for an accepted webhook (FR-WHK-05, §6.4). Pure: ids and clock are passed in.
// The payload mirrors AEGIS_MARKET_EVENT_V1 *without* the raw body (pointers only, ADR-0009); the publisher's
// severity seeds classification.publisher_stated_severity; the events service is the classification authority.
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import { EVENT_TYPE, type MarketEventV1 } from "./market-event.js";

export interface WebhookEnvelopeInput {
  readonly eventId: string;
  readonly correlationId: string;
  readonly tenantId: string;
  readonly sourceKey: string;
  readonly deliveryUuid: string;
  readonly rawStorageKey: string;
  readonly rawSha256: string;
  readonly receivedAt: string;
  readonly producer: string;
  readonly event: MarketEventV1;
}

export function idempotencyKey(sourceKey: string, event: MarketEventV1): string {
  return `${sourceKey}:${event.externalId}:v${String(event.version)}`;
}

export function buildWebhookEnvelope(i: WebhookEnvelopeInput): CanonicalEnvelope {
  const e = i.event;
  const payload: Record<string, unknown> = {
    externalId: e.externalId,
    category: e.category,
    title: e.title,
    publishedAt: e.publishedAt,
    version: e.version,
    deliveryId: i.deliveryUuid,
    rawStorageKey: i.rawStorageKey,
    sha256: i.rawSha256,
  };
  if (e.summary !== undefined) payload["summary"] = e.summary;
  if (e.url !== undefined) payload["url"] = e.url;
  if (e.mentionedEntities !== undefined) payload["mentionedEntities"] = e.mentionedEntities;
  if (e.tickers !== undefined) payload["tickers"] = e.tickers;
  const classification: CanonicalEnvelope["classification"] = {
    sensitivity: "UNCLASSIFIED",
    status: "INGESTED",
    classification_source: "PRODUCER",
    ...(e.severity === undefined ? {} : { publisher_stated_severity: e.severity }),
  };
  return {
    eventId: i.eventId,
    correlationId: i.correlationId,
    causationId: null,
    tenantId: i.tenantId,
    schemaVersion: "1.0.0",
    eventType: EVENT_TYPE[e.category],
    source: `webhook:${i.sourceKey}`,
    producer: i.producer,
    occurredAt: e.publishedAt,
    ingestedAt: i.receivedAt,
    idempotencyKey: idempotencyKey(i.sourceKey, e),
    classification,
    payload,
  } as CanonicalEnvelope;
}
