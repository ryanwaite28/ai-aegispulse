// expirePreviousSecrets (FR-WHK-08; spec FR-WHK-01-08 §2 "Expiry and sweep"). Called hourly by scheduler-trigger with
// its SERVICE token. Two steps, each safe to repeat:
//   1. delete PREVIOUS secrets past expires_at (definer, cross-tenant);
//   2. orphan sweep: list the last SWEEP_LOOKBACK_DAYS of raw/webhooks/{tenant}/{day}/ prefixes, keep objects older
//      than 1 h, ask the database which have no delivery row, delete only those.
// A raw object is written before its delivery transaction (FR-WHK-05), so an object younger than 1 h may still be
// committed; it is never a candidate. processedCount = secrets expired + objects deleted.
import type { Principal } from "@aegispulse/ts-platform/auth";
import { DomainError } from "@aegispulse/ts-platform/errors";
import type { Logger } from "@aegispulse/ts-platform/logging";
import type { SqlPool } from "@aegispulse/ts-platform/outbox";
import { isSweepCandidate, sweepPrefixes } from "../domain/raw-objects.js";
import type { WebhookMaintenanceRepository } from "../db/webhook-maintenance.repository.js";

export interface RawObject {
  readonly key: string;
  readonly lastModified: Date;
}

/** Port over ingestion's own raw/webhooks/ prefix in the raw bucket. */
export interface RawObjectSweeper {
  list(prefix: string): AsyncIterable<readonly RawObject[]>;
  delete(keys: readonly string[]): Promise<void>;
}

export interface JobRunSummary {
  readonly processedCount: number;
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface MaintenanceDeps {
  readonly pool: SqlPool;
  readonly repository: WebhookMaintenanceRepository;
  readonly objects: RawObjectSweeper;
  readonly logger: Logger;
  readonly now?: () => Date;
}

export class WebhookMaintenanceService {
  private readonly now: () => Date;

  constructor(private readonly deps: MaintenanceDeps) {
    this.now = deps.now ?? ((): Date => new Date());
  }

  async expirePreviousSecrets(principal: Principal): Promise<JobRunSummary> {
    if (principal.kind !== "service") {
      throw new DomainError("FORBIDDEN", "expirePreviousSecrets is a scheduled action");
    }
    const startedAt = this.now();
    const expired = await this.deps.repository.expirePreviousSecrets(this.deps.pool, startedAt);
    const orphans = await this.sweepOrphans(startedAt);
    const finishedAt = this.now();
    this.deps.logger.info(
      { secretsExpired: expired, orphansDeleted: orphans, durationMs: finishedAt.getTime() - startedAt.getTime() },
      "webhook maintenance run",
    );
    return {
      processedCount: expired + orphans,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    };
  }

  private async sweepOrphans(now: Date): Promise<number> {
    let deleted = 0;
    for (const tenantId of await this.deps.repository.sourceTenants(this.deps.pool)) {
      for (const prefix of sweepPrefixes(tenantId, now)) {
        for await (const page of this.deps.objects.list(prefix)) {
          const candidates = page.filter((o) => isSweepCandidate(o.key, o.lastModified, now)).map((o) => o.key);
          const orphans = await this.deps.repository.unreferencedKeys(this.deps.pool, candidates);
          if (orphans.length > 0) {
            await this.deps.objects.delete(orphans);
            deleted += orphans.length;
          }
        }
      }
    }
    return deleted;
  }
}
