// Typed configuration loader (PROJECT.md §6.9, NFR-11): env vars only, parsed once at startup by a Zod schema.
// Every problem is reported in one structured error. Values are NEVER echoed, so secrets cannot leak.
import { z } from "zod";

export interface ConfigIssue {
  readonly key: string;
  readonly problem: string;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    super(`invalid configuration: ${issues.map((i) => `${i.key} (${i.problem})`).join("; ")}`);
    this.issues = issues;
  }
}

function describeIssue(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined ? "required" : `expected ${issue.expected}`;
    case "invalid_value":
      return `must be one of ${issue.values.map((v) => String(v)).join(", ")}`;
    case "too_small":
      return `too small (minimum ${String(issue.minimum)})`;
    case "too_big":
      return `too large (maximum ${String(issue.maximum)})`;
    case "invalid_format":
      return `invalid ${issue.format}`;
    default:
      // Custom refinements carry author-written messages that never include the value.
      return issue.message;
  }
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Parses `env` with `schema`. Empty strings count as unset. Throws ConfigError listing every problem
 * (key + problem, never the value). Callers log it and exit non-zero.
 */
export function loadConfig<S extends z.ZodObject>(schema: S, env: EnvSource = process.env): z.output<S> {
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key];
    if (value !== undefined && value !== "") cleaned[key] = value;
  }
  const parsed = schema.safeParse(cleaned, { reportInput: false });
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => ({
    key: issue.path.map(String).join(".") || "(root)",
    problem: describeIssue(issue),
  }));
  throw new ConfigError(issues);
}

// ── Reusable field builders ───────────────────────────────────────────────────

/** "true"/"false" (also 1/0, yes/no). */
export const envBoolean = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

/** Integer with optional bounds (coerced from the env string). */
export function envInt(opts: { min?: number; max?: number } = {}): z.ZodCoercedNumber<unknown> {
  let schema = z.coerce.number().int();
  if (opts.min !== undefined) schema = schema.min(opts.min);
  if (opts.max !== undefined) schema = schema.max(opts.max);
  return schema;
}

export const envUrl = z.url();

/** Comma-separated list, trimmed, empty entries dropped. */
export const envList = z.string().transform((v) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

// ── Platform-wide variables (PROJECT.md §10.4, "global") ──────────────────────

export const AEGIS_ENVS = ["local", "dev", "prod"] as const;
export type AegisEnv = (typeof AEGIS_ENVS)[number];

export const platformEnvSchema = z.object({
  AEGIS_ENV: z.enum(AEGIS_ENVS),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  OTEL_SERVICE_NAMESPACE: z.string().default("aegispulse"),
});

export const amqpEnvSchema = z.object({
  AMQP_URL: z.string().regex(/^amqps?:\/\//, "must be an amqp:// or amqps:// URL"),
  AMQP_PREFETCH_DEFAULT: envInt({ min: 1, max: 1000 }).default(10),
});

export const postgresEnvSchema = z.object({
  PG_HOST: z.string().min(1),
  PG_PORT: envInt({ min: 1, max: 65535 }).default(5432),
  PG_DATABASE: z.string().min(1),
  PG_USER: z.string().regex(/^svc_[a-z_]+$/, "must be a svc_* runtime role"),
  PG_PASSWORD: z.string().min(1),
});

/** Token verification (every runtime that serves authenticated routes; FR-AUTH-05). */
export const jwtVerifyEnvSchema = z.object({
  REGISTRY_URL: envUrl,
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
});

/** The runtime's own SERVICE credentials (FR-TEN-07); needed once it calls another service's internal actions. */
export const serviceCredentialsEnvSchema = z.object({
  SERVICE_CLIENT_ID: z.string().regex(/^svc-[a-z-]+$/, "must look like svc-<runtime>"),
  SERVICE_CLIENT_SECRET: z.string().min(16, "must be at least 16 characters"),
});

export const authEnvSchema = jwtVerifyEnvSchema.extend(serviceCredentialsEnvSchema.shape);

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().regex(/^rediss?:\/\//, "must be a redis:// or rediss:// URL"),
});

export const objectStoreEnvSchema = z.object({
  S3_ENDPOINT: envUrl,
  S3_REGION: z.string().min(1),
  S3_FORCE_PATH_STYLE: envBoolean.default(true),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_PREFIX: z.string().regex(/^aegispulse-(local|dev|prod)$/, "must be aegispulse-{env}"),
});

export const mongoEnvSchema = z.object({
  MONGO_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, "must be a mongodb:// URI"),
});
