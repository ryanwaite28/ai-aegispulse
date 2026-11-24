// Job catalog: one CronJob name → one internal action (§5.7.4 svc-scheduler-trigger allowlist). Jobs are added in
// the phase that delivers their action (PROJECT.md §11).
import type { Config } from "./config.js";

export interface JobDefinition {
  readonly service: "ingestion";
  readonly action: "expirePreviousSecrets";
  readonly baseUrl: (config: Config) => string;
  /** Whole-call budget; maintenance actions may page through object listings. */
  readonly timeoutMs: number;
}

export const JOBS = {
  /** FR-WHK-08, hourly: expire PREVIOUS webhook secrets + sweep orphan raw objects. */
  "ingestion-secret-expiry": {
    service: "ingestion",
    action: "expirePreviousSecrets",
    baseUrl: (c) => c.INGESTION_URL,
    timeoutMs: 300_000,
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
