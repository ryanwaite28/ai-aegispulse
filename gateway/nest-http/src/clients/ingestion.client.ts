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
const WEBHOOK_TIMEOUT_MS = 10_000;

export class IngestionClient {
  private readonly api: InternalServiceClient<"ingestion">;
  private readonly webhooks: InternalServiceClient<"ingestion">;

  /** `gatewayToken` returns the gateway's own SERVICE token (shared with the registry client). */
  constructor(
    config: Config,
    private readonly gatewayToken: () => Promise<string>,
  ) {
    this.api = new InternalServiceClient("ingestion", {
      name: "ingestion",
      baseUrl: config.INGESTION_URL,
      timeoutMs: INGESTION_TIMEOUT_MS,
    });
    // Webhook ingest writes the raw object and a transaction; it gets more time than plain management calls.
    this.webhooks = new InternalServiceClient("ingestion", {
      name: "ingestion",
      baseUrl: config.INGESTION_URL,
      timeoutMs: WEBHOOK_TIMEOUT_MS,
      connections: 32,
    });
  }

  /** ingestWebhookDelivery: no user token exists for a publisher, so the gateway's SERVICE token is used (§5.7.4). */
  async callAsGateway<A extends "ingestWebhookDelivery", R>(
    action: A,
    payload: PayloadOf<"ingestion", A>,
  ): Promise<SuccessEnvelope<R>> {
    return this.webhooks.invokeEnvelope<A, R>(action, payload, {
      authorization: `Bearer ${await this.gatewayToken()}`,
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
    await Promise.all([this.api.close(), this.webhooks.close()]);
  }
}
