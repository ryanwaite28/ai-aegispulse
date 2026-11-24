// Webhook source management (FR-WHK-01/07): TENANT_ADMIN of its own tenant. Secrets are sealed (envelope encryption)
// and returned only once; trust-level changes are audited through the outbox.
import type { Principal } from "@aegispulse/ts-platform/auth";
import { hasRole } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { IdempotencyRepository } from "@aegispulse/ts-platform/idempotency";
import { sha256Hex } from "@aegispulse/ts-platform/idempotency";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { OutboxRepository } from "@aegispulse/ts-platform/outbox";
import { withTenantTransaction, type SqlPool } from "@aegispulse/ts-platform/outbox";
import { newSigningSecret, seal, type Kek } from "../domain/crypto.js";
import {
  normalizeHosts,
  PREVIOUS_SECRET_TTL_MS,
  type SourceStatus,
  type TrustLevel,
  type WebhookSource,
} from "../domain/webhook-source.js";
import type { WebhookSourceRepository } from "../db/webhook-sources.repository.js";
import { sourceTrustChanged } from "./events.js";

export interface CreateSourceInput {
  readonly sourceKey: string;
  readonly displayName: string;
  readonly trustLevel?: TrustLevel | undefined;
  readonly payloadProfile?: "AEGIS_MARKET_EVENT_V1" | undefined;
  readonly allowedAttachmentHosts?: readonly string[] | undefined;
}

export interface UpdateSourceInput {
  readonly sourceId: string;
  readonly displayName?: string | undefined;
  readonly status?: SourceStatus | undefined;
  readonly trustLevel?: TrustLevel | undefined;
  readonly allowedAttachmentHosts?: readonly string[] | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}

export interface WebhookSourceServiceDeps {
  readonly pool: SqlPool;
  readonly sources: WebhookSourceRepository;
  readonly outbox: OutboxRepository;
  readonly idempotency: IdempotencyRepository;
  readonly kek: Kek;
  readonly version: string;
  readonly logger: Logger;
  readonly now?: () => Date;
}

const DEFAULT_LIMIT = 25;

export class WebhookSourceService {
  private readonly now: () => Date;

  constructor(private readonly deps: WebhookSourceServiceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async create(
    principal: Principal,
    idempotencyKey: string | undefined,
    input: CreateSourceInput,
  ): Promise<WebhookSource & { signingSecret: string }> {
    const { tenantId, actorId } = tenantAdmin(principal);
    const hosts = normalizeHosts(input.allowedAttachmentHosts);
    return withTenantTransaction(this.deps.pool, tenantId, async (tx) => {
      const idem =
        idempotencyKey === undefined
          ? undefined
          : {
              tenantId,
              scope: "createWebhookSource",
              key: idempotencyKey,
              requestSha256: sha256Hex(JSON.stringify(input)),
            };
      if (idem !== undefined && (await this.deps.idempotency.begin(tx, idem)).kind === "replay") {
        // The one-time secret is never stored, so a repeat can't be replayed (same rule as FR-TEN-06).
        throw new DomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "the secret was already issued for this key; rotate to get a new one",
        );
      }
      const source = await this.deps.sources.insert(tx, {
        tenantId,
        sourceKey: input.sourceKey,
        displayName: input.displayName.trim(),
        trustLevel: input.trustLevel ?? "UNTRUSTED",
        allowedAttachmentHosts: hosts,
      });
      const secret = newSigningSecret();
      await this.deps.sources.putSecret(tx, tenantId, source.id, "CURRENT", seal(secret, this.deps.kek), null);
      if (idem !== undefined) await this.deps.idempotency.complete(tx, idem, 201, { id: source.id });
      this.deps.logger.info({ tenantId, sourceId: source.id, actorId }, "webhook_source.created");
      return { ...source, signingSecret: secret };
    });
  }

  async list(
    principal: Principal,
    query: { limit?: number | undefined; cursor?: string | undefined },
  ): Promise<Page<WebhookSource>> {
    const { tenantId } = tenantAdmin(principal);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const after = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    return withTenantTransaction(this.deps.pool, tenantId, async (tx) => {
      const rows = await this.deps.sources.list(tx, after, limit + 1);
      if (rows.length <= limit) return { items: rows, nextCursor: undefined };
      const page = rows.slice(0, limit);
      const last = page[page.length - 1] as WebhookSource;
      return { items: page, nextCursor: encodeCursor(last.createdAt, last.id) };
    });
  }

