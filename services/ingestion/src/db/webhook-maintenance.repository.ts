// FR-WHK-08 maintenance queries. All cross-tenant work goes through the V5 SECURITY DEFINER functions (ADR-0016);
// nothing here sets a tenant context or touches another schema.
import type { SqlExecutor } from "@aegispulse/ts-platform/outbox";

export class WebhookMaintenanceRepository {
  async expirePreviousSecrets(db: SqlExecutor, now: Date): Promise<number> {
    const r = await db.query<{ n: number }>("SELECT ingestion.expire_previous_webhook_secrets($1) AS n", [now]);
    return r.rows[0]?.n ?? 0;
  }

  async sourceTenants(db: SqlExecutor): Promise<string[]> {
    const r = await db.query<{ t: string }>("SELECT t FROM ingestion.webhook_source_tenants() AS t");
    return r.rows.map((row) => row.t);
  }

  async unreferencedKeys(db: SqlExecutor, keys: readonly string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const r = await db.query<{ k: string }>("SELECT k FROM ingestion.unreferenced_raw_keys($1::text[]) AS k", [keys]);
    return r.rows.map((row) => row.k);
  }
}
