// events configuration (PROJECT.md §6.9, §10.4): env only, validated once at startup.
import type { z } from "zod";
import {
  amqpEnvSchema,
  authEnvSchema,
  mongoEnvSchema,
  objectStoreEnvSchema,
  platformEnvSchema,
} from "@aegispulse/ts-platform/config";

export const SERVICE = "events";
/** §5.4 port. */
export const PORT = 8083;

export const configSchema = platformEnvSchema
  .extend(amqpEnvSchema.shape)
  .extend(objectStoreEnvSchema.shape)
  .extend(mongoEnvSchema.shape)
  .extend(authEnvSchema.shape);
export type Config = z.output<typeof configSchema>;
