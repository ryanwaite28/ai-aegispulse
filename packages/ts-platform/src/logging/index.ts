// Structured JSON logger (NFR-07): pino on stdout with the mandatory fields
// ts, level, service, version, env, traceId, spanId, correlationId, tenantId, eventId, msg,
// plus a redaction list so secrets, raw bodies, file contents and credentials never reach the log.
import { trace } from "@opentelemetry/api";
import { pino, type DestinationStream, type Logger as PinoLogger } from "pino";
import { getContext } from "./context.js";

export { runWithContext, getContext, type LogContext } from "./context.js";

export type Logger = PinoLogger;

export interface LoggerOptions {
  readonly service: string;
  readonly version: string;
  readonly env: string;
  readonly level?: string;
  /** Test hook; defaults to stdout. */
  readonly destination?: DestinationStream;
  /** Extra redaction paths for a service's own sensitive fields. */
  readonly redact?: readonly string[];
}

/**
 * Keys that are always censored, at the top level and one or two levels deep.
 * Censoring is by key name, so a field named "password" anywhere in a log object is never printed.
 */
const SENSITIVE_KEYS = [
  "password",
  "newPassword",
  "currentPassword",
  "secret",
  "clientSecret",
  "client_secret",
  "token",
  "accessToken",
  "refreshToken",
  "authorization",
  "Authorization",
  "cookie",
  "apiKey",
  "privateKey",
  "rawBody",
  "rawBodyBase64",
  "body",
  "content",
  "fileContent",
  "signature",
  "kek",
] as const;

export const DEFAULT_REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
  ...SENSITIVE_KEYS.map((k) => `*.*.${k}`),
  'headers["x-aegis-signature"]',
  'req.headers["x-aegis-signature"]',
];

export const REDACTED = "[REDACTED]";

export function createLogger(options: LoggerOptions): Logger {
  return pino(
    {
      level: options.level ?? "info",
      messageKey: "msg",
      base: { service: options.service, version: options.version, env: options.env },
      timestamp: () => `,"ts":"${new Date().toISOString()}"`,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: [...DEFAULT_REDACT_PATHS, ...(options.redact ?? [])], censor: REDACTED },
      mixin: () => {
        const ctx = getContext();
        const span = trace.getActiveSpan()?.spanContext();
        const fields: Record<string, string> = {};
        if (span !== undefined && trace.isSpanContextValid(span)) {
          fields["traceId"] = span.traceId;
          fields["spanId"] = span.spanId;
        }
        if (ctx.correlationId !== undefined) fields["correlationId"] = ctx.correlationId;
        if (ctx.tenantId !== undefined) fields["tenantId"] = ctx.tenantId;
        if (ctx.eventId !== undefined) fields["eventId"] = ctx.eventId;
        if (ctx.requestId !== undefined) fields["requestId"] = ctx.requestId;
        return fields;
      },
    },
    options.destination,
  );
}

/** Masks an email for logs: "j***@example.com" (PROJECT.md §1.4.2 masking). */
export function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return "***";
  return `${email[0] ?? ""}***${email.slice(at)}`;
}
