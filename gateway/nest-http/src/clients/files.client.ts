// Typed files client (ADR-0002). Forwards the caller's bearer token, X-Aegis-Tenant and Idempotency-Key unchanged; the
// files service authorizes (FR-AUTH-06) and owns every rule.
import type { components } from "@aegispulse/contracts/generated/ts/openapi/files.ts";
import {
  InternalServiceClient,
  type ActionOf,
  type PayloadOf,
  type SuccessEnvelope,
} from "@aegispulse/ts-platform/http-client";
import type { Config } from "../config.js";
import type { Forward } from "./registry.client.js";

export type FilesSchemas = components["schemas"];

/** §6.5 per-call timeout for files actions (init presigns and writes one row; complete does a HEAD). */
const FILES_TIMEOUT_MS = 3_000;

export class FilesClient {
  private readonly api: InternalServiceClient<"files">;

  constructor(config: Config) {
    this.api = new InternalServiceClient("files", {
      name: "files",
      baseUrl: config.FILES_URL,
      timeoutMs: FILES_TIMEOUT_MS,
    });
  }

  async call<A extends ActionOf<"files">, R>(
    action: A,
    payload: PayloadOf<"files", A>,
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
