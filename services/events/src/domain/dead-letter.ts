// Dead-letter registry domain (FR-MSG-02/03, §7.6 dead_letters). Pure: turns a dead-lettered delivery (any bytes,
// poison included) into the record the registry stores, and decides what a replay republishes.
import { createHash } from "node:crypto";
import { maskValue, type Redaction } from "./classification/rules-v1.js";

export type DeadLetterStatus = "OPEN" | "REPLAYED" | "DISCARDED";
export type ResolveAction = "REPLAYED" | "DISCARDED";

/** §6.4 headers the consumer kits set on the DLQ copy only; a replay starts without them (FR-MSG-03). */
export const DLQ_ONLY_HEADERS = [
  "x-aegis-error-code",
  "x-aegis-original-queue",
  "x-aegis-error-message",
  "x-aegis-error-stack-hash",
] as const;
/** Broker-managed history; a replay starts a fresh one. */
const BROKER_HEADERS = ["x-death", "x-first-death-exchange", "x-first-death-queue", "x-first-death-reason"];
const RETRY_COUNT = "x-retry-count";

/** Stored text of a body that is not a JSON object is bounded (the broker caps messages at 256 KiB anyway). */
export const MAX_RAW_BODY_CHARS = 262_144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeadLetterDelivery {
  readonly content: Buffer;
  readonly headers: Readonly<Record<string, unknown>>;
  /** AMQP messageId (informational; the record's eventId comes from the envelope only). */
  readonly messageId: string | undefined;
  /** The DLQ copy's routing key: the original queue name (kits publish to aegispulse.dlx with routingKey = queue). */
  readonly routingKey: string;
}

/** What the registry records for one dead-lettered delivery (the failure facts; status fields are the store's). */
export interface DeadLetterFacts {
  readonly tenantId: string | null;
  readonly eventId: string | null;
  readonly eventType: string | null;
  /** The original queue: the DLQ copy's routing key (kits publish to aegispulse.dlx with routingKey = queue). */
  readonly queue: string;
  /** x-aegis-original-queue named a different queue than the routing key: suspect, never replayed (L1). */
  readonly queueHeaderMismatch: boolean;
  /** Tenant + message identity; one OPEN record per (queue, identityKey). */
  readonly identityKey: string;
  /** The event's routing key: producers publish with routingKey = eventType (§6.7), so it is the eventType. */
  readonly routingKey: string | null;
  /** The original envelope when the body is a JSON object, else null (see rawBody). */
  readonly envelope: Record<string, unknown> | null;
  /** Body text when it is not a JSON object (poison), bounded; null otherwise. */
  readonly rawBody: string | null;
  readonly bodySha256: string;
  readonly headers: Record<string, unknown>;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly stackHash: string | null;
  readonly retryCount: number;
}

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return undefined;
}

/** AMQP header values → JSON-safe values for Mongo and the API (Buffers to text, dates to ISO, bigint to string). */
export function plainHeaderValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((v) => plainHeaderValue(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = plainHeaderValue(v, depth + 1);
    return out;
  }
  return value;
}

function retryCount(headers: Readonly<Record<string, unknown>>): number {
  const raw = headers[RETRY_COUNT];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function parseObject(content: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(content.toString("utf8")) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** FR-MSG-02: the facts of one dead-lettered delivery. Never throws: every body is recordable. */
export function deadLetterFacts(delivery: DeadLetterDelivery): DeadLetterFacts {
  const headers: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(delivery.headers)) headers[k] = plainHeaderValue(v);
  const envelope = parseObject(delivery.content);
  const envEventId = text(envelope?.["eventId"]);
  // Only the envelope's own id counts: the broker library stamps a random messageId on copies of poison.
  const eventId = envEventId !== undefined && UUID.test(envEventId) ? envEventId : null;
  const envTenant = text(envelope?.["tenantId"]);
  const headerTenant = text(headers["x-aegis-tenant"]);
  const tenantId =
    envTenant !== undefined && UUID.test(envTenant)
      ? envTenant
      : headerTenant !== undefined && UUID.test(headerTenant)
        ? headerTenant
        : null;
  const eventType = text(envelope?.["eventType"]) ?? null;
  const bodyText = envelope === null ? delivery.content.toString("utf8") : null;
  const bodySha256 = createHash("sha256").update(delivery.content).digest("hex");
  const originalQueue = text(headers["x-aegis-original-queue"]);
  return {
    tenantId,
    eventId,
    eventType,
    queue: delivery.routingKey,
    queueHeaderMismatch: originalQueue !== undefined && originalQueue !== delivery.routingKey,
    identityKey: deadLetterIdentity(tenantId, eventId, bodySha256),
    routingKey: eventType,
    envelope,
    rawBody: bodyText === null ? null : bodyText.slice(0, MAX_RAW_BODY_CHARS),
    bodySha256,
    headers,
    errorCode: text(headers["x-aegis-error-code"]) ?? "UNKNOWN",
    errorMessage: (text(headers["x-aegis-error-message"]) ?? "").slice(0, 500),
    stackHash: text(headers["x-aegis-error-stack-hash"]) ?? null,
    retryCount: retryCount(headers),
  };
}

/** Headers a replay republishes with: the original's, minus DLQ-only and broker headers, x-retry-count = 0. */
export function replayHeaders(stored: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const drop = new Set<string>([...DLQ_ONLY_HEADERS, ...BROKER_HEADERS]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored)) if (!drop.has(k)) out[k] = v;
  out[RETRY_COUNT] = 0;
  return out;
}

