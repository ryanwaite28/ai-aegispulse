// IngestWebhookUseCase (FR-WHK-02..05; spec FR-WHK-01-08 §2 "Ingest"). Steps, in order:
//   source lookup (pre-tenant definer) → tenant status → signature (CURRENT, unexpired PREVIOUS) → skew → Redis nonce
//   → payload schema → raw object PUT (before the transaction) → tenant transaction: delivery row (+ outbox when
//   ACCEPTED). Every rejection increments aegispulse_webhook_rejected_total{source,reason} and logs without the body.
import { createHash, randomUUID } from "node:crypto";
import type { Principal } from "@aegispulse/ts-platform/auth";
import { hasRole } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import { uuidv7 } from "@aegispulse/ts-platform/ids";
import type { Logger } from "@aegispulse/ts-platform/logging";
import { withTenantTransaction, type OutboxRepository, type SqlPool } from "@aegispulse/ts-platform/outbox";
import { getMeter } from "@aegispulse/ts-platform/telemetry";
import { open, type Kek } from "../../domain/crypto.js";
import { buildWebhookEnvelope, idempotencyKey } from "../../domain/envelope-builder.js";
import { marketEventV1 } from "../../domain/market-event.js";
import { parseHeaders, verify, withinSkew, type Candidate } from "../../domain/signature.js";
import type { SecretSlot } from "../../domain/webhook-source.js";
import type { DeliveryRecord, WebhookDeliveryRepository } from "../../db/webhook-deliveries.repository.js";
import { correlationId, producer } from "../events.js";

export const MAX_BODY_BYTES = 1024 * 1024; // NFR-08 / FR-WHK-02
export const NONCE_TTL_SECONDS = 900;

/** Ports the use case needs from infrastructure owned by ingestion. */
export interface NonceStore {
  /** SET key NX EX ttl; false when the key already exists. */
  claim(key: string, ttlSeconds: number): Promise<boolean>;
}
export interface RawStore {
  put(key: string, body: Buffer, sha256: string): Promise<void>;
}
export interface TenantStatusPort {
  isActive(tenantId: string): Promise<boolean>;
}

export interface IngestInput {
  readonly sourceKey: string;
  readonly headers: {
    "X-Aegis-Signature"?: string | undefined;
    "X-Aegis-Timestamp"?: string | undefined;
    "X-Aegis-Delivery-Id"?: string | undefined;
  };
  readonly rawBodyBase64: string;
  readonly receivedAt: string;
  readonly clientIp: string;
}

export interface IngestResult {
  readonly deliveryId: string;
  readonly eventId: string | null;
  readonly duplicate: boolean;
}

export interface IngestDeps {
  readonly pool: SqlPool;
  readonly deliveries: WebhookDeliveryRepository;
  readonly outbox: OutboxRepository;
  readonly nonces: NonceStore;
  readonly raw: RawStore;
  readonly tenants: TenantStatusPort;
  readonly kek: Kek;
  readonly version: string;
  readonly logger: Logger;
  readonly now?: () => number;
}

type Reason = "source" | "tenant" | "signature" | "skew" | "replay" | "schema" | "size";

const rejected = getMeter().createCounter("aegispulse_webhook_rejected_total", {
  description: "Webhook deliveries rejected, by source key and reason (FR-WHK-03)",
});

const ERRORS: Readonly<Record<Reason, () => DomainError>> = {
  source: () => new DomainError("WEBHOOK_SOURCE_NOT_FOUND", "unknown webhook source"),
  tenant: () => new DomainError("TENANT_SUSPENDED", "tenant is suspended or deactivated"),
  signature: () => new DomainError("WEBHOOK_SIGNATURE_INVALID", "signature invalid"),
  skew: () => new DomainError("WEBHOOK_TIMESTAMP_SKEW", "timestamp outside the allowed window"),
  replay: () => new DomainError("WEBHOOK_REPLAY_DETECTED", "this delivery id was already received"),
  schema: () => new DomainError("VALIDATION_ERROR", "payload failed validation"),
  size: () => new DomainError("PAYLOAD_TOO_LARGE", "body exceeds 1 MiB"),
};

export class IngestWebhookUseCase {
  private readonly now: () => number;

  constructor(private readonly deps: IngestDeps) {
    this.now = deps.now ?? Date.now;
  }

