// Internal upload actions (§6.2 files.initUpload / completeUpload / abortUpload). Called by the gateway with the
// caller's token, X-Aegis-Tenant and Idempotency-Key. Parse → one service call → map.
import type { JwtVerifier, Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { HttpServer } from "@aegispulse/ts-platform/http";
import { getContext } from "@aegispulse/ts-platform/logging";
import { z } from "zod";
import { CONTENT_TYPES, isAcceptableFilename, PURPOSES } from "../../domain/file.js";
import type { FileRecord } from "../../db/files.repository.js";
import type { FileUploadService } from "../../service/file-upload.service.js";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

/** Contract InitUploadInput: the filename pattern rejects separators, control characters and leading dots. */
const init = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(255)
      .refine(isAcceptableFilename, "no path separators, control characters or leading dots"),
    contentType: z.string().min(1).max(100),
    sizeBytes: z.number().int().min(1).max(536_870_912),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    purpose: z.enum(PURPOSES),
    relatedEntityIds: z.array(uuid).max(100).optional(),
    allowDuplicate: z.boolean().optional(),
  })
  .strict()
  .refine((v) => new Set(v.relatedEntityIds ?? []).size === (v.relatedEntityIds ?? []).length, {
    path: ["relatedEntityIds"],
    message: "must be unique",
  });
const byId = z.object({ fileId: uuid }).strict();
const complete = z
  .object({
    fileId: uuid,
    parts: z
      .array(z.object({ partNumber: z.number().int().min(1).max(32), etag: z.string().min(1) }).strict())
      .min(1)
      .max(32)
      .optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
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

/** §8 File view: storage location and version stay internal. */
export function toFileView(f: FileRecord): Record<string, unknown> {
  return {
    id: f.id,
    tenantId: f.tenantId,
    filename: f.filename,
    contentType: f.contentType,
    detectedType: f.detectedType,
    sizeBytes: f.sizeBytes,
    sha256: f.sha256,
    verifiedSha256: f.verifiedSha256,
    sourceType: f.sourceType,
    sourceUrl: f.sourceUrl,
    purpose: f.purpose,
    relatedEntityIds: f.relatedEntityIds,
    status: f.status,
    failureReason: f.failureReason,
    extractorVersion: f.extractorVersion,
    uploadedBy: f.uploadedBy,
    correlationId: f.correlationId,
    deletedAt: f.deletedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

export function registerUploadRoutes(app: HttpServer, verifier: JwtVerifier, uploads: FileUploadService): void {
  const auth = (headers: Record<string, unknown>, action: string): Promise<Principal> =>
    verifier.authorizeInternal(header(headers, "authorization"), `files.${action}`);

  app.post("/internal/v1/initUpload", async (req, reply) => {
    const principal = await auth(req.headers, "initUpload");
    const input = parse(init, req.body);
    if (!(CONTENT_TYPES as readonly string[]).includes(input.contentType)) {
      // Contract enum → FILE_TYPE_NOT_ALLOWED (422) rather than a generic validation error.
      throw new DomainError("FILE_TYPE_NOT_ALLOWED", "content type not allowed");
    }
    const r = await uploads.initUpload(
      principal,
      header(req.headers, "x-aegis-tenant"),
      header(req.headers, "idempotency-key"),
      input,
    );
    return reply.status(r.httpStatus).send({ data: r.body, meta: meta() });
  });

  app.post("/internal/v1/completeUpload", async (req) => {
    const principal = await auth(req.headers, "completeUpload");
    const input = parse(complete, req.body);
    const f = await uploads.completeUpload(
      principal,
      header(req.headers, "x-aegis-tenant"),
      header(req.headers, "idempotency-key"),
      { fileId: input.fileId, parts: input.parts },
    );
    return { data: toFileView(f), meta: meta() };
  });

  app.post("/internal/v1/abortUpload", async (req) => {
    const principal = await auth(req.headers, "abortUpload");
    const input = parse(byId, req.body);
    const f = await uploads.abortUpload(
      principal,
      header(req.headers, "x-aegis-tenant"),
      header(req.headers, "idempotency-key"),
      input,
    );
    return { data: toFileView(f), meta: meta() };
  });
}
