// ingestion configuration (PROJECT.md §6.9, §10.4): env only, validated once at startup.
import { z } from "zod";
import {
  authEnvSchema,
  amqpEnvSchema,
  objectStoreEnvSchema,
  platformEnvSchema,
  postgresEnvSchema,
  redisEnvSchema,
} from "@aegispulse/ts-platform/config";

export const SERVICE = "ingestion";
/** §5.4 port. */
export const PORT = 8081;

export const configSchema = platformEnvSchema
  .extend(amqpEnvSchema.shape)
  .extend(postgresEnvSchema.shape)
  .extend(redisEnvSchema.shape)
  .extend(objectStoreEnvSchema.shape)
  .extend(authEnvSchema.shape)
  .extend({
    // FR-WHK-01: KEK wrapping webhook-secret data keys (Infisical /ingestion; local: ensure-local-vars.sh)
    INGESTION_KEK_BASE64: z.string().min(1, "is required"),
    INGESTION_KEK_VERSION: z.coerce.number().int().min(1).default(1),
  });
export type Config = z.output<typeof configSchema>;
