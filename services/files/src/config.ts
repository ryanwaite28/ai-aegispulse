// files configuration (PROJECT.md §6.9, §10.4): env only, validated once at startup.
import { z } from "zod";
import {
  amqpEnvSchema,
  envBoolean,
  objectStoreEnvSchema,
  platformEnvSchema,
  postgresEnvSchema,
  redisEnvSchema,
} from "@aegispulse/ts-platform/config";

export const SERVICE = "files";
/** §5.4 port. */
export const PORT = 8082;

export const configSchema = platformEnvSchema
  .extend(amqpEnvSchema.shape)
  .extend(postgresEnvSchema.shape)
  .extend(redisEnvSchema.shape)
  .extend(objectStoreEnvSchema.shape)
  .extend({
    FILES_AV_ENABLED: envBoolean.default(true),
    CLAMAV_HOST: z.string().min(1),
  });
export type Config = z.output<typeof configSchema>;
