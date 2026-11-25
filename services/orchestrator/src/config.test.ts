import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import { configSchema, PORT } from "./config.js";

const valid = {
  AEGIS_ENV: "local",
  AMQP_URL: "amqp://svc_orchestrator:pw@rabbitmq:5672/aegispulse-local",
  REGISTRY_URL: "http://registry:8084",
  JWT_ISSUER: "aegispulse-registry",
  JWT_AUDIENCE: "aegispulse",
  SERVICE_CLIENT_ID: "svc-orchestrator",
  SERVICE_CLIENT_SECRET: "x".repeat(32),
};

describe("orchestrator config (§6.9, §10.4, NFR-11)", () => {
  it("accepts the documented variables and uses the §5.4 port", () => {
    expect(loadConfig(configSchema, valid).AEGIS_ENV).toBe("local");
    expect(PORT).toBe(8090);
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
