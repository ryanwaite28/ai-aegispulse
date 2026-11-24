// Gateway ↔ registry (Phase 2c): a real local HTTP server plays the registry (no HTTP mocking). Proves the gateway is
// transport only: route roles come from the contract table, headers are forwarded, errors pass through unchanged.
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JwtVerifier } from "@aegispulse/ts-platform/auth";
import { HealthRegistry } from "@aegispulse/ts-platform/health";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { RegistryClient } from "../clients/registry.client.js";
import type { Config } from "../config.js";
import { createGateway } from "../main.js";

interface Seen {
  path: string;
  auth: string | undefined;
  tenant: string | undefined;
  idem: string | undefined;
  body: Record<string, unknown>;
}
let seen: Seen[] = [];
let reply: (path: string) => { status: number; body: unknown; headers?: Record<string, string> } = () => ({
  status: 200,
  body: { data: {}, meta: {} },
});
let fake: Server;
let app: Awaited<ReturnType<typeof createGateway>>;
let sign: (roles: string[], typ?: string) => Promise<string>;

const header = (req: IncomingMessage, name: string): string | undefined => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
};

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const path = req.url ?? "";
      if (path === "/internal/v1/issueClientCredentialsToken") {
        seen.push({
          path,
          auth: undefined,
          tenant: undefined,
          idem: undefined,
          body: JSON.parse(raw) as Record<string, unknown>,
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: { accessToken: "gateway.service.token", tokenType: "Bearer", expiresIn: 900 },
            meta: {},
          }),
        );
        return;
      }
      seen.push({
        path,
        auth: header(req, "authorization"),
        tenant: header(req, "x-aegis-tenant"),
        idem: header(req, "idempotency-key"),
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });
      const r = reply(path);
      res.writeHead(r.status, { "content-type": "application/json", ...r.headers });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const config = {
    AEGIS_ENV: "local",
    LOG_LEVEL: "info",
    OTEL_SERVICE_NAMESPACE: "aegispulse",
    REGISTRY_URL: `http://127.0.0.1:${String((fake.address() as AddressInfo).port)}`,
    JWT_ISSUER: "aegispulse-registry",
    JWT_AUDIENCE: "aegispulse",
    INGESTION_URL: "http://ingestion:8081",
    FILES_URL: "http://files:8082",
    SERVICE_CLIENT_ID: "svc-gateway",
    SERVICE_CLIENT_SECRET: randomBytes(16).toString("hex"), // generated per run; never a literal
  } as Config;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  const verifier = new JwtVerifier({ jwks, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });
  sign = (roles, typ = "user") =>
    new SignJWT({ typ, tid: "t-1", tslug: "acme", roles })
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(config.JWT_ISSUER)
      .setAudience(config.JWT_AUDIENCE)
      .setSubject("u-1")
      .setJti(`j-${String(Math.random())}`)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  const logger = createLogger({
    service: "gateway",
    version: "test",
    env: "local",
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  app = await createGateway(config, verifier, new HealthRegistry(), logger, new RegistryClient(config));
});

afterAll(async () => {
  await app.close();
  fake.closeAllConnections();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  reply = () => ({ status: 200, body: { data: { ok: true }, meta: { requestId: "registry-req" } } });
});

const inject = (opts: {
  method: string;
  url: string;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<{ statusCode: number; headers: Record<string, unknown>; json: () => unknown }> =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: opts.method as "GET",
      url: opts.url,
      headers: { ...(opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }), ...opts.headers },
      ...(opts.body === undefined ? {} : { payload: opts.body as Record<string, unknown> }),
    });