  async execute(principal: Principal, input: IngestInput): Promise<IngestResult> {
    if (principal.kind !== "service") throw new DomainError("FORBIDDEN", "webhook deliveries come from the gateway");
    const reject = (reason: Reason, detail: Record<string, unknown> = {}): never => {
      rejected.add(1, { source: input.sourceKey, reason });
      this.deps.logger.info(
        { sourceKey: input.sourceKey, reason, clientIp: input.clientIp, ...detail },
        "webhook.rejected",
      );
      throw ERRORS[reason]();
    };

    const raw = Buffer.from(input.rawBodyBase64, "base64");
    if (raw.length > MAX_BODY_BYTES) reject("size");

    // 1. source (pre-tenant lookup, ADR-0016)
    const source = await this.deps.deliveries.sourceForDelivery(this.deps.pool, input.sourceKey);
    if (source === undefined || source.status !== "ACTIVE") return reject("source");
    // 2. tenant status
    if (!(await this.deps.tenants.isActive(source.tenantId))) reject("tenant", { tenantId: source.tenantId });
    // 3. signature: CURRENT and unexpired PREVIOUS
    const parsed = parseHeaders({
      signature: input.headers["X-Aegis-Signature"],
      timestamp: input.headers["X-Aegis-Timestamp"],
      deliveryId: input.headers["X-Aegis-Delivery-Id"],
    });
    if (!parsed.ok) return reject("signature", { tenantId: source.tenantId });
    const now = this.now();
    const candidates: Candidate<SecretSlot>[] = source.secrets
      .filter((s) => s.slot === "CURRENT" || (s.expiresAt !== null && s.expiresAt.getTime() > now))
      .sort((a, b) => (a.slot === "CURRENT" ? -1 : b.slot === "CURRENT" ? 1 : 0))
      .map((s) => ({ slot: s.slot, secret: open(s.sealed, this.deps.kek) }));
    const slot = verify(parsed.headers, raw, candidates);
    if (slot === undefined) return reject("signature", { tenantId: source.tenantId });
    // 4. skew (after the signature, so it can't be probed unsigned)
    if (!withinSkew(parsed.headers.timestamp, now)) reject("skew", { tenantId: source.tenantId });
    // 5. replay guard
    const nonce = `whk:nonce:${source.sourceId}:${parsed.headers.deliveryId}`;
    if (!(await this.deps.nonces.claim(nonce, NONCE_TTL_SECONDS))) reject("replay", { tenantId: source.tenantId });
    // 6. payload schema (only after the signature)
    let json: unknown;
    try {
      json = JSON.parse(raw.toString("utf8"));
    } catch {
      return reject("schema", { tenantId: source.tenantId });
    }
    const event = marketEventV1.safeParse(json);
    if (!event.success) return reject("schema", { tenantId: source.tenantId });

    // 7. raw body to object storage, before the transaction (orphans are swept, FR-WHK-08)
    const deliveryUuid = randomUUID();
    const day = new Date(now).toISOString().slice(0, 10).split("-");
    const rawStorageKey = `raw/webhooks/${source.tenantId}/${day[0] ?? ""}/${day[1] ?? ""}/${day[2] ?? ""}/${deliveryUuid}.json`;
    const rawSha256 = createHash("sha256").update(raw).digest("hex");
    await this.deps.raw.put(rawStorageKey, raw, rawSha256);

    // 8. one tenant transaction: delivery row + outbox (ACCEPTED only)
    const eventId = uuidv7(now);
    const corr = correlationId(eventId);
    const key = idempotencyKey(source.sourceKey, event.data);
    const outcome = await withTenantTransaction(this.deps.pool, source.tenantId, async (tx) => {
      const stored = await this.deps.deliveries.insert(tx, {
        id: deliveryUuid,
        tenantId: source.tenantId,
        sourceId: source.sourceId,
        deliveryId: parsed.headers.deliveryId,
        idempotencyKey: key,
        eventId,
        externalId: event.data.externalId,
        category: event.data.category,
        rawStorageKey,
        rawSha256,
        signatureSlot: slot,
        receivedAt: input.receivedAt,
        correlationId: corr,
      });
      if (stored === "ACCEPTED") {
        const envelope = buildWebhookEnvelope({
          eventId,
          correlationId: corr,
          tenantId: source.tenantId,
          sourceKey: source.sourceKey,
          deliveryUuid,
          rawStorageKey,
          rawSha256,
          receivedAt: input.receivedAt,
          producer: producer(this.deps.version),
          event: event.data,
        });
        await this.deps.outbox.enqueue(tx, {
          exchange: "aegispulse.ingress",
          routingKey: envelope.eventType,
          envelope,
        });
      }
      return stored;
    });
    this.deps.logger.info(
      {
        tenantId: source.tenantId,
        sourceKey: source.sourceKey,
        deliveryId: deliveryUuid,
        outcome,
        slot,
        eventId: outcome === "ACCEPTED" ? eventId : undefined,
      },
      "webhook.accepted",
    );
    return {
      deliveryId: deliveryUuid,
      eventId: outcome === "ACCEPTED" ? eventId : null,
      duplicate: outcome === "DUPLICATE",
    };
  }

  /** FR-WHK-07 delivery listing: TENANT_ADMIN, metadata only (the raw body is never returned). */
  async listDeliveries(
    principal: Principal,
    q: {
      sourceId: string;
      outcome?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
    },
  ): Promise<{ items: DeliveryRecord[]; nextCursor: string | undefined }> {
    if (principal.kind !== "user" || !hasRole(principal, "TENANT_ADMIN")) {
      throw new DomainError("FORBIDDEN", "TENANT_ADMIN role required");
    }
    const limit = q.limit ?? 25;
    const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
    return withTenantTransaction(this.deps.pool, principal.tenantId, async (tx) => {
      if (!(await this.deps.deliveries.sourceVisible(tx, q.sourceId))) {
        throw new DomainError("NOT_FOUND", "webhook source not found");
      }
      const rows = await this.deps.deliveries.list(tx, q, after, limit + 1);
      if (rows.length <= limit) return { items: rows, nextCursor: undefined };
      const page = rows.slice(0, limit);
      const last = page[page.length - 1] as DeliveryRecord;
      return { items: page, nextCursor: Buffer.from(`${last.receivedAt}|${last.id}`).toString("base64url") };
    });
  }
}

function decodeCursor(cursor: string): { receivedAt: string; id: string } {
  const [receivedAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (receivedAt === undefined || id === undefined || Number.isNaN(Date.parse(receivedAt))) {
    throw new DomainError("VALIDATION_ERROR", "request failed validation", {
      details: [{ field: "cursor", message: "invalid cursor" }],
    });
  }
  return { receivedAt, id };
}
