import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "@aegispulse/ts-platform/config";
import { configSchema } from "./config.js";
import { JOBS, resolveJob, UsageError } from "./jobs.js";

const SEED = new URL(
  "../../../services/registry/src/main/resources/db/migration/R__seed_service_accounts.sql",
  import.meta.url,
);

describe("scheduler-trigger job catalog (§5.1, §5.7.4)", () => {
  it("FR-WHK-08 maps ingestion-secret-expiry to ingestion.expirePreviousSecrets", () => {
    const job = resolveJob("ingestion-secret-expiry");
    expect(`${job.service}.${job.action}`).toBe("ingestion.expirePreviousSecrets");
    const config = loadConfig(configSchema, {
      AEGIS_ENV: "local",
      REGISTRY_URL: "http://registry:8084",
      SERVICE_CLIENT_ID: "svc-scheduler-trigger",
      SERVICE_CLIENT_SECRET: "0".repeat(32),
    });
    expect(job.baseUrl(config)).toBe("http://ingestion:8081");
  });

  it("every job's action is on svc-scheduler-trigger's registry allowlist", () => {
    const seed = readFileSync(SEED, "utf8");
    const row = /\('svc-scheduler-trigger'[\s\S]*?ARRAY\[([\s\S]*?)\]\)/.exec(seed)?.[1] ?? "";
    for (const job of Object.values(JOBS)) expect(row).toContain(`'${job.service}.${job.action}'`);
  });

  it("FR-FILE-10/12 maps the files jobs to files.sweepOrphans / files.purgeRetention", () => {
    expect(`${resolveJob("files-orphan-sweep").service}.${resolveJob("files-orphan-sweep").action}`).toBe(
      "files.sweepOrphans",
    );
    expect(`${resolveJob("files-retention").service}.${resolveJob("files-retention").action}`).toBe(
      "files.purgeRetention",
    );
  });

  it("refuses unknown jobs (usage error, exit 2)", () => {
    expect(() => resolveJob("drop-everything")).toThrow(UsageError);
    expect(() => resolveJob(undefined)).toThrow(UsageError);
    expect(() => resolveJob("toString")).toThrow(UsageError); // no prototype keys
  });
});
