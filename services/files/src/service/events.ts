// Envelopes files publishes through its outbox (§6.4, §6.7): file.uploaded on aegispulse.ingress, file.status.changed
// on aegispulse.enrichment. Payloads carry ids, keys and checksums only (ADR-0009), never contents or filenames.
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import type { ExchangeName } from "@aegispulse/contracts/generated/ts/topology.ts";
import { uuidv7 } from "@aegispulse/ts-platform/ids";
import type { OutboxMessage } from "@aegispulse/ts-platform/outbox";
import type { FileStatus } from "../domain/file.js";
import type { FileRecord } from "../db/files.repository.js";

/** §6.4 producer `aegispulse-files@{git sha}`; non-image runs use the all-zero sha. */
export function producer(version: string): string {
  return `aegispulse-files@${/^[0-9a-f]{7,40}$/.test(version) ? version : "0000000"}`;
}

function envelope(
  version: string,
  file: FileRecord,
  eventType: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  exchange: ExchangeName,
): OutboxMessage {
  const eventId = uuidv7();
  const now = new Date().toISOString();
  const env = {
    eventId,
    correlationId: file.correlationId,
    causationId: null,
    tenantId: file.tenantId,
    schemaVersion: "1.0.0",
    eventType,
    source: "service:files",
    producer: producer(version),
    occurredAt: now,
    ingestedAt: now,
    idempotencyKey,
    classification: { sensitivity: "INTERNAL", status: "INGESTED", classification_source: "PRODUCER" },
    payload,
  } as CanonicalEnvelope;
  return { exchange, routingKey: eventType, envelope: env };
}

/** file.uploaded (FR-FILE-04) → files.validation.q. */
export function fileUploaded(version: string, file: FileRecord): OutboxMessage {
  return envelope(
    version,
    file,
    "file.uploaded",
    `file.uploaded:${file.id}`,
    {
      fileId: file.id,
      storageKey: file.storageKey,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      purpose: file.purpose,
      sourceType: file.sourceType,
    },
    "aegispulse.ingress",
  );
}

/** file.status.changed on every transition (FR-FILE-04/05/10; SSE + intel facts). */
export function fileStatusChanged(
  version: string,
  file: FileRecord,
  from: FileStatus | null,
  reason: string | null,
): OutboxMessage {
  return envelope(
    version,
    file,
    "file.status.changed",
    `file.status.changed:${file.id}:${String(file.version)}`,
    { fileId: file.id, from, to: file.status, reason },
    "aegispulse.enrichment",
  );
}
