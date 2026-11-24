// Webhook source model (§7.2, FR-WHK-01/07). Pure types and rules; no I/O.
import { DomainError } from "@aegispulse/ts-platform/errors";

export type TrustLevel = "TRUSTED" | "UNTRUSTED";
export type SourceStatus = "ACTIVE" | "DISABLED";
export type SecretSlot = "CURRENT" | "PREVIOUS";

export interface WebhookSource {
  readonly id: string;
  readonly tenantId: string;
  readonly sourceKey: string;
  readonly displayName: string;
  readonly trustLevel: TrustLevel;
  readonly payloadProfile: "AEGIS_MARKET_EVENT_V1";
  readonly allowedAttachmentHosts: readonly string[];
  readonly status: SourceStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** FR-WHK-07: PREVIOUS secret stays valid 72 h after a rotation. */
export const PREVIOUS_SECRET_TTL_MS = 72 * 3600 * 1000;

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** allowedAttachmentHosts: bare hostnames only (no scheme, port or path), lower-cased, de-duplicated, sorted. */
export function normalizeHosts(hosts: readonly string[] | undefined): string[] {
  const out = new Set<string>();
  for (const raw of hosts ?? []) {
    const host = raw.trim().toLowerCase();
    if (!HOSTNAME.test(host)) {
      throw new DomainError("VALIDATION_ERROR", "request failed validation", {
        details: [{ field: "allowedAttachmentHosts", message: "must be bare hostnames (no scheme, port or path)" }],
      });
    }
    out.add(host);
  }
  return [...out].sort();
}
