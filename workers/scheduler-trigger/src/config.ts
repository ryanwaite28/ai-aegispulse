// scheduler-trigger configuration (§10.4). Only what a one-shot caller needs: its SERVICE credentials, the registry
// (token endpoint) and the base URL of each service it triggers. No datastore settings exist here (ADR-0002).
import { z } from "zod";
import { platformEnvSchema, serviceCredentialsEnvSchema } from "@aegispulse/ts-platform/config";

export const SERVICE = "scheduler-trigger";

export const configSchema = platformEnvSchema.extend(serviceCredentialsEnvSchema.shape).extend({
  REGISTRY_URL: z.url(),
  INGESTION_URL: z.url().default("http://ingestion:8081"),
  FILES_URL: z.url().default("http://files:8082"),
  CASES_URL: z.url().default("http://cases:8085"),
});
export type Config = z.output<typeof configSchema>;
