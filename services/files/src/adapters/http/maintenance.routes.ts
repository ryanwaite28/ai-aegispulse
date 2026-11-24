// Scheduled maintenance (sweepOrphans, purgeRetention: scheduler-trigger SERVICE token) and deleteFile (gateway, user
// token). Parse → one service call → map.
import type { JwtVerifier, Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import type { FileMaintenanceService } from "../../service/file-maintenance.service.js";

const empty = z.object({}).strict();
const byId = z
  .object({ fileId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) })
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

function meta(): Record<string, string> {
  const ctx = getContext();
  return {
    ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
    ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
  };
}

export function registerMaintenanceRoutes(
  app: HttpServer,
  verifier: JwtVerifier,
  maintenance: FileMaintenanceService,
): void {
  const auth = (headers: Record<string, unknown>, action: string): Promise<Principal> =>
    verifier.authorizeInternal(header(headers, "authorization"), `files.${action}`);

  app.post("/internal/v1/sweepOrphans", async (req) => {
    const principal = await auth(req.headers, "sweepOrphans");
    parse(empty, req.body);
    return { data: await maintenance.sweepOrphans(principal), meta: meta() };
  });

  app.post("/internal/v1/purgeRetention", async (req) => {
    const principal = await auth(req.headers, "purgeRetention");
    parse(empty, req.body);
    return { data: await maintenance.purgeRetention(principal), meta: meta() };
  });

  app.post("/internal/v1/deleteFile", async (req) => {
    const principal = await auth(req.headers, "deleteFile");
    await maintenance.deleteFile(principal, header(req.headers, "x-aegis-tenant"), parse(byId, req.body));
    return { data: {}, meta: meta() };
  });
}
