// Typed registry client (ADR-0002: the gateway calls services, never datastores). Two pools: Argon2id-backed auth
// actions get a longer timeout than plain reads/writes. Forwarding is explicit: the user's bearer token (or the
// gateway's own SERVICE token where no user token can exist yet, §5.7.4), X-Aegis-Tenant and Idempotency-Key.
import type { components } from "@aegispulse/contracts/generated/ts/openapi/registry.ts";
import { ServiceTokenProvider } from "@aegispulse/ts-platform/auth";
import {
  HttpClient,
  InternalServiceClient,
  type ActionOf,
  type PayloadOf,
  type SuccessEnvelope,
} from "@aegispulse/ts-platform/http-client";
import { REGISTRY_AUTH_TIMEOUT_MS, REGISTRY_TIMEOUT_MS, type Config } from "../config.js";

export type RegistrySchemas = components["schemas"];
export type RegistryAction = ActionOf<"registry">;

/** Headers the gateway forwards (already validated as present strings by the controller). */
export interface Forward {
  readonly authorization?: string;
  readonly tenant?: string;
  readonly idempotencyKey?: string;
}

const AUTH_ACTIONS: ReadonlySet<RegistryAction> = new Set<RegistryAction>([
  "login",
  "refreshToken",
  "changePassword",
  "issueClientCredentialsToken",
  "createUser",
  "createServiceAccount",
  "rotateServiceAccountSecret",
]);

export class RegistryClient {
  private readonly api: InternalServiceClient<"registry">;
  private readonly authApi: InternalServiceClient<"registry">;
  private readonly raw: HttpClient;
  private readonly serviceToken: ServiceTokenProvider;

  constructor(config: Config) {
    const baseUrl = config.REGISTRY_URL;
    this.api = new InternalServiceClient("registry", { name: "registry", baseUrl, timeoutMs: REGISTRY_TIMEOUT_MS });
    this.authApi = new InternalServiceClient("registry", {
      name: "registry",
      baseUrl,
      timeoutMs: REGISTRY_AUTH_TIMEOUT_MS,
      connections: 8,
    });
    this.raw = new HttpClient({ name: "registry", baseUrl, timeoutMs: REGISTRY_TIMEOUT_MS });
    this.serviceToken = new ServiceTokenProvider({
      clientId: config.SERVICE_CLIENT_ID,
      clientSecret: config.SERVICE_CLIENT_SECRET,
      issue: (input) =>
        this.authApi.invoke<"issueClientCredentialsToken", RegistrySchemas["AccessToken"]>(
          "issueClientCredentialsToken",
          input,
        ),
    });
  }

  /** Calls one registry action with the caller's token and forwarded headers; returns the §8.2 envelope. */
  async call<A extends RegistryAction, R>(
    action: A,
    payload: PayloadOf<"registry", A>,
    forward: Forward,
  ): Promise<SuccessEnvelope<R>> {
    const headers: Record<string, string> = {};
    if (forward.tenant !== undefined) headers["x-aegis-tenant"] = forward.tenant;
    if (forward.idempotencyKey !== undefined) headers["idempotency-key"] = forward.idempotencyKey;
    const client = AUTH_ACTIONS.has(action) ? this.authApi : this.api;
    return client.invokeEnvelope<A, R>(action, payload, {
      ...(forward.authorization === undefined ? {} : { authorization: forward.authorization }),
      headers,
    });
  }

  /** login / refreshToken: no user token exists yet, so the gateway uses its own SERVICE token (§5.7.4). */
  async callAsGateway<A extends "login" | "refreshToken", R>(
    action: A,
    payload: PayloadOf<"registry", A>,
  ): Promise<SuccessEnvelope<R>> {
    return this.call<A, R>(action, payload, { authorization: `Bearer ${await this.serviceToken.token()}` });
  }

  /** The gateway's own SERVICE token (svc-gateway), cached until shortly before expiry. */
  gatewayToken = (): Promise<string> => this.serviceToken.token();

  /** FR-AUTH-05: the bare JWK Set, passed through unchanged. */
  async jwks(): Promise<{ body: unknown; cacheControl: string | undefined }> {
    const res = await this.raw.request<unknown>({ method: "GET", path: "/.well-known/jwks.json" });
    const cc = res.headers["cache-control"];
    return { body: res.body, cacheControl: typeof cc === "string" ? cc : undefined };
  }

  async close(): Promise<void> {
    await Promise.all([this.api.close(), this.authApi.close(), this.raw.close()]);
  }
}
