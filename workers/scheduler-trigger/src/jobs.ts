// Job catalog: one CronJob name → one internal action (§5.7.4 svc-scheduler-trigger allowlist). Jobs are added in
// the phase that delivers their action (PROJECT.md §11).
import type { Config } from "./config.js";

interface JobBase {
  readonly baseUrl: (config: Config) => string;
  /** Whole-call budget; maintenance actions may page through object listings. */
  readonly timeoutMs: number;
}

/** Discriminated on the owning service so the trigger can use that service's typed client. */
export type JobDefinition =
  | (JobBase & { readonly service: "ingestion"; readonly action: "expirePreviousSecrets" })
  | (JobBase & { readonly service: "files"; readonly action: "sweepOrphans" | "purgeRetention" })
  | (JobBase & { readonly service: "cases"; readonly action: "verifyAuditChain" });

export const JOBS = {
  /** FR-WHK-08, hourly: expire PREVIOUS webhook secrets + sweep orphan raw objects. */
  "ingestion-secret-expiry": {
    service: "ingestion",
    action: "expirePreviousSecrets",
    baseUrl: (c) => c.INGESTION_URL,
    timeoutMs: 300_000,
  },
  /** FR-FILE-10, every 15 min: INITIATED files older than 1 h → EXPIRED, objects deleted. */
  "files-orphan-sweep": {
    service: "files",
    action: "sweepOrphans",
    baseUrl: (c) => c.FILES_URL,
    timeoutMs: 300_000,
  },
  /** FR-FILE-12, daily: purge objects and artifacts past each tenant's retentionDays (tombstones kept). */
  "files-retention": {
    service: "files",
    action: "purgeRetention",
    baseUrl: (c) => c.FILES_URL,
    timeoutMs: 900_000,
  },
  /**
   * FR-AUD-03, nightly: verify every tenant's audit chain from its last verified seq; a broken chain emits
   * notification.requested N-06 (cases) and stays unverified. processedCount = entries checked.
   */
  "cases-audit-verify": {
    service: "cases",
    action: "verifyAuditChain",
    baseUrl: (c) => c.CASES_URL,
    timeoutMs: 900_000,
  },
} as const satisfies Record<string, JobDefinition>;

export type JobName = keyof typeof JOBS;

export function resolveJob(name: string | undefined): JobDefinition & { name: JobName } {
  if (name === undefined || !Object.hasOwn(JOBS, name)) {
    throw new UsageError(`unknown job ${JSON.stringify(name ?? "")}; known: ${Object.keys(JOBS).join(", ")}`);
  }
  const job = name as JobName;
  return { ...JOBS[job], name: job };
}

export class UsageError extends Error {}