describe("gateway registry routes (Phase 2c, ADR-0002/0013)", () => {
  it("FR-AUTH-01 login is public and uses the gateway's own SERVICE token; the envelope is the gateway's", async () => {
    const res = await inject({
      method: "POST",
      url: "/v1/auth/login",
      body: { tenantSlug: "acme", email: "a@b.c", password: "x" },
    });
    expect(res.statusCode).toBe(200);
    expect(seen.map((s) => s.path)).toEqual(["/internal/v1/issueClientCredentialsToken", "/internal/v1/login"]);
    expect(seen[0]?.body).toMatchObject({ clientId: "svc-gateway", audience: "aegispulse-internal" });
    expect(seen[1]?.auth).toBe("Bearer gateway.service.token");
    const body = res.json() as { data: unknown; meta: { requestId?: string } };
    expect(body.data).toEqual({ ok: true });
    expect(body.meta.requestId).not.toBe("registry-req");
  });

  it("FR-AUTH-06 route roles come from the contract: denied roles never reach the registry", async () => {
    const res = await inject({
      method: "POST",
      url: "/v1/tenants",
      token: await sign(["TENANT_ADMIN"]),
      body: { slug: "x" },
    });
    expect(res.statusCode).toBe(403);
    expect(seen).toHaveLength(0);
    const sa = await inject({ method: "GET", url: "/v1/service-accounts", token: await sign(["PLATFORM_ADMIN"]) });
    expect(sa.statusCode).toBe(403); // §8.3: TENANT_ADMIN only
    const anon = await inject({ method: "GET", url: "/v1/users" });
    expect(anon.statusCode).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it("forwards the user token, X-Aegis-Tenant and Idempotency-Key only where the route declares them", async () => {
    const token = await sign(["PLATFORM_ADMIN"]);
    const tenant = "8f2a6a5e-3d1b-4c7e-9a0f-1b2c3d4e5f60";
    reply = () => ({ status: 201, body: { data: { id: "u-2" }, meta: {} } });
    const res = await inject({
      method: "POST",
      url: "/v1/users",
      token,
      headers: { "x-aegis-tenant": tenant, "idempotency-key": "k-1" },
      body: { email: "a@b.c" },
    });
    expect(res.statusCode).toBe(201);
    expect(seen[0]).toMatchObject({ path: "/internal/v1/createUser", auth: `Bearer ${token}`, tenant, idem: "k-1" });
    seen = [];
    await inject({
      method: "POST",
      url: "/v1/tenants",
      token,
      headers: { "x-aegis-tenant": tenant },
      body: { slug: "s" },
    });
    expect(seen[0]?.tenant).toBeUndefined(); // createTenant declares no X-Aegis-Tenant
    const bad = await inject({ method: "GET", url: "/v1/users", token, headers: { "x-aegis-tenant": "not-a-uuid" } });
    expect(bad.statusCode).toBe(422);
  });

  it("list routes map query strings and carry the registry's nextCursor", async () => {
    reply = () => ({ status: 200, body: { data: [{ id: "u-1" }], meta: { nextCursor: "abc_DEF" } } });
    const res = await inject({
      method: "GET",
      url: "/v1/users?limit=2&role=VIEWER",
      token: await sign(["TENANT_ADMIN"]),
    });
    expect(seen[0]?.body).toEqual({ limit: 2, role: "VIEWER" });
    expect((res.json() as { meta: { nextCursor?: string } }).meta.nextCursor).toBe("abc_DEF");
  });

  it("PATCH /v1/tenants/{id} selects settings or status by the contract's oneOf body", async () => {
    const token = await sign(["PLATFORM_ADMIN"]);
    const id = "8f2a6a5e-3d1b-4c7e-9a0f-1b2c3d4e5f60";
    await inject({ method: "PATCH", url: `/v1/tenants/${id}`, token, body: { status: "SUSPENDED", reason: "r" } });
    await inject({ method: "PATCH", url: `/v1/tenants/${id}`, token, body: { retentionDays: 90 } });
    expect(seen.map((s) => [s.path, s.body["tenantId"]])).toEqual([
      ["/internal/v1/updateTenantStatus", id],
      ["/internal/v1/updateTenantSettings", id],
    ]);
  });

  it("passes registry errors through: status, code, message, details; 429 keeps its code", async () => {
    reply = () => ({
      status: 422,
      body: {
        error: {
          code: "AUTH_PASSWORD_POLICY",
          message: "password does not meet the policy",
          details: [{ field: "password", issue: "weak" }],
        },
      },
    });
    const weak = await inject({
      method: "POST",
      url: "/v1/auth/password",
      token: await sign(["ANALYST"]),
      body: { currentPassword: "a", newPassword: "b" },
    });
    expect(weak.statusCode).toBe(422);
    expect(weak.json()).toMatchObject({
      error: {
        code: "AUTH_PASSWORD_POLICY",
        message: "password does not meet the policy",
        details: [{ field: "password", message: "weak" }],
      },
    });
    reply = () => ({
      status: 429,
      body: { error: { code: "AUTH_RATE_LIMITED", message: "too many attempts; try later" } },
    });
    const limited = await inject({
      method: "POST",
      url: "/v1/auth/login",
      body: { tenantSlug: "acme", email: "a@b.c", password: "x" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "AUTH_RATE_LIMITED" } });
  });

  it("FR-AUTH-04 /v1/auth/token is public and fixes the audience; FR-AUTH-05 JWKS passes through unchanged", async () => {
    await inject({
      method: "POST",
      url: "/v1/auth/token",
      body: { clientId: "int_x", clientSecret: "s", audience: "aegispulse-internal" },
    });
    expect(seen.at(-1)?.body).toMatchObject({ clientId: "int_x", audience: "aegispulse" });
    reply = () => ({
      status: 200,
      body: { keys: [{ kid: "k1" }] },
      headers: { "cache-control": "public, max-age=600" },
    });
    const jwks = await inject({ method: "GET", url: "/.well-known/jwks.json" });
    expect(jwks.statusCode).toBe(200);
    expect(jwks.headers["content-type"]).toContain("application/jwk-set+json");
    expect(jwks.headers["cache-control"]).toBe("public, max-age=600");
    expect(jwks.json()).toEqual({ keys: [{ kid: "k1" }] });
  });
});
