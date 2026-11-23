// Gateway configuration (PROJECT.md §6.9, §10.4). The gateway holds no datastore clients (ADR-0002, NFR-09).
import type { z } from "zod";
import { jwtVerifyEnvSchema, platformEnvSchema } from "@aegispulse/ts-platform/config";

export const SERVICE = "gateway";
/** §5.4 port. */
export const PORT = 8080;
/** NFR-08: JSON APIs 256 KiB (webhook routes raise it to 1 MiB on their own route). */
export const JSON_BODY_LIMIT = 256 * 1024;

// Phase 1e verifies tokens only; SERVICE credentials join when the gateway first calls registry (Phase 2).
export const configSchema = platformEnvSchema.extend(jwtVerifyEnvSchema.shape);
export type Config = z.output<typeof configSchema>;

export const CONFIG = Symbol("CONFIG");
export const JWT_VERIFIER = Symbol("JWT_VERIFIER");
export const HEALTH = Symbol("HEALTH");
