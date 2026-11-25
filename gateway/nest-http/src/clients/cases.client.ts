// Typed cases client (ADR-0002). Forwards the caller's bearer token and X-Aegis-Tenant unchanged; cases authorizes
// (contract roles, tenant scope) and owns every rule.
import type { components } from "@aegispulse/contracts/generated/ts/openapi/cases.ts";
import {
  InternalServiceClient,
  type ActionOf,
  type PayloadOf,
  type SuccessEnvelope,
} from "@aegispulse/ts-platform/http-client";
import type { Config } from "../config.js";
import type { Forward } from "./registry.client.js";

export type CasesSchemas = components["schemas"];

/** §6.5 per-call timeout for case reads. */
const CASES_TIMEOUT_MS = 3_000;

export class CasesClient {
  private readonly api: InternalServiceClient<"cases">;

  constructor(config: Config) {
    this.api = new InternalServiceClient("cases", {
      name: "cases",
      baseUrl: config.CASES_URL,
      timeoutMs: CASES_TIMEOUT_MS,
    });
  }

  async call<A extends ActionOf<"cases">, R>(
    action: A,
    payload: PayloadOf<"cases", A>,
    forward: Forward,
  ): Promise<SuccessEnvelope<R>> {
    const headers: Record<string, string> = {};
    if (forward.tenant !== undefined) headers["x-aegis-tenant"] = forward.tenant;
    if (forward.idempotencyKey !== undefined) headers["idempotency-key"] = forward.idempotencyKey;
    return this.api.invokeEnvelope<A, R>(action, payload, {
      ...(forward.authorization === undefined ? {} : { authorization: forward.authorization }),
      headers,
    });
  }

  async close(): Promise<void> {
    await this.api.close();
  }
}
