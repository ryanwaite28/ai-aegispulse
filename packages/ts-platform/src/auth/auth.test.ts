import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "../errors/index.js";
import {
  bearerToken,
  hasRole,
  JwtVerifier,
  PLATFORM_TENANT_ID,
  ServiceTokenProvider,
  tenantAccess,
  type Principal,
} from "./index.js";

const ISS = "aegispulse-registry";
let privateKey: CryptoKey;
let otherKey: CryptoKey;
let verifier: JwtVerifier;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  otherKey = (await generateKeyPair("RS256")).privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  verifier = new JwtVerifier({ jwks: createLocalJWKSet({ keys: [jwk] }), issuer: ISS, audience: "aegispulse" });
});

async function sign(
  claims: Record<string, unknown>,
  opts: { aud?: string; exp?: number; key?: CryptoKey; iss?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setSubject(String(claims["sub"] ?? "u-1"))
    .setIssuer(opts.iss ?? ISS)
    .setAudience(opts.aud ?? "aegispulse")
    .setIssuedAt(now)
    .setExpirationTime(opts.exp ?? now + 900)
    .sign(opts.key ?? privateKey);
}

const userClaims = { typ: "user", tid: "t-1", tslug: "acme", roles: ["ANALYST"], jti: "j-1" };

const code = async (p: Promise<unknown>): Promise<string> => {
  const e = await p.catch((x: unknown) => x);
  return e instanceof DomainError ? e.code : `not a DomainError: ${String(e)}`;
};

describe("JwtVerifier (FR-AUTH-05, §5.7.4)", () => {
  it("verifies a user token and maps the principal", async () => {
    const p = await verifier.verifyUser(await sign(userClaims));
    expect(p).toEqual({
      kind: "user",
      userId: "u-1",
      tenantId: "t-1",
      tenantSlug: "acme",
      roles: ["ANALYST"],
      tokenId: "j-1",
    });
    expect(hasRole(p, "TENANT_ADMIN", "ANALYST")).toBe(true);
  });

  it("rejects wrong audience (dev token in prod), wrong issuer, foreign key, and expired beyond leeway", async () => {
    expect(await code(verifier.verifyUser(await sign(userClaims, { aud: "aegispulse-dev" })))).toBe("UNAUTHORIZED");
    expect(await code(verifier.verifyUser(await sign(userClaims, { iss: "evil" })))).toBe("UNAUTHORIZED");
    expect(await code(verifier.verifyUser(await sign(userClaims, { key: otherKey })))).toBe("UNAUTHORIZED");
    const now = Math.floor(Date.now() / 1000);
    expect(await code(verifier.verifyUser(await sign(userClaims, { exp: now - 120 })))).toBe("UNAUTHORIZED");
    // within the 60 s leeway
    await expect(verifier.verifyUser(await sign(userClaims, { exp: now - 30 }))).resolves.toMatchObject({
      kind: "user",
    });
  });

  it("rejects HS256 / alg confusion and missing claims", async () => {
    const hs = await new SignJWT(userClaims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("u")
      .setIssuer(ISS)
      .setAudience("aegispulse")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode("x".repeat(32)));
    expect(await code(verifier.verifyUser(hs))).toBe("UNAUTHORIZED");
    expect(await code(verifier.verifyUser(await sign({ typ: "user", tid: "t", tslug: "s", jti: "j" })))).toBe(
      "UNAUTHORIZED",
    ); // no roles
    expect(await code(verifier.verifyUser(await sign({ ...userClaims, typ: "admin" })))).toBe("UNAUTHORIZED");
    const noTyp: Record<string, unknown> = { ...userClaims };
    delete noTyp["typ"];
    expect(await code(verifier.verifyTenant(await sign(noTyp)))).toBe("UNAUTHORIZED");
  });

  it("accepts INTEGRATION tokens as tenant principals with only the INTEGRATION role (FR-AUTH-04)", async () => {
    const integ = await sign({
      sub: "cli_123",
      typ: "integration",
      tid: "t-1",
      tslug: "acme",
      roles: ["INTEGRATION"],
      jti: "j-2",
    });
    await expect(verifier.verifyTenant(integ)).resolves.toEqual({
      kind: "integration",
      clientId: "cli_123",
      tenantId: "t-1",
      tenantSlug: "acme",
      roles: ["INTEGRATION"],
      tokenId: "j-2",
    });
    expect(await code(verifier.verifyUser(integ))).toBe("UNAUTHORIZED"); // user-only endpoints refuse it
    const escalated = await sign({
      sub: "cli_123",
      typ: "integration",
      tid: "t-1",
      tslug: "acme",
      roles: ["TENANT_ADMIN"],
      jti: "j-3",
    });
    expect(await code(verifier.verifyTenant(escalated))).toBe("UNAUTHORIZED");
    await expect(verifier.authorizeInternal(`Bearer ${integ}`, "ingestion.submitTransaction")).resolves.toMatchObject({
      kind: "integration",
    });
  });

  it("rejects service tokens on the public audience and service tokens without typ=service (FR-TEN-07)", async () => {
    const svcPublic = await sign({ sub: "svc-x", typ: "service", act: ["a"], jti: "j" });
    expect(await code(verifier.verifyTenant(svcPublic))).toBe("UNAUTHORIZED");
    const noTyp = await sign(
      { sub: "svc-x", act: ["registry.resolveEntities"], jti: "j" },
      { aud: "aegispulse-internal" },
    );
    expect(await code(verifier.authorizeInternal(`Bearer ${noTyp}`, "registry.resolveEntities"))).toBe("UNAUTHORIZED");
  });

  it("authorizes internal calls: user token, or SERVICE token whose act[] contains the action", async () => {
    const user = await sign(userClaims);
    await expect(verifier.authorizeInternal(`Bearer ${user}`, "registry.resolveEntities")).resolves.toMatchObject({
      kind: "user",
    });

    const svc = await sign(
      { sub: "svc-orchestrator", typ: "service", act: ["registry.resolveEntities"], jti: "j-9" },
      { aud: "aegispulse-internal" },
    );
    await expect(verifier.authorizeInternal(`Bearer ${svc}`, "registry.resolveEntities")).resolves.toEqual({
      kind: "service",
      clientId: "svc-orchestrator",
      actions: ["registry.resolveEntities"],
    });
    expect(await code(verifier.authorizeInternal(`Bearer ${svc}`, "cases.openCase"))).toBe("FORBIDDEN");

    // a user token minted for the internal audience is not a service token
    const userInternal = await sign(userClaims, { aud: "aegispulse-internal" });
    expect(await code(verifier.authorizeInternal(`Bearer ${userInternal}`, "registry.resolveEntities"))).toBe(
      "UNAUTHORIZED",
    );
    expect(await code(verifier.authorizeInternal(undefined, "x"))).toBe("UNAUTHORIZED");
    expect(await code(verifier.authorizeInternal("Basic abc", "x"))).toBe("UNAUTHORIZED");
  });

  it("parses bearer headers strictly", () => {
    expect(bearerToken("Bearer a.b.c")).toBe("a.b.c");
    expect(() => bearerToken("Bearer a b")).toThrow(DomainError);
  });
});

describe("ServiceTokenProvider (FR-TEN-07)", () => {
  it("caches until the refresh skew and shares concurrent fetches", async () => {
    let now = 0;
    let calls = 0;
    const provider = new ServiceTokenProvider({
      clientId: "svc-files",
      clientSecret: "secret-secret-secret",
      now: () => now,
      issue: async (input) => {
        calls++;
        expect(input.audience).toBe("aegispulse-internal");
        return { accessToken: `t${calls}`, expiresIn: 900 };
      },
    });
    const [a, b] = await Promise.all([provider.token(), provider.token()]);
    expect([a, b, calls]).toEqual(["t1", "t1", 1]);
    now = 839_000;
    expect(await provider.token()).toBe("t1");
    now = 841_000; // within 60 s of expiry
    expect(await provider.token()).toBe("t2");
  });
});

describe("tenantAccess (FR-AUTH-06, §6.2 X-Aegis-Tenant)", () => {
  const T = "8a92269a-91aa-4d80-b6fd-093a350304fe";
  const user = (roles: string[], tenantId = T): Principal => ({
    kind: "user",
    userId: "11111111-1111-4111-8111-111111111111",
    tenantId,
    tenantSlug: "t",
    roles,
    tokenId: "x",
  });
  const allowed = ["INTEGRATION", "ANALYST", "TENANT_ADMIN", "PLATFORM_ADMIN"];
  const code = (f: () => unknown): string => {
    try {
      f();
      return "ok";
    } catch (e: unknown) {
      return (e as { code: string }).code;
    }
  };

  it("tenant roles act on their own tenant; the header is PLATFORM_ADMIN-only", () => {
    expect(tenantAccess(user(["ANALYST"]), undefined, allowed)).toMatchObject({
      tenantId: T,
      actingAsPlatformAdmin: false,
    });
    expect(code(() => tenantAccess(user(["ANALYST"]), T, allowed))).toBe("FORBIDDEN");
    expect(code(() => tenantAccess(user(["VIEWER"]), undefined, allowed))).toBe("FORBIDDEN");
  });

  it("PLATFORM_ADMIN must name a tenant, never the platform tenant", () => {
    const pa = user(["PLATFORM_ADMIN"], PLATFORM_TENANT_ID);
    expect(tenantAccess(pa, T, allowed)).toMatchObject({ tenantId: T, actingAsPlatformAdmin: true });
    expect(code(() => tenantAccess(pa, undefined, allowed))).toBe("FORBIDDEN");
    expect(code(() => tenantAccess(pa, PLATFORM_TENANT_ID, allowed))).toBe("NOT_FOUND");
  });

  it("INTEGRATION accounts act as integration:{clientId}; SERVICE principals are refused", () => {
    const integ: Principal = {
      kind: "integration",
      clientId: "int-feed",
      tenantId: T,
      tenantSlug: "t",
      roles: ["INTEGRATION"],
      tokenId: "x",
    };
    expect(tenantAccess(integ, undefined, allowed)).toMatchObject({ actor: "integration:int-feed", userId: null });
    expect(code(() => tenantAccess({ kind: "service", clientId: "svc-x", actions: [] }, undefined, allowed))).toBe(
      "FORBIDDEN",
    );
  });
});
