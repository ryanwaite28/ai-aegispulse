import "reflect-metadata";
import { Writable } from "node:stream";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JwtVerifier } from "@aegispulse/ts-platform/auth";
import { HealthRegistry } from "@aegispulse/ts-platform/health";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { JwtAuthGuard, type AuthenticatedRequest } from "./common/guards/jwt-auth.guard.js";
import { createGateway } from "./main.js";
import type { Config } from "./config.js";

const logger = createLogger({
  service: "gateway",
  version: "test",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});
const config = {
  AEGIS_ENV: "local",
  LOG_LEVEL: "info",
  OTEL_SERVICE_NAMESPACE: "aegispulse",
  REGISTRY_URL: "http://registry:8084",
  JWT_ISSUER: "aegispulse-registry",
  JWT_AUDIENCE: "aegispulse",
} as Config;

interface InjectResult {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  json(): unknown;
}

let verifier: JwtVerifier;
let sign: (claims: Record<string, unknown>, aud?: string) => Promise<string>;

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  verifier = new JwtVerifier({ jwks, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });
  sign = (claims, aud = "aegispulse") =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(config.JWT_ISSUER)
      .setAudience(aud)
      .setSubject("u-1")
      .setJti("j-1")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
});

describe("gateway skeleton (ADR-0013, §8.2, §8.3, NFR-11)", () => {
  const health = new HealthRegistry();
  let app: Awaited<ReturnType<typeof createGateway>>;

  beforeAll(async () => {
    app = await createGateway(config, verifier, health, logger);
  });
  afterAll(async () => app.close());

  const inject = async (url: string, headers: Record<string, string> = {}): Promise<InjectResult> =>
    (await app.getHttpAdapter().getInstance().inject({ method: "GET", url, headers })) as InjectResult;

  it("serves probes; readyz is 503 until the gateway is running", async () => {
    expect((await inject("/livez")).json()).toEqual({ status: "ok" });
    expect((await inject("/readyz")).statusCode).toBe(503);
    health.markRunning();
    expect((await inject("/readyz")).statusCode).toBe(200);
  });

  it("serves the bundled public OpenAPI document without auth (§8.3)", async () => {
    const res = await inject("/v1/openapi.json");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: expect.stringMatching(/^3\.1/), paths: expect.any(Object) });
  });

  it("answers unknown routes with a §8.2 envelope and echoes correlation ids", async () => {
    const corr = "corr-0b6e1e6c-6a7d-4c35-9d3b-7f1d4f3b2a10";
    const res = await inject("/v1/nope", { "x-correlation-id": corr });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "NOT_FOUND" }, meta: { correlationId: corr } });
    expect(res.headers["x-correlation-id"]).toBe(corr);
  });
});

describe("JwtAuthGuard (FR-AUTH-05, ADR-0010 typ rules)", () => {
  const context = (authorization?: string, isPublic = false): { ctx: ExecutionContext; req: AuthenticatedRequest } => {
    const req: AuthenticatedRequest = { headers: authorization === undefined ? {} : { authorization } };
    const handler = (): void => undefined;
    if (isPublic) Reflect.defineMetadata("aegis:public", true, handler);
    const ctx = {
      getHandler: () => handler,
      getClass: () => Object,
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;
    return { ctx, req };
  };

  it("lets @Public routes through and authenticates everything else", async () => {
    const guard = new JwtAuthGuard(new Reflector(), verifier);
    expect(await guard.canActivate(context(undefined, true).ctx)).toBe(true);
    await expect(guard.canActivate(context().ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    const { ctx, req } = context(
      `Bearer ${await sign({ typ: "user", tid: "t-1", tslug: "acme", roles: ["ANALYST"] })}`,
    );
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(req.principal).toMatchObject({ userId: "u-1", tenantId: "t-1" });

    const service = await sign({ typ: "service", act: ["x"] }, "aegispulse-internal");
    await expect(guard.canActivate(context(`Bearer ${service}`).ctx)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
