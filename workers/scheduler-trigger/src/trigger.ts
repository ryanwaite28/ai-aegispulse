// Dispatch only: obtain the SERVICE token, call the job's one action with an empty payload, return the JobRunSummary.
import { ServiceTokenProvider } from "@aegispulse/ts-platform/auth";
import { InternalServiceClient } from "@aegispulse/ts-platform/http-client";
import type { Config } from "./config.js";
import type { JobDefinition } from "./jobs.js";

export interface JobRunSummary {
  readonly processedCount: number;
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
  const target = new InternalServiceClient(job.service, {
    name: job.service,
    baseUrl: job.baseUrl(config),
    timeoutMs: job.timeoutMs,
    serviceToken: tokens.token,
  });
  try {
    return await target.invoke<typeof job.action, JobRunSummary>(job.action, {});
  } finally {
    await target.close();
    await registry.close();
  }
}
