import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JwtVerifier } from "./index.js";

// FR-AUTH-05: the remote JWKS is cached (10 min) and refetched for an unknown kid (after the 5 s cooldown).
const ISS = "aegispulse-registry";
let server: Server;
let url: URL;
let served: { keys: JWK[] };
let fetches = 0;

async function keyPair(kid: string): Promise<{ priv: CryptoKey; jwk: JWK }> {
  const pair = await generateKeyPair("RS256", { extractable: true });
  return { priv: pair.privateKey, jwk: { ...(await exportJWK(pair.publicKey)), kid, alg: "RS256", use: "sig" } };
}

function sign(key: CryptoKey, kid: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ typ: "user", tid: "t-1", tslug: "acme", roles: ["ANALYST"], jti: `j-${kid}` })
    .setProtectedHeader({ alg: "RS256", kid })
    .setSubject("u-1")
    .setIssuer(ISS)
    .setAudience("aegispulse")
    .setIssuedAt(now)
    .setExpirationTime(now + 900)
    .sign(key);
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    fetches += 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(served));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = new URL(`http://127.0.0.1:${String((server.address() as AddressInfo).port)}/.well-known/jwks.json`);
});

afterAll(() => {
  vi.useRealTimers();
  server.close();
});

describe("JwtVerifier remote JWKS", () => {
  it("FR-AUTH-05 refetches on an unknown kid within the cache window and keeps the previous key", async () => {
    const k1 = await keyPair("k1");
    const k2 = await keyPair("k2");
    served = { keys: [k1.jwk] };
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const verifier = new JwtVerifier({ jwks: url, issuer: ISS, audience: "aegispulse" });

    await verifier.verifyUser(await sign(k1.priv, "k1"));
    await verifier.verifyUser(await sign(k1.priv, "k1"));
    expect(fetches).toBe(1); // cached

    served = { keys: [k2.jwk, k1.jwk] }; // rotation: k2 current, k1 previous
    vi.setSystemTime(Date.now() + 6_000); // past the 5 s cooldown, well inside the 10 min cache
    await expect(verifier.verifyUser(await sign(k2.priv, "k2"))).resolves.toBeDefined();
    expect(fetches).toBe(2);
    await expect(verifier.verifyUser(await sign(k1.priv, "k1"))).resolves.toBeDefined();
  });
});