  async update(
    principal: Principal,
    idempotencyKey: string | undefined,
    input: UpdateSourceInput,
  ): Promise<WebhookSource> {
    const { tenantId, actorId } = tenantAdmin(principal);
    const hosts = input.allowedAttachmentHosts === undefined ? undefined : normalizeHosts(input.allowedAttachmentHosts);
    return withTenantTransaction(this.deps.pool, tenantId, async (tx) => {
      const idem =
        idempotencyKey === undefined
          ? undefined
          : {
              tenantId,
              scope: "updateWebhookSource",
              key: idempotencyKey,
              requestSha256: sha256Hex(JSON.stringify(input)),
            };
      if (idem !== undefined) {
        const decision = await this.deps.idempotency.begin(tx, idem);
        if (decision.kind === "replay") return decision.body as WebhookSource;
      }
      const current = await this.deps.sources.lock(tx, input.sourceId);
      if (current === undefined) throw notFound();
      const updated = await this.deps.sources.update(tx, current.id, {
        displayName: input.displayName?.trim() ?? current.displayName,
        status: input.status ?? current.status,
        trustLevel: input.trustLevel ?? current.trustLevel,
        allowedAttachmentHosts: hosts ?? current.allowedAttachmentHosts,
      });
      if (updated.trustLevel !== current.trustLevel) {
        await this.deps.outbox.enqueue(
          tx,
          sourceTrustChanged({
            version: this.deps.version,
            tenantId,
            sourceId: current.id,
            sourceKey: current.sourceKey,
            before: current.trustLevel,
            after: updated.trustLevel,
            actorId,
          }),
        );
        this.deps.logger.info(
          { tenantId, sourceId: current.id, before: current.trustLevel, after: updated.trustLevel, actorId },
          "webhook_source.trust_changed",
        );
      }
      if (idem !== undefined) await this.deps.idempotency.complete(tx, idem, 200, updated);
      return updated;
    });
  }

  /** FR-WHK-07: new CURRENT; the old one becomes PREVIOUS for 72 h. */
  async rotate(
    principal: Principal,
    idempotencyKey: string | undefined,
    sourceId: string,
  ): Promise<{ sourceId: string; signingSecret: string; previousSecretExpiresAt: string }> {
    const { tenantId, actorId } = tenantAdmin(principal);
    return withTenantTransaction(this.deps.pool, tenantId, async (tx) => {
      const idem =
        idempotencyKey === undefined
          ? undefined
          : { tenantId, scope: "rotateWebhookSecret", key: idempotencyKey, requestSha256: sha256Hex(sourceId) };
      if (idem !== undefined && (await this.deps.idempotency.begin(tx, idem)).kind === "replay") {
        throw new DomainError(
          "IDEMPOTENCY_KEY_REUSED",
          "the secret was already issued for this key; rotate to get a new one",
        );
      }
      const source = await this.deps.sources.lock(tx, sourceId);
      if (source === undefined) throw notFound();
      const expiresAt = new Date(this.now().getTime() + PREVIOUS_SECRET_TTL_MS);
      await this.deps.sources.demoteCurrent(tx, source.id, expiresAt);
      const secret = newSigningSecret();
      await this.deps.sources.putSecret(tx, tenantId, source.id, "CURRENT", seal(secret, this.deps.kek), null);
      if (idem !== undefined) await this.deps.idempotency.complete(tx, idem, 200, { sourceId: source.id });
      this.deps.logger.info({ tenantId, sourceId: source.id, actorId }, "webhook_source.secret_rotated");
      return { sourceId: source.id, signingSecret: secret, previousSecretExpiresAt: expiresAt.toISOString() };
    });
  }

  async remove(principal: Principal, sourceId: string): Promise<void> {
    const { tenantId, actorId } = tenantAdmin(principal);
    await withTenantTransaction(this.deps.pool, tenantId, async (tx) => {
      const source = await this.deps.sources.lock(tx, sourceId);
      if (source === undefined) throw notFound();
      await this.deps.sources.softDelete(tx, source.id);
      this.deps.logger.info({ tenantId, sourceId: source.id, actorId }, "webhook_source.deleted");
    });
  }
}

/** §8.3: these routes are TENANT_ADMIN only; the tenant is the caller's own (no X-Aegis-Tenant on these routes). */
function tenantAdmin(principal: Principal): { tenantId: string; actorId: string } {
  if (principal.kind !== "user") throw new DomainError("FORBIDDEN", "this action requires a user token");
  if (!hasRole(principal, "TENANT_ADMIN")) throw new DomainError("FORBIDDEN", "TENANT_ADMIN role required");
  return { tenantId: principal.tenantId, actorId: principal.userId };
}

function notFound(): DomainError {
  return new DomainError("NOT_FOUND", "webhook source not found");
}

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const [createdAt, id] = raw.split("|");
  if (
    createdAt === undefined ||
    id === undefined ||
    Number.isNaN(Date.parse(createdAt)) ||
    !/^[0-9a-f-]{36}$/.test(id)
  ) {
    throw new DomainError("VALIDATION_ERROR", "request failed validation", {
      details: [{ field: "cursor", message: "invalid cursor" }],
    });
  }
  return { createdAt, id };
}
