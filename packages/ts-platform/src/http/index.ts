// Fastify transport adapter for Node services (PROJECT.md §6.1 internal adapters, §8.2, NFR-07, NFR-11).
// Transport only: request/correlation ids into the log context, body limits, §8.2 error envelopes, and the
// /livez /readyz /healthz probes. Services register their internal routes on the returned instance.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from "fastify";
import { HttpStatusError } from "../http-client/index.js";
import { DomainError, PermanentError, PoisonMessageError, TransientError, describeError } from "../errors/index.js";
import type { HealthRegistry } from "../health/index.js";
import { getContext, runWithContext, type Logger } from "../logging/index.js";
import { trace } from "@opentelemetry/api";

const CORRELATION = /^corr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** §8.4 code → HTTP status for DomainError (codes not listed default to 409). */
const STATUS_BY_CODE: Readonly<Record<string, number>> = {
  VALIDATION_ERROR: 422,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  IDEMPOTENCY_KEY_REUSED: 409,
  IDEMPOTENCY_KEY_REQUIRED: 422,
};

export interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string; readonly details: readonly unknown[] };
  readonly meta: { readonly requestId?: string; readonly correlationId?: string; readonly traceId?: string };
}

function envelope(code: string, message: string, details: readonly unknown[] = []): ErrorEnvelope {
  const ctx = getContext();
  const span = trace.getActiveSpan()?.spanContext();
  return {
    error: { code, message, details },
    meta: {
      ...(ctx.requestId === undefined ? {} : { requestId: ctx.requestId }),
      ...(ctx.correlationId === undefined ? {} : { correlationId: ctx.correlationId }),
      ...(span === undefined ? {} : { traceId: span.traceId }),
    },
  };
}

/** Maps any thrown value to (status, §8.2 envelope); never leaks stacks or internal messages for 5xx. */
export function toErrorResponse(error: unknown): { status: number; body: ErrorEnvelope } {
  if (error instanceof DomainError) {
    return { status: STATUS_BY_CODE[error.code] ?? 409, body: envelope(error.code, error.message, error.details) };
  }
  if (error instanceof HttpStatusError) return { status: error.status, body: envelope(error.code, error.message) };
  if (error instanceof TransientError)
    return { status: 503, body: envelope("DEPENDENCY_UNAVAILABLE", "dependency unavailable") };
  if (error instanceof PermanentError || error instanceof PoisonMessageError) {
    return { status: 422, body: envelope(error.code, error.message) };
  }
  const fastifyError = error as Partial<FastifyError>;
  if (fastifyError.code === "FST_ERR_CTP_BODY_TOO_LARGE")
    return { status: 413, body: envelope("PAYLOAD_TOO_LARGE", "body too large") };
  if (fastifyError.validation !== undefined)
    return { status: 422, body: envelope("VALIDATION_ERROR", "request failed validation") };
  if (typeof fastifyError.statusCode === "number" && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
    return {
      status: fastifyError.statusCode,
      body: envelope("BAD_REQUEST", "malformed request or unsupported content type"),
    };
  }
  return { status: 500, body: envelope("INTERNAL_ERROR", "internal error") };
}

/** A Fastify instance logging through the platform pino logger. */
export type HttpServer = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;

export interface HttpServerOptions {
  readonly logger: Logger;
  /** JSON APIs 256 KiB (NFR-08); webhook ingestion raises it to 1 MiB on its own route. */
  readonly bodyLimit?: number;
  /** The NestJS gateway sets true: Nest installs its own 404 and error handling (its envelope filter maps both). */
  readonly nestManaged?: boolean;
}

export function createHttpServer(options: HttpServerOptions): HttpServer {
  const app = Fastify({
    loggerInstance: options.logger,
    disableRequestLogging: true,
    bodyLimit: options.bodyLimit ?? 256 * 1024,
    genReqId: (req) => {
      const inbound = req.headers["x-request-id"];
      return typeof inbound === "string" && REQUEST_ID.test(inbound) ? inbound : `req_${randomUUID()}`;
    },
    requestIdHeader: false,
  });

  app.addHook("onRequest", (request, reply, done) => {
    const inbound = request.headers["x-correlation-id"];
    const correlationId = typeof inbound === "string" && CORRELATION.test(inbound) ? inbound : `corr-${randomUUID()}`;
    void reply.header("x-correlation-id", correlationId).header("x-request-id", request.id);
    runWithContext({ correlationId, requestId: request.id }, done);
  });

  if (options.nestManaged !== true) {
    app.setErrorHandler((error, _request, reply) => {
      const { status, body } = toErrorResponse(error);
      if (status >= 500) options.logger.error({ err: describeError(error) }, "request failed");
      void reply.status(status).send(body);
    });
  }

  if (options.nestManaged !== true) {
    app.setNotFoundHandler((_request, reply) => {
      void reply.status(404).send(envelope("NOT_FOUND", "route not found"));
    });
  }

  return app;
}

/** /livez (never checks dependencies), /readyz (503 until ready), /healthz (same report, traced). */
export function registerHealthRoutes(app: HttpServer, health: HealthRegistry): void {
  app.get("/livez", async () => health.livez());
  const report = async (_request: unknown, reply: FastifyReply): Promise<FastifyReply> => {
    const r = await health.readyz();
    return reply.status(r.ready ? 200 : 503).send(r);
  };
  app.get("/readyz", report);
  app.get("/healthz", report);
}
