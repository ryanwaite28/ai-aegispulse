// Event queries (FR-EVT-04..06; spec FR-EVT-CLS §2 "Queries"). Tenant principals via tenantAccess (contract roles,
// X-Aegis-Tenant for PLATFORM_ADMIN). The restricted tier is COMPLIANCE_AUDITOR-only; everyone else reads the standard
// tier. searchEventsForEntities is a SERVICE action (orchestrator act[]) that names its tenant explicitly.
import type { Principal } from "@aegispulse/ts-platform/auth";
import { tenantAccess } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { Severity } from "../domain/classification/severity.js";
import { causalOrder } from "../domain/correlation.js";
import type { ArchivedEvent, EventStatus, Tier } from "../db/archive.repository.js";
import type { EventQueryRepository, Keyset } from "../db/event-query.repository.js";
import { rolesFor } from "./roles.js";

export interface SearchInput {
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
  readonly correlationId?: string | undefined;
  readonly eventType?: string | undefined;
  readonly finalSeverity?: Severity | undefined;
  readonly status?: EventStatus | undefined;
  readonly source?: string | undefined;
  readonly entity?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly tier?: Tier | undefined;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | undefined;
}

export type TieredEvent = ArchivedEvent & { tier: Tier };

const DEFAULT_LIMIT = 25;

export class EventQueryService {
  constructor(private readonly repo: EventQueryRepository) {}

  async searchEvents(
    principal: Principal,
    actingTenant: string | undefined,
    q: SearchInput,
  ): Promise<Page<TieredEvent>> {
    const access = tenantAccess(principal, actingTenant, rolesFor("searchEvents"));
    const tier = this.tier(access.roles, q.tier);
    const limit = q.limit ?? DEFAULT_LIMIT;
    const rows = await this.repo.search(
      tier,
      access.tenantId,
      {
        correlationId: q.correlationId,
        eventTypePrefix: q.eventType,
        finalSeverity: q.finalSeverity,
        status: q.status,
        source: q.source,
        entity: q.entity,
        from: q.from === undefined ? undefined : new Date(q.from),
        to: q.to === undefined ? undefined : new Date(q.to),
      },
      q.cursor === undefined ? undefined : decodeCursor(q.cursor),
      limit + 1,
    );
    const page = rows.slice(0, limit).map((r) => ({ ...r, tier }));
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor:
        rows.length > limit && last !== undefined
          ? encodeCursor({ occurredAt: last.occurredAt, eventId: last.eventId })
          : undefined,
    };
  }

  async getEvent(
    principal: Principal,
    actingTenant: string | undefined,
    input: { eventId: string; tier?: Tier | undefined },
  ): Promise<TieredEvent> {
    const access = tenantAccess(principal, actingTenant, rolesFor("getEvent"));
    const tier = this.tier(access.roles, input.tier);
    const doc = await this.repo.get(tier, access.tenantId, input.eventId);
    if (doc === null) throw new DomainError("EVENT_NOT_FOUND", "event not found");
    return { ...doc, tier };
  }

  /** FR-EVT-05: the correlation's events in causal order (each cause before its effects). */
  async getCorrelationChain(
    principal: Principal,
    actingTenant: string | undefined,
    correlationId: string,
  ): Promise<TieredEvent[]> {
    const access = tenantAccess(principal, actingTenant, rolesFor("getEventCorrelationChain"));
    const rows = await this.repo.correlation(access.tenantId, correlationId);
    return causalOrder(rows).map((r) => ({ ...r, tier: "standard" as const }));
  }

  async searchEventsForEntities(
    principal: Principal,
    input: {
      tenantId: string;
      entityIds: readonly string[];
      eventTypes: readonly string[];
      since: string;
      limit: number;
    },
  ): Promise<TieredEvent[]> {
    if (principal.kind !== "service")
      throw new DomainError("FORBIDDEN", "searchEventsForEntities is for internal services");
    const rows = await this.repo.forEntities(
      input.tenantId,
      input.entityIds,
      input.eventTypes,
      new Date(input.since),
      input.limit,
    );
    return rows.map((r) => ({ ...r, tier: "standard" as const }));
  }

  /** FR-EVT-04: the restricted tier is COMPLIANCE_AUDITOR-only; VIEWER/ANALYST (and everyone else) never see it. */
  private tier(roles: readonly string[], requested: Tier | undefined): Tier {
    if (requested !== "restricted") return "standard";
    if (!roles.includes("COMPLIANCE_AUDITOR")) {
      throw new DomainError("FORBIDDEN", "the restricted tier is available to COMPLIANCE_AUDITOR only");
    }
    return "restricted";
  }
}

function encodeCursor(k: Keyset): string {
  return Buffer.from(`${k.occurredAt.toISOString()}|${k.eventId}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Keyset {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (at === undefined || id === undefined || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/.test(id)) {
    throw new DomainError("VALIDATION_ERROR", "request failed validation", {
      details: [{ field: "cursor", message: "invalid cursor" }],
    });
  }
  return { occurredAt: new Date(at), eventId: id };
}
