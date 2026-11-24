// Internal read + processing-lifecycle actions (§6.2): getFile, listFiles, getDownloadUrl (gateway, user tokens) and
// markProcessing, recordExtractionResult, recordProcessingFailure, getInternalDownloadUrl (doc-extraction SERVICE
// token; act[] enforced by authorizeInternal). Parse → one service call → map.
import type { JwtVerifier, Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import { PURPOSES } from "../../domain/file.js";
import type { FileProcessingService } from "../../service/file-processing.service.js";
import type { FileQueryService } from "../../service/file-query.service.js";
import { toFileView } from "./uploads.routes.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const iso = z.iso.datetime({ offset: true });
const STATUSES = [
  "INITIATED",
  "UPLOADED",
  "VALIDATED",
  "PROCESSING",
  "PROCESSED",
  "FAILED",
  "QUARANTINED",
  "EXPIRED",
] as const;
const version = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9._:-]+$/);
/** §7.8 artifact keys: artifacts/{tenantId}/{fileId}/{extractorVersion}/… (pointers only). */
const artifactKey = z
  .string()
  .min(1)
  .max(512)
  .regex(/^artifacts\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[^/]+\/[A-Za-z0-9._-]+$/);

const byId = z.object({ fileId: uuid }).strict();
const list = z
  .object({
    limit: z.number().int().min(1).max(100).optional(),
    cursor: z
      .string()
      .max(1024)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    status: z.enum(STATUSES).optional(),
    purpose: z.enum(PURPOSES).optional(),
    uploadedBy: uuid.optional(),
    from: iso.optional(),
    to: iso.optional(),
  })
  .strict();
const download = z.object({ fileId: uuid, acknowledgeQuarantine: z.boolean().optional() }).strict();
const mark = z.object({ fileId: uuid, extractorVersion: version }).strict();
const result = z
  .object({
    fileId: uuid,
    extractorVersion: version,
    status: z.enum(["COMPLETED", "REVIEW_REQUIRED"]),
    confidence: z.number().min(0).max(1),
    artifactKeys: z
      .object({
        textKey: artifactKey.optional(),
        chunksKey: artifactKey.optional(),
        extractionKey: artifactKey,
        rowErrorsKey: artifactKey.optional(),
      })
      .strict(),
    rowsAccepted: z.number().int().min(0).optional(),
    rowsRejected: z.number().int().min(0).optional(),
    summary: z
      .object({
        eventTypeGuess: z.enum([
          "REGULATION_PUBLISHED",
          "IPO_FILED",
          "ACQUISITION_ANNOUNCED",
          "COMPLIANCE_DISCLOSURE",
          "OTHER",
        ]),
        mentionedEntities: z.array(z.string().min(1).max(200)).max(500),
        redFlags: z.array(z.unknown()).max(200),
        textExcerpt: z.string().max(2000).optional(),
      })
      .strict(),
  })
  .strict();
const failure = z.object({ fileId: uuid, reason: z.string().min(1).max(500), retryable: z.boolean() }).strict();

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

export function registerFileRoutes(
  app: HttpServer,
  verifier: JwtVerifier,
  queries: FileQueryService,
  processing: FileProcessingService,
): void {
  const auth = (headers: Record<string, unknown>, action: string): Promise<Principal> =>
    verifier.authorizeInternal(header(headers, "authorization"), `files.${action}`);
  const tenant = (headers: Record<string, unknown>): string | undefined => header(headers, "x-aegis-tenant");

  app.post("/internal/v1/getFile", async (req) => {
    const principal = await auth(req.headers, "getFile");
    const d = await queries.getFile(principal, tenant(req.headers), parse(byId, req.body).fileId);
    return { data: { ...toFileView(d.file), artifacts: d.artifacts }, meta: meta() };
  });

  app.post("/internal/v1/listFiles", async (req) => {
    const principal = await auth(req.headers, "listFiles");
    const page = await queries.listFiles(principal, tenant(req.headers), parse(list, req.body));
    return { data: page.items.map(toFileView), meta: meta(page.nextCursor) };
  });

  app.post("/internal/v1/getDownloadUrl", async (req) => {
    const principal = await auth(req.headers, "getDownloadUrl");
    return {
      data: await queries.getDownloadUrl(principal, tenant(req.headers), parse(download, req.body)),
      meta: meta(),
    };
  });

  app.post("/internal/v1/getInternalDownloadUrl", async (req) => {
    const principal = await auth(req.headers, "getInternalDownloadUrl");
    return { data: await processing.getInternalDownloadUrl(principal, parse(byId, req.body)), meta: meta() };
  });

  app.post("/internal/v1/markProcessing", async (req) => {
    const principal = await auth(req.headers, "markProcessing");
    return { data: toFileView(await processing.markProcessing(principal, parse(mark, req.body))), meta: meta() };
  });

  app.post("/internal/v1/recordExtractionResult", async (req) => {
    const principal = await auth(req.headers, "recordExtractionResult");
    return {
      data: toFileView(await processing.recordExtractionResult(principal, parse(result, req.body))),
      meta: meta(),
    };
  });

  app.post("/internal/v1/recordProcessingFailure", async (req) => {
    const principal = await auth(req.headers, "recordProcessingFailure");
    return {
      data: toFileView(await processing.recordProcessingFailure(principal, parse(failure, req.body))),
      meta: meta(),
    };
  });
}
