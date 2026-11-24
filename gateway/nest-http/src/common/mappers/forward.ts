// Transport parsing of the headers the gateway forwards (§6.2). Shapes only; the owning service authorizes.
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { Forward } from "../../clients/registry.client.js";

type Headers = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

function single(headers: Headers, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

/** Forward the caller's verified bearer token plus X-Aegis-Tenant / Idempotency-Key when the route declares them. */
export function forwardFrom(headers: Headers, opts: { tenant?: boolean; idempotency?: boolean } = {}): Forward {
  const authorization = single(headers, "authorization");
  const tenant = opts.tenant === true ? single(headers, "x-aegis-tenant") : undefined;
  const key = opts.idempotency === true ? single(headers, "idempotency-key") : undefined;
  if (tenant !== undefined && !UUID.test(tenant)) {
    throw new DomainError("VALIDATION_ERROR", "request failed validation", {
      details: [{ field: "X-Aegis-Tenant", message: "must be a UUID" }],
    });
  }
  if (key !== undefined && !IDEMPOTENCY_KEY.test(key)) {
    throw new DomainError("VALIDATION_ERROR", "request failed validation", {
      details: [{ field: "Idempotency-Key", message: "1-128 printable ASCII characters" }],
    });
  }
  return {
    ...(authorization === undefined ? {} : { authorization }),
    ...(tenant === undefined ? {} : { tenant }),
    ...(key === undefined ? {} : { idempotencyKey: key }),
  };
}

/** The body must be a JSON object; field-level validation belongs to the owning service (422 passes through). */
export function objectBody(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new DomainError("BAD_REQUEST", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function uuidParam(value: string, field: string): string {
  if (!UUID.test(value)) {
    throw new DomainError("NOT_FOUND", "not found", { details: [{ field, message: "unknown id" }] });
  }
  return value.toLowerCase();
}

/** Query string helpers for list routes (§2.0 PageQuery). */
export function pageQuery(query: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(query)) {
    if (typeof v !== "string" || v === "") continue;
    if (k === "limit") {
      const n = Number(v);
      if (!Number.isInteger(n)) {
        throw new DomainError("VALIDATION_ERROR", "request failed validation", {
          details: [{ field: "limit", message: "must be an integer" }],
        });
      }
      out[k] = n;
    } else {
      out[k] = v;
    }
  }
  return out;
}
