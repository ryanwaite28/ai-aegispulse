// Caller-side tenant settings cache (FR-TEN-08: "cached ≤ 60 s by callers"). Entries live at most `ttlMs`;
// concurrent misses for one tenant share a single registry call; `invalidate` lets a consumer of
// `registry.tenant.settings_changed` drop an entry early. Failed fetches are not cached.
import type { components } from "@aegispulse/contracts/generated/ts/openapi/registry.ts";
import type { InternalServiceClient } from "../http-client/index.js";

export type TenantSettings = components["schemas"]["Tenant"];

export const TENANT_SETTINGS_MAX_TTL_MS = 60_000;

export interface TenantSettingsCacheOptions {
  /** Fetches one tenant (default: `registry.getTenantSettings` with the caller's SERVICE token). */
  readonly fetch: (tenantId: string) => Promise<TenantSettings>;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class TenantSettingsCache {
  private readonly entries = new Map<string, { value: TenantSettings; expiresAt: number }>();
  private readonly inflight = new Map<string, Promise<TenantSettings>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(private readonly options: TenantSettingsCacheOptions) {
    this.ttlMs = Math.min(options.ttlMs ?? TENANT_SETTINGS_MAX_TTL_MS, TENANT_SETTINGS_MAX_TTL_MS);
    this.now = options.now ?? Date.now;
  }

  /** Backed by the registry internal action (callers need `registry.getTenantSettings` in their act[]). */
  static forRegistry(client: InternalServiceClient<"registry">, ttlMs?: number): TenantSettingsCache {
    return new TenantSettingsCache({
      fetch: (tenantId) =>
        client.invoke<"getTenantSettings", TenantSettings>("getTenantSettings", { tenantId }, { idempotent: true }),
      ...(ttlMs === undefined ? {} : { ttlMs }),
    });
  }

  async get(tenantId: string): Promise<TenantSettings> {
    const hit = this.entries.get(tenantId);
    if (hit !== undefined && this.now() < hit.expiresAt) return hit.value;
    let pending = this.inflight.get(tenantId);
    if (pending === undefined) {
      pending = this.options
        .fetch(tenantId)
        .then((value) => {
          this.entries.set(tenantId, { value, expiresAt: this.now() + this.ttlMs });
          return value;
        })
        .finally(() => this.inflight.delete(tenantId));
      this.inflight.set(tenantId, pending);
    }
    return pending;
  }

  invalidate(tenantId: string): void {
    this.entries.delete(tenantId);
  }
}
