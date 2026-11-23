// Health, readiness and lifecycle (NFR-11). Framework-agnostic: HTTP adapters map these results to
// GET /livez (process alive, never checks dependencies), GET /readyz (dependencies), GET /healthz (aggregate JSON).
// The lifecycle runs ordered shutdown hooks on SIGTERM within the grace budget and exits non-zero on fatal errors.
import { setTimeout as sleep } from "node:timers/promises";
import type { Logger } from "../logging/index.js";
import { describeError } from "../errors/index.js";
import { quoteSchema, type SqlExecutor } from "../outbox/sql.js";

export interface CheckResult {
  readonly name: string;
  readonly status: "up" | "down";
  readonly durationMs: number;
  /** Log-safe reason when down (no connection strings or secrets). */
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly ready: boolean;
  readonly phase: LifecyclePhase;
  readonly checks: readonly CheckResult[];
}

export type LifecyclePhase = "starting" | "running" | "stopping";

export type Check = () => Promise<void>;

interface RegisteredCheck {
  readonly name: string;
  readonly fn: Check;
  readonly timeoutMs: number;
}

export class HealthRegistry {
  private readonly checks: RegisteredCheck[] = [];
  private phase: LifecyclePhase = "starting";

  /** Readiness gates (NFR-11): config validated, datastore reachable, schema version, broker topology. */
  addCheck(name: string, fn: Check, options: { timeoutMs?: number } = {}): this {
    this.checks.push({ name, fn, timeoutMs: options.timeoutMs ?? 2_000 });
    return this;
  }

  markRunning(): void {
    if (this.phase === "starting") this.phase = "running";
  }

  markStopping(): void {
    this.phase = "stopping";
  }

  get currentPhase(): LifecyclePhase {
    return this.phase;
  }

  /** Liveness: the event loop answers. Never touches dependencies (avoids restart storms). */
  livez(): { readonly status: "ok" } {
    return { status: "ok" };
  }

  async readyz(): Promise<ReadinessReport> {
    const checks = await Promise.all(this.checks.map((c) => runCheck(c)));
    const ready = this.phase === "running" && checks.every((c) => c.status === "up");
    return { ready, phase: this.phase, checks };
  }

  /** Same data as readyz, for humans. */
  healthz(): Promise<ReadinessReport> {
    return this.readyz();
  }
}

async function runCheck(check: RegisteredCheck): Promise<CheckResult> {
  const started = performance.now();
  const timeout = AbortSignal.timeout(check.timeoutMs);
  try {
    await Promise.race([
      check.fn(),
      new Promise<never>((_, reject) => {
        timeout.addEventListener("abort", () => reject(new Error(`timed out after ${check.timeoutMs}ms`)), {
          once: true,
        });
      }),
    ]);
    return { name: check.name, status: "up", durationMs: Math.round(performance.now() - started) };
  } catch (error: unknown) {
    return {
      name: check.name,
      status: "down",
      durationMs: Math.round(performance.now() - started),
      detail: describeError(error, 200),
    };
  }
}

// ── Standard checks ───────────────────────────────────────────────────────────

