import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import { configSchema, PORT } from "./config.js";

const valid = {
  AEGIS_ENV: "local",
  AMQP_URL: "amqp://svc_ingestion:pw@rabbitmq:5672/aegispulse-local",
  PG_HOST: "postgres",
  PG_DATABASE: "aegispulse",
  PG_USER: "svc_ingestion",
  PG_PASSWORD: "pw",
  REDIS_URL: "redis://ingestion:pw@redis:6379/0",
  S3_ENDPOINT: "http://objectstore:8333",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
  S3_BUCKET_PREFIX: "aegispulse-local",
};

describe("ingestion config (§6.9, §10.4, NFR-11)", () => {
  it("accepts the documented variables and uses the §5.4 port", () => {
    expect(loadConfig(configSchema, valid).AEGIS_ENV).toBe("local");
    expect(PORT).toBe(8081);
  });

  it("refuses to start with missing configuration, naming every key and no values", () => {
    let caught: unknown;
    try {
      loadConfig(configSchema, { AEGIS_ENV: "staging", AMQP_URL: "http://svc:topsecret@x" });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const keys = (caught as ConfigError).issues.map((i) => i.key);
    expect(keys).toContain("AEGIS_ENV");
    expect(keys).toContain("AMQP_URL");
    expect(JSON.stringify((caught as ConfigError).issues)).not.toContain("topsecret");
  });
});
