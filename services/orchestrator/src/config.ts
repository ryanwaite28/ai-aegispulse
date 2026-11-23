// orchestrator configuration (PROJECT.md §6.9, §10.4): env only, validated once at startup.
import type { z } from "zod";
import { amqpEnvSchema, platformEnvSchema } from "@aegispulse/ts-platform/config";

export const SERVICE = "orchestrator";
/** §5.4 port. */
export const PORT = 8090;

export const configSchema = platformEnvSchema.extend(amqpEnvSchema.shape);
export type Config = z.output<typeof configSchema>;
