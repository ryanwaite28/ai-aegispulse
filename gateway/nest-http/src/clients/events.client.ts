// Typed events client (ADR-0002). Forwards the caller's bearer token and X-Aegis-Tenant unchanged; the events service
// authorizes (contract roles, restricted tier for COMPLIANCE_AUDITOR only) and owns every rule.
import type { components } from "@aegispulse/contracts/generated/ts/openapi/events.ts";
import {
  InternalServiceClient,
  type ActionOf,
  type PayloadOf,
  type SuccessEnvelope,
} from "@aegispulse/ts-platform/http-client";
import type { Config } from "../config.js";
import type { Forward } from "./registry.client.js";

export type EventsSchemas = components["schemas"];

/** §6.5 per-call timeout for archive reads. */
const EVENTS_TIMEOUT_MS = 3_000;

export class EventsClient {
  private readonly api: InternalServiceClient<"events">;

  constructor(config: Config) {
    this.api = new InternalServiceClient("events", {
      name: "events",
      baseUrl: config.EVENTS_URL,
      timeoutMs: EVENTS_TIMEOUT_MS,
    });
  }

  async call<A extends ActionOf<"events">, R>(
    action: A,
    payload: PayloadOf<"events", A>,
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
