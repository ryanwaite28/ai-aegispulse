// ingestion configuration (PROJECT.md §6.9, §10.4): env only, validated once at startup.
import type { z } from "zod";
import {
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
  .extend(objectStoreEnvSchema.shape);
export type Config = z.output<typeof configSchema>;
