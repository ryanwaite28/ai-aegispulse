// Gateway configuration (PROJECT.md §6.9, §10.4). The gateway holds no datastore clients (ADR-0002, NFR-09).
import { z } from "zod";
import { authEnvSchema, platformEnvSchema } from "@aegispulse/ts-platform/config";

export const SERVICE = "gateway";
/** §5.4 port. */
export const PORT = 8080;
/** NFR-08: JSON APIs 256 KiB (webhook routes raise it to 1 MiB on their own route). */
export const JSON_BODY_LIMIT = 256 * 1024;

// JWT verification + the gateway's own SERVICE credentials (svc-gateway: registry.login, registry.refreshToken,
// ingestion.ingestWebhookDelivery; §5.7.4).
export const configSchema = platformEnvSchema.extend(authEnvSchema.shape).extend({
  INGESTION_URL: z.url().default("http://ingestion:8081"),
  FILES_URL: z.url().default("http://files:8082"),
  EVENTS_URL: z.url().default("http://events:8083"),
  CASES_URL: z.url().default("http://cases:8085"),
});
export type Config = z.output<typeof configSchema>;

export const CONFIG = Symbol("CONFIG");
export const JWT_VERIFIER = Symbol("JWT_VERIFIER");
export const HEALTH = Symbol("HEALTH");
export const REGISTRY = Symbol("REGISTRY");
export const INGESTION = Symbol("INGESTION");
export const FILES = Symbol("FILES");
export const EVENTS = Symbol("EVENTS");
export const CASES = Symbol("CASES");

/** §6.5 per-call timeouts: registry 1 s is too short for Argon2id actions (queued up to 10 s by the registry). */
export const REGISTRY_TIMEOUT_MS = 3_000;
export const REGISTRY_AUTH_TIMEOUT_MS = 15_000;
