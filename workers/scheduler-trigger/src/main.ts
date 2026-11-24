// scheduler-trigger CLI: `node dist/main.js <job>`. Exit 0 on success, 1 on a failed call, 2 on usage/config errors,
// so the CronJob's status (and its failed-jobs history) reflects the action's outcome.
import { buildVersion } from "@aegispulse/ts-platform/build-info";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { configSchema, SERVICE } from "./config.js";
import { resolveJob, UsageError } from "./jobs.js";
import { trigger } from "./trigger.js";

async function main(): Promise<number> {
  let config;
  let job;
  try {
    config = loadConfig(configSchema);
    job = resolveJob(process.argv[2]);
  } catch (error: unknown) {
    const detail = error instanceof ConfigError ? { issues: error.issues } : { err: String(error) };
    process.stderr.write(
      `${JSON.stringify({ service: SERVICE, msg: "scheduler-trigger refused to run", ...detail })}\n`,
    );
    return error instanceof ConfigError || error instanceof UsageError ? 2 : 1;
  }
  const logger = createLogger({
    service: SERVICE,
    version: buildVersion(),
    env: config.AEGIS_ENV,
    level: config.LOG_LEVEL,
  });
  const started = Date.now();
  try {
    const summary = await trigger(config, job);
    logger.info(
      { job: job.name, action: `${job.service}.${job.action}`, summary, durationMs: Date.now() - started },
      "job succeeded",
    );
    return 0;
  } catch (error: unknown) {
    const e = error as { code?: string; status?: number; message?: string };
    logger.error(
      {
        job: job.name,
        action: `${job.service}.${job.action}`,
        code: e.code,
        status: e.status,
        err: e.message,
        durationMs: Date.now() - started,
      },
      "job failed",
    );
    return 1;
  }
}

process.exitCode = await main();
