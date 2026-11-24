// retentionDays from the registry (FR-TEN-08 via the kit's ≤ 60 s cache). Archiving never fails on this lookup:
// tenantless envelopes and the reserved platform tenant (FR-TEN-09, which getTenantSettings refuses with 404) use the
// default; any other tenant unknown to the registry also gets the default, with a warning.
import { PLATFORM_TENANT_ID } from "@aegispulse/ts-platform/auth";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";
import { DEFAULT_RETENTION_DAYS } from "../domain/retention.js";
import type { TenantRetentionPort } from "../service/archive.service.js";

export class RegistryTenantRetention implements TenantRetentionPort {
  constructor(
    private readonly settings: Pick<TenantSettingsCache, "get">,
    private readonly logger: Logger,
  ) {}

  async retentionDays(tenantId: string | null): Promise<number> {
    if (tenantId === null || tenantId === PLATFORM_TENANT_ID) return DEFAULT_RETENTION_DAYS;
    try {
      return (await this.settings.get(tenantId)).retentionDays;
    } catch (error: unknown) {
      if ((error as { code?: string }).code !== "NOT_FOUND") throw error; // registry down → retry tiers
      this.logger.warn({ tenantId }, "tenant unknown to the registry; archiving with the default retention");
      return DEFAULT_RETENTION_DAYS;
    }
  }
}