export function postgresPingCheck(db: SqlExecutor): Check {
  return async () => {
    await db.query("SELECT 1");
  };
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Flyway history check (NFR-11 c): the newest successful migration in `schema` must be >= `minVersion`.
 * svc_* roles have SELECT on flyway_schema_history (afterMigrate callback, §7.0).
 */
export function flywaySchemaVersionCheck(db: SqlExecutor, schema: string, minVersion: string): Check {
  const table = `${quoteSchema(schema)}.flyway_schema_history`;
  return async () => {
    const res = await db.query<{ version: string | null }>(
      `SELECT version FROM ${table} WHERE success AND version IS NOT NULL`,
    );
    const versions = res.rows.map((r) => r.version).filter((v): v is string => v !== null);
    const newest = versions.sort(compareVersions).at(-1);
    if (newest === undefined) throw new Error(`no applied migrations in ${schema}`);
    if (compareVersions(newest, minVersion) < 0) {
      throw new Error(`schema ${schema} at V${newest}, need >= V${minVersion}`);
    }
  };
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Shutdown stages in NFR-11 order: stop accepting HTTP, cancel consumers and finish in-flight messages,
 * flush the outbox relay batch, flush telemetry, close pools.
 */
export const SHUTDOWN_STAGES = ["http", "consumers", "outbox", "telemetry", "pools"] as const;
export type ShutdownStage = (typeof SHUTDOWN_STAGES)[number];

export interface LifecycleOptions {
  readonly logger: Logger;
  readonly health?: HealthRegistry;
  /** Total budget; Kubernetes terminationGracePeriodSeconds is 30, so the default leaves headroom. */
  readonly graceMs?: number;
  /** Test hook. */
  readonly exit?: (code: number) => void;
}

export class Lifecycle {
  private readonly hooks = new Map<ShutdownStage, Array<{ name: string; fn: () => Promise<void> }>>();
  private shuttingDown: Promise<void> | undefined;
  private readonly exit: (code: number) => void;

  constructor(private readonly options: LifecycleOptions) {
    this.exit = options.exit ?? ((code) => process.exit(code));
  }

  onShutdown(stage: ShutdownStage, name: string, fn: () => Promise<void>): this {
    const list = this.hooks.get(stage) ?? [];
    list.push({ name, fn });
    this.hooks.set(stage, list);
    return this;
  }

  /** Runs every stage in order. Hooks within a stage run concurrently. Failures are logged, never skip later stages. */
  shutdown(reason: string): Promise<void> {
    this.shuttingDown ??= this.runShutdown(reason);
    return this.shuttingDown;
  }

  private async runShutdown(reason: string): Promise<void> {
    const { logger } = this.options;
    const deadline = Date.now() + (this.options.graceMs ?? 25_000);
    this.options.health?.markStopping();
    logger.info({ reason }, "shutdown started");
    for (const stage of SHUTDOWN_STAGES) {
      const hooks = this.hooks.get(stage) ?? [];
      const remaining = deadline - Date.now();
      if (hooks.length === 0) continue;
      if (remaining <= 0) {
        logger.error({ stage }, "shutdown grace exhausted; skipping remaining stages");
        break;
      }
      const results = await Promise.allSettled(
        hooks.map(async (h) => {
          let timer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              h.fn(),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${remaining}ms`)), remaining);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }),
      );
      results.forEach((r, i) => {
        if (r.status === "rejected") {
          logger.error({ stage, hook: hooks[i]?.name, err: describeError(r.reason) }, "shutdown hook failed");
        }
      });
    }
    logger.info("shutdown complete");
  }

  /** SIGTERM/SIGINT → ordered shutdown → exit 0. Fatal errors → log fatal → exit 1 (§6.8). */
  install(): this {
    const onSignal = (signal: NodeJS.Signals): void => {
      void this.shutdown(signal).then(
        () => this.exit(0),
        () => this.exit(1),
      );
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    process.on("unhandledRejection", (reason: unknown) => this.fatal("unhandledRejection", reason));
    process.on("uncaughtException", (error: unknown) => this.fatal("uncaughtException", error));
    return this;
  }

  private fatal(kind: string, error: unknown): void {
    this.options.logger.fatal({ kind, err: describeError(error) }, "fatal error; exiting");
    this.exit(1);
  }
}

/**
 * Startup dependency connect with backoff (NFR-11: startup order is not assumed; max 60 s, then fail).
 */
export async function connectWithRetry<T>(
  name: string,
  connect: () => Promise<T>,
  options: { logger: Logger; maxWaitMs?: number; initialDelayMs?: number; maxDelayMs?: number },
): Promise<T> {
  const deadline = Date.now() + (options.maxWaitMs ?? 60_000);
  let delay = options.initialDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await connect();
    } catch (error: unknown) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        options.logger.error(
          { dependency: name, attempt, err: describeError(error) },
          "dependency unavailable; giving up",
        );
        throw error;
      }
      options.logger.warn(
        { dependency: name, attempt, retryInMs: delay, err: describeError(error) },
        "dependency unavailable; retrying",
      );
      await sleep(Math.min(delay, remaining));
      delay = Math.min(delay * 2, options.maxDelayMs ?? 8_000);
    }
  }
}
