// Phase 2 exit: E2E auth flows over the gateway (FR-AUTH-01/02/03/07, FR-AUTH-04/05).
import { describe, expect, it } from "vitest";
import { call, login, strongPassword, world } from "./support/world.js";

describe("auth flows over the gateway (Phase 2 exit)", () => {
  it("FR-AUTH-01/02/03 login → refresh rotation → reuse revokes the family → logout", async () => {
    const w = await world();
    const u = w.a.users.ANALYST;
    const s1 = await login(w.a.slug, u.email, u.password);
    expect(s1.status).toBe(200);
    const access = String(s1.body.data?.["accessToken"]);
    const r1 = String(s1.body.data?.["refreshToken"]);
    expect((await call("GET", "/v1/auth/me", { token: access })).body.data).toMatchObject({
      typ: "user",
      roles: ["ANALYST"],
      tenant: { slug: w.a.slug },
    });
    const s2 = await call("POST", "/v1/auth/refresh", { body: { refreshToken: r1 } });
    expect(s2.status).toBe(200);
    const r2 = String(s2.body.data?.["refreshToken"]);
    const reuse = await call("POST", "/v1/auth/refresh", { body: { refreshToken: r1 } });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error?.code).toBe("AUTH_REFRESH_INVALID");
    expect((await call("POST", "/v1/auth/refresh", { body: { refreshToken: r2 } })).status).toBe(401);

    const s3 = await login(w.a.slug, u.email, u.password);
    const r3 = String(s3.body.data?.["refreshToken"]);
    expect((await call("POST", "/v1/auth/logout", { token: access, body: { refreshToken: r3 } })).status).toBe(200);
    expect((await call("POST", "/v1/auth/refresh", { body: { refreshToken: r3 } })).status).toBe(401);
  });

  it("FR-AUTH-01 uniform 401s, then 429 after 5 failures for one (tenant, email)", async () => {
    const w = await world();
    const u = w.a.users.VIEWER;
    for (let i = 0; i < 5; i++) {
      const bad = await login(w.a.slug, u.email, "Wrong-password-0000");
      expect(bad.status).toBe(401);
      expect(bad.body.error).toMatchObject({ code: "AUTH_INVALID_CREDENTIALS", message: "invalid credentials" });
    }
    expect((await login(w.a.slug, u.email, u.password)).body.error?.code).toBe("AUTH_RATE_LIMITED");
    expect((await login(w.a.slug, "nobody@nowhere.example", "x")).body.error?.message).toBe("invalid credentials");
  });

  it("FR-AUTH-07 password change keeps the named session only and clears mustChangePassword", async () => {
    const w = await world();
    const u = w.a.users.COMPLIANCE_AUDITOR;
    const a = await login(w.a.slug, u.email, u.password);
    const b = await login(w.a.slug, u.email, u.password);
    expect(a.body.data?.["mustChangePassword"]).toBe(true);
    const next = strongPassword();
    const changed = await call("POST", "/v1/auth/password", {
      token: String(a.body.data?.["accessToken"]),
      body: { currentPassword: u.password, newPassword: next, refreshToken: a.body.data?.["refreshToken"] },
    });
    expect(changed.status).toBe(200);
    expect(
      (await call("POST", "/v1/auth/refresh", { body: { refreshToken: a.body.data?.["refreshToken"] } })).status,
    ).toBe(200);
    expect(
      (await call("POST", "/v1/auth/refresh", { body: { refreshToken: b.body.data?.["refreshToken"] } })).status,
    ).toBe(401);
    expect((await login(w.a.slug, u.email, u.password)).status).toBe(401);
    const fresh = await login(w.a.slug, u.email, next);
    expect(fresh.body.data?.["mustChangePassword"]).toBe(false);
  });

  it("FR-AUTH-04/05 INTEGRATION client credentials and the public JWKS", async () => {
    const w = await world();
    const me = await call("GET", "/v1/auth/me", { token: w.a.integration.token });
    expect(me.body.data).toMatchObject({ typ: "integration", roles: ["INTEGRATION"], tenant: { slug: w.a.slug } });
    const wrong = await call("POST", "/v1/auth/token", {
      body: { clientId: w.a.integration.clientId, clientSecret: "nope" },
    });
    expect(wrong.status).toBe(401);
    const res = await fetch(`${process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:8080"}/.well-known/jwks.json`);
    expect(res.headers.get("content-type")).toContain("application/jwk-set+json");
    const set = (await res.json()) as { keys: { kid: string; d?: string }[] };
    expect(set.keys.length).toBeGreaterThan(0);
    expect(set.keys.every((k) => k.d === undefined)).toBe(true);
  });
});
