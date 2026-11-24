// POST /webhooks/{sourceKey} (FR-WHK-02, NFR-08): the gateway forwards the raw bytes unparsed (even malformed JSON,
// which ingestion rejects only after the signature check), uses its own SERVICE token, allows 1 MiB on this route
// only, and still parses every other JSON route strictly. A real local HTTP server plays registry + ingestion.
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JwtVerifier } from "@aegispulse/ts-platform/auth";
import { HealthRegistry } from "@aegispulse/ts-platform/health";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { IngestionClient } from "../clients/ingestion.client.js";
import { RegistryClient } from "../clients/registry.client.js";
import type { Config } from "../config.js";
import { createGateway } from "../main.js";

let fake: Server;
let app: Awaited<ReturnType<typeof createGateway>>;
let seen: { path: string; auth: string | undefined; body: Record<string, unknown> }[] = [];

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      res.writeHead(req.url === "/internal/v1/ingestWebhookDelivery" ? 202 : 200, {
        "content-type": "application/json",
      });
      const data =
        req.url === "/internal/v1/issueClientCredentialsToken"
          ? { accessToken: "gw.token", tokenType: "Bearer", expiresIn: 900 }
          : { deliveryId: "4b1f0000-0000-4000-8000-000000000001", eventId: null, duplicate: true };
      res.end(JSON.stringify({ data, meta: {} }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((fake.address() as AddressInfo).port)}`;
  const config = {
    AEGIS_ENV: "local",
    LOG_LEVEL: "info",
    OTEL_SERVICE_NAMESPACE: "aegispulse",
    REGISTRY_URL: url,
    INGESTION_URL: url,
    FILES_URL: url,
    JWT_ISSUER: "aegispulse-registry",
    JWT_AUDIENCE: "aegispulse",
    SERVICE_CLIENT_ID: "svc-gateway",
    SERVICE_CLIENT_SECRET: randomBytes(16).toString("hex"),
  } as Config;
  const { publicKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  const verifier = new JwtVerifier({ jwks, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });
  const logger = createLogger({
    service: "gateway",
    version: "test",
    env: "local",
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  const registry = new RegistryClient(config);
  app = await createGateway(
    config,
    verifier,
    new HealthRegistry(),
    logger,
    registry,
    new IngestionClient(config, registry.gatewayToken),
  );
});

afterAll(async () => {
  await app.close();
  fake.closeAllConnections();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
});

const post = (
  url: string,
  payload: string | Buffer,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number }> =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: "POST", url, payload, headers: { "content-type": "application/json", ...headers } });

describe("POST /webhooks/{sourceKey} (FR-WHK-02)", () => {
  it("forwards the exact raw bytes (even malformed JSON), the three headers and the gateway's SERVICE token", async () => {
    const raw = '{"externalId": "x",   "title":"spacing kept" ,}'; // malformed on purpose
    const res = await post("/webhooks/acme-wire", raw, {
      "x-aegis-signature": "v1=" + "a".repeat(64),
      "x-aegis-timestamp": "1764000000",
      "x-aegis-delivery-id": "d-1",
      authorization: "Bearer should-not-be-forwarded",
    });
    expect(res.statusCode).toBe(202);
    const call = seen.find((s) => s.path === "/internal/v1/ingestWebhookDelivery");
    expect(call?.auth).toBe("Bearer gw.token");
    expect(Buffer.from(String(call?.body["rawBodyBase64"]), "base64").toString("utf8")).toBe(raw);
    expect(call?.body["headers"]).toEqual({
      "X-Aegis-Signature": "v1=" + "a".repeat(64),
      "X-Aegis-Timestamp": "1764000000",
      "X-Aegis-Delivery-Id": "d-1",
    });
    expect(call?.body["sourceKey"]).toBe("acme-wire");
  });

  it("allows 1 MiB on the webhook route only; other JSON routes keep 256 KiB and strict parsing", async () => {
    const big = Buffer.alloc(900 * 1024, 0x20);
    expect((await post("/webhooks/acme-wire", big)).statusCode).toBe(202);
    expect((await post("/webhooks/acme-wire", Buffer.alloc(1024 * 1024 + 1, 0x20))).statusCode).toBe(413);
    expect((await post("/v1/auth/login", Buffer.alloc(300 * 1024, 0x20))).statusCode).toBe(413);
    const malformed = await post("/v1/auth/login", "{nope");
    expect(malformed.statusCode).toBe(400);
    expect(seen.some((s) => s.path === "/internal/v1/login")).toBe(false);
  });

  it("rejects an invalid source key locally and non-JSON bodies without calling ingestion", async () => {
    expect((await post("/webhooks/BAD_KEY", "{}")).statusCode).toBe(404);
    const text = await app
      .getHttpAdapter()
      .getInstance()
      .inject({ method: "POST", url: "/webhooks/acme-wire", payload: "hi", headers: { "content-type": "text/plain" } });
    expect(text.statusCode).toBe(400);
    expect(seen.filter((s) => s.path === "/internal/v1/ingestWebhookDelivery")).toHaveLength(0);
  });
});
