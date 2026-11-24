// Internal webhook delivery actions (§6.2). ingestWebhookDelivery is called only by the gateway with its SERVICE
// token (act ingestion.ingestWebhookDelivery); the body carries the raw request bytes as base64 (≤ 1 MiB decoded).
import type { JwtVerifier, Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import type { IngestWebhookUseCase } from "../../service/orchestrators/ingest-webhook.usecase.js";

/** base64 of 1 MiB is 1,398,104 chars (contract maxLength); headers and JSON framing fit in the remaining slack. */
const INGEST_BODY_LIMIT = 1_536 * 1024;
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

const ingest = z
  .object({
    sourceKey: z.string().regex(/^[a-z0-9-]{3,60}$/),
    headers: z
      .object({
        "X-Aegis-Signature": z.string().max(1024).optional(),
        "X-Aegis-Timestamp": z.string().max(32).optional(),
        "X-Aegis-Delivery-Id": z.string().max(128).optional(),
      })
      .strict(),
    rawBodyBase64: z
      .string()
      .max(1_398_104)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/),
    receivedAt: z.iso.datetime({ offset: true }),
    clientIp: z.string().min(1).max(45),
  })
  .strict();

const listDeliveries = z
  .object({
    sourceId: uuid,
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    outcome: z.enum(["ACCEPTED", "DUPLICATE"]).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  throw new DomainError("VALIDATION_ERROR", "request failed validation", {
    details: r.error.issues.map((i) => ({ field: i.path.join(".") || "body", message: i.message })),
  });
}

function meta(nextCursor?: string): Record<string, string> {
  const ctx = getContext();
  return {
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
  };
}

export function registerWebhookDeliveryRoutes(
  app: HttpServer,
  verifier: JwtVerifier,
  usecase: IngestWebhookUseCase,
): void {
  const auth = (headers: Record<string, unknown>, action: string): Promise<Principal> =>
    verifier.authorizeInternal(
      typeof headers["authorization"] === "string" ? headers["authorization"] : undefined,
      `ingestion.${action}`,
    );

  app.post("/internal/v1/ingestWebhookDelivery", { bodyLimit: INGEST_BODY_LIMIT }, async (req, reply) => {
    const principal = await auth(req.headers, "ingestWebhookDelivery");
    const result = await usecase.execute(principal, parse(ingest, req.body));
    return reply.status(202).send({ data: result, meta: meta() });
  });

  app.post("/internal/v1/listWebhookDeliveries", async (req) => {
    const principal = await auth(req.headers, "listWebhookDeliveries");
    const page = await usecase.listDeliveries(principal, parse(listDeliveries, req.body));
    return { data: page.items, meta: meta(page.nextCursor) };
  });
}
