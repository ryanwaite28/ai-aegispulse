// Shared test fixtures (unit + integration). Values satisfy the canonical envelope schema (PROJECT.md §6.4).
import { randomUUID } from "node:crypto";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";

export function sampleEnvelope(overrides: Record<string, unknown> = {}): CanonicalEnvelope {
  return {
    eventId: randomUUID(),
    correlationId: `corr-${randomUUID()}`,
    causationId: null,
    tenantId: randomUUID(),
    schemaVersion: "1.1.0",
    eventType: "file.uploaded",
    source: "api:/v1/files",
    producer: "aegispulse-files@abc1234",
    occurredAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    idempotencyKey: `files:${randomUUID()}`,
    classification: { sensitivity: "INTERNAL", status: "INGESTED" },
    payload: { fileId: randomUUID() },
    ...overrides,
  } as CanonicalEnvelope;
}
