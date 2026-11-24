// Raw webhook object keys (§7.8 `raw/webhooks/{tenantId}/{yyyy}/{mm}/{dd}/{uuid}.json`) and the FR-WHK-08 orphan rule.
// Pure; no I/O.

/** FR-WHK-08: an object with no delivery row is an orphan once it is older than this. */
export const ORPHAN_MIN_AGE_MS = 3600 * 1000;
/** Days of key prefixes each sweep lists (UTC, today included); bounds listing cost while tolerating job outages. */
export const SWEEP_LOOKBACK_DAYS = 7;

function dayPath(at: Date): string {
  return at.toISOString().slice(0, 10).replaceAll("-", "/");
}

export function rawWebhookKey(tenantId: string, at: Date, objectId: string): string {
  return `raw/webhooks/${tenantId}/${dayPath(at)}/${objectId}.json`;
}

/** The day prefixes one sweep lists for a tenant, newest first. */
export function sweepPrefixes(tenantId: string, now: Date, days = SWEEP_LOOKBACK_DAYS): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) {
    out.push(`raw/webhooks/${tenantId}/${dayPath(new Date(now.getTime() - i * 86_400_000))}/`);
  }
  return out;
}

/** Only keys this service writes, and only objects past the minimum age, are candidates. */
export function isSweepCandidate(key: string, lastModified: Date, now: Date): boolean {
  return (
    /^raw\/webhooks\/[0-9a-f-]{36}\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f-]{36}\.json$/.test(key) &&
    now.getTime() - lastModified.getTime() > ORPHAN_MIN_AGE_MS
  );
}
