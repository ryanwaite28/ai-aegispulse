// /v1/files/uploads* (FR-FILE-01..04): transport only. The gateway forwards the caller's token, X-Aegis-Tenant and
// Idempotency-Key to files, maps init to 201 (new) or 200 (dedup hit), and validates the path id locally.
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JwtVerifier } from "@aegispulse/ts-platform/auth";
import { HealthRegistry } from "@aegispulse/ts-platform/health";
import { createLogger } from "@aegispulse/ts-platform/logging";
import type { Config } from "../config.js";
import { createGateway } from "../main.js";

const FILE_ID = "0b6f3c1e-2f4a-4c55-9d2e-6a7b8c9d0e1f";
const TENANT = "8a92269a-91aa-4d80-b6fd-093a350304fe";
let fake: Server;
let app: Awaited<ReturnType<typeof createGateway>>;
let token: string;
let deduplicated = false;
let seen: {
  path: string;
  auth?: string | undefined;
  tenant?: string | undefined;
  idem?: string | undefined;
  body: Record<string, unknown>;
}[] = [];

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const h = (n: string): string | undefined => (typeof req.headers[n] === "string" ? req.headers[n] : undefined);
      seen.push({
        path: req.url ?? "",
        ...(h("authorization") === undefined ? {} : { auth: h("authorization") }),
        ...(h("x-aegis-tenant") === undefined ? {} : { tenant: h("x-aegis-tenant") }),
        ...(h("idempotency-key") === undefined ? {} : { idem: h("idempotency-key") }),
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });
      const data =
        req.url === "/internal/v1/initUpload"
          ? { fileId: FILE_ID, status: "INITIATED", deduplicated }
          : { id: FILE_ID, status: "UPLOADED" };
      res.writeHead(deduplicated || req.url !== "/internal/v1/initUpload" ? 200 : 201, {
        "content-type": "application/json",
      });
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
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  const verifier = new JwtVerifier({ jwks, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });
  token = await new SignJWT({ typ: "user", tid: "t-1", tslug: "acme", roles: ["PLATFORM_ADMIN"] })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject("u-1")
    .setJti("j-1")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  const logger = createLogger({
    service: "gateway",
    version: "test",
    env: "local",
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  app = await createGateway(config, verifier, new HealthRegistry(), logger);
});

afterAll(async () => {
  await app.close();
  fake.closeAllConnections();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  deduplicated = false;
});

const post = (
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; json: () => unknown }> =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

describe("files upload routes over the gateway (FR-FILE-01..04)", () => {
  it("init forwards token, X-Aegis-Tenant and Idempotency-Key; 201 for a new upload, 200 for a dedup hit", async () => {
    const input = {
      filename: "a.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      sha256: "a".repeat(64),
      purpose: "FILING",
    };
    const created = await post("/v1/files/uploads/init", input, { "x-aegis-tenant": TENANT, "idempotency-key": "k-1" });
    expect(created.statusCode).toBe(201);
    expect(seen[0]).toEqual({
      path: "/internal/v1/initUpload",
      auth: `Bearer ${token}`,
      tenant: TENANT,
      idem: "k-1",
      body: input,
    });
    deduplicated = true;
    const dup = await post("/v1/files/uploads/init", input, { "x-aegis-tenant": TENANT });
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ data: { fileId: FILE_ID, deduplicated: true } });
  });

  it("complete/abort send the path id (no body needed); a malformed id is a local 404 (uuidParam convention)", async () => {
    expect(
      (await post(`/v1/files/uploads/${FILE_ID}/complete`, undefined, { "x-aegis-tenant": TENANT })).statusCode,
    ).toBe(200);
    expect((await post(`/v1/files/uploads/${FILE_ID}/abort`, undefined, { "x-aegis-tenant": TENANT })).statusCode).toBe(
      200,
    );
    expect(seen.map((s) => [s.path, s.body])).toEqual([
      ["/internal/v1/completeUpload", { fileId: FILE_ID }],
      ["/internal/v1/abortUpload", { fileId: FILE_ID }],
    ]);
    expect((await post("/v1/files/uploads/not-a-uuid/complete")).statusCode).toBe(404);
    expect(seen).toHaveLength(2);
  });
});
