import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import { configSchema, PORT } from "./config.js";

const valid = {
  AEGIS_ENV: "local",
  AMQP_URL: "amqp://svc_events:pw@rabbitmq:5672/aegispulse-local",
  S3_ENDPOINT: "http://objectstore:8333",
  S3_REGION: "us-east-1",
  S3_ACCESS_KEY_ID: "k",
  S3_SECRET_ACCESS_KEY: "s",
  S3_BUCKET_PREFIX: "aegispulse-local",
  MONGO_URI: "mongodb://svc_events:pw@mongo:27017/aegispulse_events?replicaSet=rs0",
  REGISTRY_URL: "http://registry:8084",
  JWT_ISSUER: "aegispulse-registry",
  JWT_AUDIENCE: "aegispulse",
  SERVICE_CLIENT_ID: "svc-events",
  SERVICE_CLIENT_SECRET: "0".repeat(32),
};

describe("events config (§6.9, §10.4, NFR-11)", () => {
  it("accepts the documented variables and uses the §5.4 port", () => {
    expect(loadConfig(configSchema, valid).AEGIS_ENV).toBe("local");
    expect(PORT).toBe(8083);
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
