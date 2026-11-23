import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  amqpEnvSchema,
  authEnvSchema,
  ConfigError,
  envBoolean,
  envList,
  loadConfig,
  platformEnvSchema,
  postgresEnvSchema,
} from "./index.js";

const schema = platformEnvSchema.extend(postgresEnvSchema.shape).extend(amqpEnvSchema.shape).extend({
  FILES_AV_ENABLED: envBoolean,
  HIGH_RISK_COUNTRIES_DEFAULT: envList,
});

describe("loadConfig (PROJECT.md §6.9, NFR-11)", () => {
  it("parses a valid environment and applies defaults", () => {
    const cfg = loadConfig(schema, {
      AEGIS_ENV: "local",
      PG_HOST: "postgres",
      PG_DATABASE: "aegispulse",
      PG_USER: "svc_files",
      PG_PASSWORD: "pw",
      AMQP_URL: "amqp://svc_files:pw@rabbitmq:5672/aegispulse-local",
      FILES_AV_ENABLED: "true",
      HIGH_RISK_COUNTRIES_DEFAULT: "IR, KP,,SY",
      UNRELATED: "ignored",
    });
    expect(cfg).toMatchObject({
      AEGIS_ENV: "local",
      LOG_LEVEL: "info",
      PG_PORT: 5432,
      AMQP_PREFETCH_DEFAULT: 10,
      FILES_AV_ENABLED: true,
      HIGH_RISK_COUNTRIES_DEFAULT: ["IR", "KP", "SY"],
    });
  });

  it("reports every problem at once and never echoes values (secrets redacted)", () => {
    const secret = "amqp-secret-should-never-appear";
    let caught: unknown;
    try {
      loadConfig(schema, {
        AEGIS_ENV: "staging",
        PG_HOST: "",
        PG_DATABASE: "aegispulse",
        PG_USER: "postgres",
        PG_PORT: "99999",
        AMQP_URL: `http://user:${secret}@host`,
        FILES_AV_ENABLED: "maybe",
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const error = caught as ConfigError;
    const keys = error.issues.map((i) => i.key).sort();
    expect(keys).toEqual(
      [
        "AEGIS_ENV",
        "AMQP_URL",
        "FILES_AV_ENABLED",
        "HIGH_RISK_COUNTRIES_DEFAULT",
        "PG_HOST",
        "PG_PASSWORD",
        "PG_PORT",
        "PG_USER",
      ].sort(),
    );
    expect(error.issues.find((i) => i.key === "PG_HOST")?.problem).toBe("required"); // empty string counts as unset
    expect(error.issues.find((i) => i.key === "AEGIS_ENV")?.problem).toBe("must be one of local, dev, prod");
    const serialized = JSON.stringify({ message: error.message, issues: error.issues });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("staging");
    expect(serialized).not.toContain("99999");
  });

  it("validates the auth block", () => {
    expect(() =>
      loadConfig(authEnvSchema, {
        REGISTRY_URL: "http://registry:8084",
        JWT_ISSUER: "aegispulse-registry",
        JWT_AUDIENCE: "aegispulse",
        SERVICE_CLIENT_ID: "svc-files",
        SERVICE_CLIENT_SECRET: "short",
      }),
    ).toThrow(/SERVICE_CLIENT_SECRET \(too small/);
  });

  it("accepts custom schemas", () => {
    expect(loadConfig(z.object({ N: z.coerce.number().default(3) }), {})).toEqual({ N: 3 });
  });
});
