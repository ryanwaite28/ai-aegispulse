// Archive retention (FR-EVT-03, FR-EVT-07 part 1). Pure.
import type { Tier } from "../db/archive.repository.js";

/** FR-TEN-01 default when no tenant applies (tenantless envelopes). */
export const DEFAULT_RETENTION_DAYS = 400;
/** Restricted records are kept 7 years regardless of tenant settings. */
export const RESTRICTED_RETENTION_YEARS = 7;

export function expireAt(archivedAt: Date, tier: Tier, retentionDays: number): Date {
  const at = new Date(archivedAt.getTime());
  if (tier === "restricted") {
    at.setUTCFullYear(at.getUTCFullYear() + RESTRICTED_RETENTION_YEARS);
    return at;
  }
  return new Date(at.getTime() + retentionDays * 86_400_000);
}
