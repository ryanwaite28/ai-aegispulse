// Dispatch only: obtain the SERVICE token, call the job's one action with an empty payload, return the JobRunSummary.
import { ServiceTokenProvider } from "@aegispulse/ts-platform/auth";
import { InternalServiceClient } from "@aegispulse/ts-platform/http-client";
import type { Config } from "./config.js";
import type { JobDefinition } from "./jobs.js";

export interface JobRunSummary {
  readonly processedCount: number;
  /** cases-audit-verify only: chain verification outcome (a broken chain is reported via N-06, not an exit code). */
  readonly valid?: boolean;
  readonly firstBrokenSeq?: number;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export async function trigger(config: Config, job: JobDefinition): Promise<JobRunSummary> {
  const registry = new InternalServiceClient("registry", {
    name: "registry",
    baseUrl: config.REGISTRY_URL,
    timeoutMs: 15_000,
  });
  const tokens = new ServiceTokenProvider({
    clientId: config.SERVICE_CLIENT_ID,
    clientSecret: config.SERVICE_CLIENT_SECRET,
    issue: (input) =>
      registry.invoke<"issueClientCredentialsToken", { accessToken: string; expiresIn: number }>(
        "issueClientCredentialsToken",
        input,
      ),
  });
  const options = { baseUrl: job.baseUrl(config), timeoutMs: job.timeoutMs, serviceToken: tokens.token };
  try {
    // One typed client per owning service (the catalog is a discriminated union on `service`).
    switch (job.service) {
      case "ingestion": {
        const target = new InternalServiceClient("ingestion", { name: "ingestion", ...options });
        try {
          return await target.invoke<typeof job.action, JobRunSummary>(job.action, {});
        } finally {
          await target.close();
        }
      }
      case "files": {
        const target = new InternalServiceClient("files", { name: "files", ...options });
        try {
          return await target.invoke<typeof job.action, JobRunSummary>(job.action, {});
        } finally {
          await target.close();
        }
      }
      case "cases": {
        const target = new InternalServiceClient("cases", { name: "cases", ...options });
        try {
          if (job.action !== "verifyAuditChain") {
            return await target.invoke<typeof job.action, JobRunSummary>(job.action, {});
          }
          const v = await target.invoke<
            typeof job.action,
            { valid: boolean; checked: number; firstBrokenSeq?: number }
          >(job.action, {});
          return {
            processedCount: v.checked,
            valid: v.valid,
            ...(v.firstBrokenSeq === undefined ? {} : { firstBrokenSeq: v.firstBrokenSeq }),
          };
        } finally {
          await target.close();
        }
      }
    }
  } finally {
    await registry.close();
  }
}