/** The bytes a replay republishes: the stored envelope, or the stored raw body for poison. */
export function replayBody(record: { envelope: Record<string, unknown> | null; rawBody: string | null }): Buffer {
  return record.envelope !== null
    ? Buffer.from(JSON.stringify(record.envelope), "utf8")
    : Buffer.from(record.rawBody ?? "", "utf8");
}

/**
 * A repeated resolve request is a no-op when it matches what was done (same action, actor and reason); anything
 * else on a resolved record is DEAD_LETTER_ALREADY_RESOLVED.
 */
export function isSameResolution(
  record: { status: DeadLetterStatus; resolvedBy: string | null; reason: string | null },
  action: ResolveAction,
  actor: string,
  reason: string | null,
): boolean {
  return record.status === action && record.resolvedBy === actor && record.reason === reason;
}

/**
 * The registry's message identity: tenant + eventId (or the body hash without one). The tenant is part of it, so a
 * dead letter claiming another tenant can never overwrite an existing tenant's OPEN record (M2).
 */
export function deadLetterIdentity(tenantId: string | null, eventId: string | null, bodySha256: string): string {
  return `${tenantId ?? "-"}|${eventId ?? `sha256:${bodySha256}`}`;
}

/** Resolved records are kept this long after resolution, then expire (TTL on expireAt, §7.6). OPEN never expires. */
export const RESOLVED_RETENTION_DAYS = 30;

export function resolvedExpireAt(resolvedAt: Date): Date {
  return new Date(resolvedAt.getTime() + RESOLVED_RETENTION_DAYS * 86_400_000);
}

/** Why a record cannot be replayed (null = replayable): suspect queue attribution, or poison bytes not intact. */
export function replayRefusal(record: {
  queueHeaderMismatch?: boolean | undefined;
  envelope: Record<string, unknown> | null;
  rawBody: string | null;
  bodySha256: string;
}): string | null {
  if (record.queueHeaderMismatch === true) return "the queue header disagrees with the routing key (suspect record)";
  if (record.envelope === null) {
    const replayed = createHash("sha256").update(replayBody(record)).digest("hex");
    if (replayed !== record.bodySha256) return "the stored poison body is not byte-identical to the original";
  }
  return null;
}

/**
 * The API view of stored message content (§1.4.2): rules-v1 masks over the envelope, the raw body, string headers and
 * the error message. The stored bytes stay unmasked only so a replay re-delivers the original message.
 */
export function maskedContent(record: {
  envelope: Record<string, unknown> | null;
  rawBody: string | null;
  headers: Record<string, unknown>;
  errorMessage: string;
}): {
  envelope: Record<string, unknown> | null;
  rawBody: string | null;
  headers: Record<string, unknown>;
  errorMessage: string;
  redactions: Redaction[];
} {
  const envelope = record.envelope === null ? null : maskValue(record.envelope, "envelope");
  const rawBody = record.rawBody === null ? null : maskValue(record.rawBody, "rawBody");
  const headers = maskValue(record.headers, "headers");
  const errorMessage = maskValue(record.errorMessage, "errorMessage");
  return {
    envelope: (envelope?.value ?? null) as Record<string, unknown> | null,
    rawBody: (rawBody?.value ?? null) as string | null,
    headers: headers.value as Record<string, unknown>,
    errorMessage: errorMessage.value as string,
    redactions: [
      ...(envelope?.redactions ?? []),
      ...(rawBody?.redactions ?? []),
      ...headers.redactions,
      ...errorMessage.redactions,
    ],
  };
}
