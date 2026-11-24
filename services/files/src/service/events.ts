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
  sensitivity: "INTERNAL" | "CONFIDENTIAL" = "INTERNAL",
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
    classification: { sensitivity, status: "INGESTED", classification_source: "PRODUCER" },
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

/** doc.file.ready (FR-FILE-05) on aegispulse.enrichment → doc.extraction.q. */
export function docFileReady(version: string, file: FileRecord): OutboxMessage {
  return envelope(
    version,
    file,
    "doc.file.ready",
    `doc.file.ready:${file.id}`,
    {
      fileId: file.id,
      storageKey: file.storageKey,
      sha256: file.sha256,
      contentType: file.contentType,
      purpose: file.purpose,
    },
    "aegispulse.enrichment",
  );
}

/** notification.requested N-03 "File {fileId} quarantined ({reason}) for tenant {tenantSlug}." (FR-NOTIF-01). */
export function fileQuarantinedNotice(
  version: string,
  file: FileRecord,
  reason: string,
  tenantSlug: string,
): OutboxMessage {
  return envelope(
    version,
    file,
    "notification.requested",
    `notification.requested:N-03:${file.id}`,
    {
      templateId: "N-03",
      severity: reason.startsWith("MALWARE") ? "HIGH" : "MEDIUM",
      notificationKey: `N-03:${file.id}`,
      vars: { fileId: file.id, reason: reason.slice(0, 200), tenantSlug },
    },
    "aegispulse.enrichment",
  );
}

export interface ExtractionResultEvent {
  readonly extractorVersion: string;
  readonly status: "COMPLETED" | "REVIEW_REQUIRED";
  readonly confidence: number;
  readonly eventTypeGuess: string;
  readonly mentionedEntities: readonly string[];
  readonly redFlags: readonly unknown[];
  readonly textExcerpt?: string | undefined;
  readonly artifactKeys: Readonly<Record<string, string>>;
}

/**
 * doc.extraction.completed | doc.extraction.review_required (FR-FILE-06) on aegispulse.enrichment, published by files
 * on behalf of doc-extraction (§6.7). CONFIDENTIAL; base severity comes from red flags at archive time (§1.4.3).
 */
export function docExtraction(version: string, file: FileRecord, r: ExtractionResultEvent): OutboxMessage {
  const eventType = r.status === "COMPLETED" ? "doc.extraction.completed" : "doc.extraction.review_required";
  return envelope(
    version,
    file,
    eventType,
    `${eventType}:${file.id}:${r.extractorVersion}`,
    {
      fileId: file.id,
      extractorVersion: r.extractorVersion,
      eventTypeGuess: r.eventTypeGuess,
      mentionedEntities: r.mentionedEntities,
      redFlags: r.redFlags,
      confidence: r.confidence,
      ...(r.textExcerpt === undefined ? {} : { textExcerpt: r.textExcerpt.slice(0, 2000) }),
      artifactKeys: r.artifactKeys,
    },
    "aegispulse.enrichment",
    "CONFIDENTIAL",
  );
}

/** ops.audit.quarantine_download (FR-FILE-08, FR-AUD-02) on aegispulse.intelligence. */
export function quarantineDownload(version: string, file: FileRecord, actorId: string): OutboxMessage {
  return envelope(
    version,
    file,
    "ops.audit.quarantine_download",
    `ops.audit.quarantine_download:${file.id}:${uuidv7()}`,
    { fileId: file.id, actorId },
    "aegispulse.intelligence",
  );
}
