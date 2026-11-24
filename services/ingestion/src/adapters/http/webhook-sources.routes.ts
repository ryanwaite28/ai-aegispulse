// Internal webhook-source actions (§6.2: POST /internal/v1/{action}). Transport only: authenticate → validate shape
// (zod, mirroring ingestion.internal.yaml; additionalProperties:false) → one service call → §8.2 envelope.
import type { JwtVerifier, Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import type { WebhookSourceService } from "../../service/webhook-source.service.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const hosts = z.array(z.string().min(1).max(253)).max(50);
const trust = z.enum(["TRUSTED", "UNTRUSTED"]);

const schemas = {
  createWebhookSource: z
    .object({
      sourceKey: z.string().regex(/^[a-z0-9-]{3,60}$/),
      displayName: z.string().min(1).max(200),
      trustLevel: trust.optional(),
      payloadProfile: z.literal("AEGIS_MARKET_EVENT_V1").optional(),
      allowedAttachmentHosts: hosts.optional(),
    })
    .strict(),
  listWebhookSources: z
    .object({
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z
        .string()
        .max(1024)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    })
    .strict(),
  updateWebhookSource: z
    .object({
      sourceId: uuid,
      displayName: z.string().min(1).max(200).optional(),
      status: z.enum(["ACTIVE", "DISABLED"]).optional(),
      trustLevel: trust.optional(),
      allowedAttachmentHosts: hosts.optional(),
    })
    .strict()
    .refine((v) => Object.keys(v).length >= 2, { message: "at least one field to change is required" }),
  rotateWebhookSecret: z.object({ sourceId: uuid }).strict(),
  deleteWebhookSource: z.object({ sourceId: uuid }).strict(),
};

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  throw new DomainError("VALIDATION_ERROR", "request failed validation", {
    details: r.error.issues.map((i) => ({ field: i.path.join(".") || "body", message: i.message })),
  });
}

function success<T>(data: T, nextCursor?: string): { data: T; meta: Record<string, string> } {
  const ctx = getContext();
  return {
    data,
    meta: {
      ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
      ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    },
  };
}

const idemKey = (headers: Record<string, unknown>): string | undefined => {
  const v = headers["idempotency-key"];
  return typeof v === "string" ? v : undefined;
};

export function registerWebhookSourceRoutes(
  app: HttpServer,
  verifier: JwtVerifier,
  sources: WebhookSourceService,
): void {
  const auth = (headers: Record<string, unknown>, action: string): Promise<Principal> =>
    verifier.authorizeInternal(
      typeof headers["authorization"] === "string" ? headers["authorization"] : undefined,
      `ingestion.${action}`,
    );

  app.post("/internal/v1/createWebhookSource", async (req, reply) => {
    const principal = await auth(req.headers, "createWebhookSource");
    const created = await sources.create(principal, idemKey(req.headers), parse(schemas.createWebhookSource, req.body));
    return reply.status(201).send(success(created));
  });
  app.post("/internal/v1/listWebhookSources", async (req) => {
    const principal = await auth(req.headers, "listWebhookSources");
    const page = await sources.list(principal, parse(schemas.listWebhookSources, req.body ?? {}));
    return success(page.items, page.nextCursor);
  });
  app.post("/internal/v1/updateWebhookSource", async (req) => {
    const principal = await auth(req.headers, "updateWebhookSource");
    return success(await sources.update(principal, idemKey(req.headers), parse(schemas.updateWebhookSource, req.body)));
  });
  app.post("/internal/v1/rotateWebhookSecret", async (req) => {
    const principal = await auth(req.headers, "rotateWebhookSecret");
    const { sourceId } = parse(schemas.rotateWebhookSecret, req.body);
    return success(await sources.rotate(principal, idemKey(req.headers), sourceId));
  });
  app.post("/internal/v1/deleteWebhookSource", async (req) => {
    const principal = await auth(req.headers, "deleteWebhookSource");
    await sources.remove(principal, parse(schemas.deleteWebhookSource, req.body).sourceId);
    return success({});
  });
}
