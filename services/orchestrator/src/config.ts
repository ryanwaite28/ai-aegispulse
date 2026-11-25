// orchestrator configuration (PROJECT.md §6.9, §10.4): env only, validated once at startup.
import { z } from "zod";
import { amqpEnvSchema, authEnvSchema, platformEnvSchema } from "@aegispulse/ts-platform/config";

export const SERVICE = "orchestrator";
/** §5.4 port. */
export const PORT = 8090;

// AMQP + the orchestrator's own SERVICE credentials (svc-orchestrator, §5.7.4) + its callees.
export const configSchema = platformEnvSchema
  .extend(amqpEnvSchema.shape)
  .extend(authEnvSchema.shape)
  .extend({
    RISK_SCORING_URL: z.url().default("http://risk-scoring:8086"),
    CASES_URL: z.url().default("http://cases:8085"),
  });
export type Config = z.output<typeof configSchema>;
