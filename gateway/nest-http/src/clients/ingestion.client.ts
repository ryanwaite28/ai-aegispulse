// Typed ingestion client (ADR-0002). Forwards the caller's bearer token and Idempotency-Key; the webhook delivery
// action (slice 4b) uses the gateway's own SERVICE token (§5.7.4 ingestion.ingestWebhookDelivery).
import type { components } from "@aegispulse/contracts/generated/ts/openapi/ingestion.ts";
import {
  InternalServiceClient,
  type ActionOf,
  type PayloadOf,
  type SuccessEnvelope,
} from "@aegispulse/ts-platform/http-client";
import type { Config } from "../config.js";
import type { Forward } from "./registry.client.js";

export type IngestionSchemas = components["schemas"];

/** §6.5 per-call timeout for ingestion actions. */
const INGESTION_TIMEOUT_MS = 3_000;

export class IngestionClient {
  private readonly api: InternalServiceClient<"ingestion">;

  constructor(config: Config) {
    this.api = new InternalServiceClient("ingestion", {
      name: "ingestion",
      baseUrl: config.INGESTION_URL,
      timeoutMs: INGESTION_TIMEOUT_MS,
    });
  }

  async call<A extends ActionOf<"ingestion">, R>(
    action: A,
    payload: PayloadOf<"ingestion", A>,
    forward: Forward,
  ): Promise<SuccessEnvelope<R>> {
    const headers: Record<string, string> = {};
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
