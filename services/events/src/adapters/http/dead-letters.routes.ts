// Internal dead-letter actions (§6.2 events.listDeadLetters / getDeadLetter / replayDeadLetter / discardDeadLetter;
// gateway with the user token, FR-MSG-03). Parse → one service call → map to the contract views.
import type { JwtVerifier, Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import type { DeadLetterService, DeadLetterView } from "../../service/dead-letter.service.js";

const iso = z.iso.datetime({ offset: true });
const id = z.string().min(1).max(64);
const list = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    queue: z.string().min(1).max(200).optional(),
    errorCode: z.string().min(1).max(100).optional(),
    from: iso.optional(),
    to: iso.optional(),
  })
  .strict();
const one = z.object({ deadLetterId: id }).strict();
const discard = z.object({ deadLetterId: id, reason: z.string().min(1).max(2000) }).strict();

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

/** Contract DeadLetterSummary. */
export function deadLetterSummaryView(d: DeadLetterView): Record<string, unknown> {
  return {
    id: d._id.toHexString(),
    tenantId: d.tenantId,
    eventId: d.eventId,
    queue: d.queue,
    ...(d.routingKey === null ? {} : { routingKey: d.routingKey }),
    errorCode: d.errorCode,
    errorMessage: d.errorMessage,
    retryCount: d.retryCount,
    firstFailedAt: d.firstFailedAt.toISOString(),
    lastFailedAt: d.lastFailedAt.toISOString(),
    status: d.status,
    resolvedBy: d.resolvedBy,
    resolvedAt: d.resolvedAt === null ? null : d.resolvedAt.toISOString(),
    reason: d.reason,
  };
}

/** Contract DeadLetter: the summary plus the masked envelope (or raw body of poison), headers and redactions. */
export function deadLetterView(d: DeadLetterView): Record<string, unknown> {
  return {
    ...deadLetterSummaryView(d),
    envelope: d.envelope ?? {},
    ...(d.rawBody === null ? {} : { rawBody: d.rawBody }),
    headers: d.headers,
    ...(d.stackHash === null ? {} : { stackHash: d.stackHash }),
    occurrences: d.occurrences,
    redactions: d.redactions,
    replayable: d.queueHeaderMismatch !== true,
  };
}

export function registerDeadLetterRoutes(app: HttpServer, verifier: JwtVerifier, service: DeadLetterService): void {
  const auth = (headers: Record<string, unknown>, action: string): Promise<Principal> =>
    verifier.authorizeInternal(header(headers, "authorization"), `events.${action}`);
  const tenant = (headers: Record<string, unknown>): string | undefined => header(headers, "x-aegis-tenant");

  app.post("/internal/v1/listDeadLetters", async (req) => {
    const principal = await auth(req.headers, "listDeadLetters");
    const page = await service.listDeadLetters(principal, tenant(req.headers), parse(list, req.body));
    return { data: page.items.map(deadLetterSummaryView), meta: meta(page.nextCursor) };
  });

  app.post("/internal/v1/getDeadLetter", async (req) => {
    const principal = await auth(req.headers, "getDeadLetter");
    const input = parse(one, req.body);
    return {
      data: deadLetterView(await service.getDeadLetter(principal, tenant(req.headers), input.deadLetterId)),
      meta: meta(),
    };
  });

  app.post("/internal/v1/replayDeadLetter", async (req) => {
    const principal = await auth(req.headers, "replayDeadLetter");
    const input = parse(one, req.body);
    return {
      data: deadLetterView(await service.replayDeadLetter(principal, tenant(req.headers), input.deadLetterId)),
      meta: meta(),
    };
  });

  app.post("/internal/v1/discardDeadLetter", async (req) => {
    const principal = await auth(req.headers, "discardDeadLetter");
    const input = parse(discard, req.body);
    return {
      data: deadLetterView(
        await service.discardDeadLetter(principal, tenant(req.headers), input.deadLetterId, input.reason),
      ),
      meta: meta(),
    };
  });
}
