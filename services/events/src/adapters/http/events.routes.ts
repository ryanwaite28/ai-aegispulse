// Internal query actions (§6.2 events.searchEvents / getEvent / getCorrelationChain: gateway with the user token;
// searchEventsForEntities: orchestrator SERVICE token). Parse → one service call → map to the contract views.
import type { JwtVerifier, Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import { SEVERITIES } from "../../domain/classification/severity.js";
import type { EventQueryService, TieredEvent } from "../../service/event-query.service.js";
import type { OverrideService } from "../../service/override.service.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const iso = z.iso.datetime({ offset: true });
const STATUSES = [
  "INGESTED",
  "RULE_SCANNED",
  "AI_SCANNED",
  "CLASSIFIED",
  "OVERRIDDEN",
  "ARCHIVED",
  "REPLAYED",
] as const;
const tier = z.enum(["standard", "restricted"]);

const search = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    correlationId: z.string().min(1).max(200).optional(),
    eventType: z.string().min(1).max(200).optional(),
    finalSeverity: z.enum(SEVERITIES).optional(),
    status: z.enum(STATUSES).optional(),
    source: z.string().min(1).max(200).optional(),
    entity: uuid.optional(),
    from: iso.optional(),
    to: iso.optional(),
    tier: tier.optional(),
  })
  .strict();
const getOne = z.object({ eventId: uuid, tier: tier.optional() }).strict();
const chain = z.object({ correlationId: z.string().min(1).max(200) }).strict();
/** Contract OverrideClassificationInput; the ≥ 20-char justification rule is the service's (422 with its own code). */
const override = z
  .object({
    eventId: uuid,
    finalSeverity: z.enum(SEVERITIES).optional(),
    sensitivity: z.enum(["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED", "UNCLASSIFIED"]).optional(),
    justification: z.string().max(2000),
  })
  .strict();
const forEntities = z
  .object({
    tenantId: uuid,
    entityIds: z.array(uuid).min(1).max(50),
    eventTypes: z.array(z.string().min(1).max(200)).min(1).max(20),
    since: iso,
    limit: z.number().int().min(1).max(100),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  throw new DomainError("VALIDATION_ERROR", "request failed validation", {
    details: r.error.issues.map((i) => ({ field: i.path.join(".") || "body", message: i.message })),
  });
}

function header(headers: Record<string, unknown>, name: string): string | undefined {
  const v = headers[name];
  return typeof v === "string" ? v : undefined;
}

function meta(nextCursor?: string): Record<string, string> {
  const ctx = getContext();
  return {
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

/** Contract EventClassification: nulls the schema does not allow are omitted. */
function classificationView(e: TieredEvent): Record<string, unknown> {
  const c = e.classification;
  return {
    sensitivity: c.sensitivity,
    categories: c.categories,
    publisher_stated_severity: c.publisher_stated_severity,
    source_trust_level: c.source_trust_level,
    algorithm_severity: c.algorithm_severity,
    ...(c.algorithm_confidence === null ? {} : { algorithm_confidence: c.algorithm_confidence }),
    final_severity: c.final_severity,
    classification_source: c.classification_source,
    rule_version: c.rule_version,
    ...(c.classifier_version === null ? {} : { classifier_version: c.classifier_version }),
    status: e.status,
    revision: c.revision,
  };
}

/** Contract EventSummary: ids, lineage and classification; never the payload. */
export function summaryView(e: TieredEvent): Record<string, unknown> {
  return {
    eventId: e.eventId,
    correlationId: e.correlationId,
    causationId: e.causationId,
    eventType: e.eventType,
    source: e.source,
    occurredAt: e.occurredAt.toISOString(),
    ingestedAt: e.ingestedAt.toISOString(),
    archivedAt: e.archivedAt.toISOString(),
    classification: classificationView(e),
    status: e.status,
    mentionedEntityIds: e.mentionedEntityIds,
    tier: e.tier,
  };
}

/** Contract ArchivedEvent: the summary plus the redacted payload and the full lineage histories. */
export function archivedView(e: TieredEvent): Record<string, unknown> {
  return {
    ...summaryView(e),
    tenantId: e.tenantId,
    schemaVersion: e.schemaVersion,
    exchange: e.exchange,
    routingKey: e.routingKey,
    idempotencyKey: e.idempotencyKey,
    payload: e.payload,
    redactions: e.redactions,
    payloadSha256: e.payloadSha256,
    statusHistory: e.statusHistory.map((s) => ({ status: s.status, at: s.at.toISOString(), by: s.by })),
    classificationHistory: e.classificationHistory.map((h) => ({
      stage: h.stage,
      source: h.source,
      sensitivity: h.sensitivity,
      severity: h.severity,
      ...(h.confidence === null ? {} : { confidence: h.confidence }),
      version: h.version,
      at: h.at.toISOString(),
      ...(h.actor === undefined ? {} : { actor: h.actor }),
      ...(h.justification === undefined ? {} : { justification: h.justification }),
    })),
    replay: {
      count: e.replay.count,
      lastReplayedAt: e.replay.lastReplayedAt === null ? null : e.replay.lastReplayedAt.toISOString(),
      lastJobId: e.replay.lastJobId,
    },
    pendingAiScan: e.pendingAiScan,
  };
}

export function registerEventRoutes(
  app: HttpServer,
  verifier: JwtVerifier,
  queries: EventQueryService,
  overrides: OverrideService,
): void {
  const auth = (headers: Record<string, unknown>, action: string): Promise<Principal> =>
    verifier.authorizeInternal(header(headers, "authorization"), `events.${action}`);
  const tenant = (headers: Record<string, unknown>): string | undefined => header(headers, "x-aegis-tenant");

  app.post("/internal/v1/searchEvents", async (req) => {
    const principal = await auth(req.headers, "searchEvents");
    const page = await queries.searchEvents(principal, tenant(req.headers), parse(search, req.body));
    return { data: page.items.map(summaryView), meta: meta(page.nextCursor) };
  });

  app.post("/internal/v1/getEvent", async (req) => {
    const principal = await auth(req.headers, "getEvent");
    return {
      data: archivedView(await queries.getEvent(principal, tenant(req.headers), parse(getOne, req.body))),
      meta: meta(),
    };
  });

  app.post("/internal/v1/getCorrelationChain", async (req) => {
    const principal = await auth(req.headers, "getCorrelationChain");
    const rows = await queries.getCorrelationChain(
      principal,
      tenant(req.headers),
      parse(chain, req.body).correlationId,
    );
    return { data: rows.map(summaryView), meta: meta() };
  });

  app.post("/internal/v1/searchEventsForEntities", async (req) => {
    const principal = await auth(req.headers, "searchEventsForEntities");
    const rows = await queries.searchEventsForEntities(principal, parse(forEntities, req.body));
    return { data: rows.map(summaryView), meta: meta() };
  });

  app.post("/internal/v1/overrideClassification", async (req) => {
    const principal = await auth(req.headers, "overrideClassification");
    const input = parse(override, req.body);
    return {
      data: archivedView(await overrides.overrideClassification(principal, tenant(req.headers), input)),
      meta: meta(),
    };
  });
}
