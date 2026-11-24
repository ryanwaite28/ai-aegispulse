// E2E harness (PROJECT.md §14): talks to the compose stack only through the gateway, like a real client.
// It builds an isolated world per run: two fresh tenants (A, B), a user per tenant role, and an INTEGRATION
// account. The platform admin is the bootstrap PA (FR-TEN-09); its password arrives via E2E_PA_PASSWORD and is
// never printed or changed.
import { randomBytes } from "node:crypto";

export const BASE_URL = process.env["E2E_BASE_URL"] ?? "http://127.0.0.1:8080";
const PA_EMAIL = process.env["E2E_PA_EMAIL"] ?? "admin@aegispulse.local";

export interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown> & {
    data?: Record<string, unknown> & Record<string, unknown>[];
    error?: { code: string; message: string };
    meta?: { nextCursor?: string };
  };
}

export async function call(
  method: string,
  path: string,
  opts: { token?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: {
      ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      ...(opts.token === undefined ? {} : { authorization: `Bearer ${opts.token}` }),
      ...opts.headers,
    },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Reply["body"]) };
}

export const strongPassword = (): string => `E2e-${randomBytes(12).toString("hex")}`;
export const ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_ADMIN",
  "ANALYST",
  "VIEWER",
  "COMPLIANCE_AUDITOR",
  "INTEGRATION",
] as const;
export type RoleName = (typeof ROLES)[number];

export interface TenantWorld {
  readonly id: string;
  readonly slug: string;
  readonly adminId: string;
  readonly users: Record<
    "TENANT_ADMIN" | "ANALYST" | "VIEWER" | "COMPLIANCE_AUDITOR",
    { email: string; password: string; token: string }
  >;
  readonly integration: { id: string; clientId: string; clientSecret: string; token: string };
}

export interface World {
  readonly pa: string;
  readonly a: TenantWorld;
  readonly b: TenantWorld;
  token(role: RoleName, tenant?: TenantWorld): string;
}

function must(r: Reply, status: number, what: string): Record<string, unknown> {
  if (r.status !== status || r.body.data === undefined) {
    throw new Error(
      `${what}: expected ${String(status)}, got ${String(r.status)} ${JSON.stringify(r.body.error ?? {})}`,
    );
  }
  return r.body.data;
}

export async function login(slug: string, email: string, password: string): Promise<Reply> {
  return call("POST", "/v1/auth/login", { body: { tenantSlug: slug, email, password } });
}

async function tenant(pa: string, run: string, name: "a" | "b"): Promise<TenantWorld> {
  const slug = `e2e-${run}-${name}`;
  const t = must(
    await call("POST", "/v1/tenants", {
      token: pa,
      headers: { "idempotency-key": slug },
      body: { slug, displayName: `E2E ${name}` },
    }),
    201,
    "create tenant",
  );
  const id = String(t["id"]);
  const users = {} as TenantWorld["users"];
  let adminId = "";
  for (const role of ["TENANT_ADMIN", "ANALYST", "VIEWER", "COMPLIANCE_AUDITOR"] as const) {
    const email = `${role.toLowerCase().replace(/_/g, "-")}@${slug}.example`;
    const password = strongPassword();
    const created = must(
      await call("POST", "/v1/users", {
        token: role === "TENANT_ADMIN" ? pa : users.TENANT_ADMIN.token,
        headers: role === "TENANT_ADMIN" ? { "x-aegis-tenant": id } : {},
        body: { email, displayName: role, roles: [role], initialPassword: password },
      }),
      201,
      `create ${role}`,
    );
    if (role === "TENANT_ADMIN") adminId = String(created["id"]);
    const session = must(await login(slug, email, password), 200, `login ${role}`);
    users[role] = { email, password, token: String(session["accessToken"]) };
  }
  const sa = must(
    await call("POST", "/v1/service-accounts", { token: users.TENANT_ADMIN.token, body: { name: "e2e feed" } }),
    201,
    "create service account",
  );
  const clientId = String(sa["clientId"]);
  const clientSecret = String(sa["clientSecret"]);
  const issued = must(
    await call("POST", "/v1/auth/token", { body: { clientId, clientSecret } }),
    200,
    "integration token",
  );
  return {
    id,
    slug,
    adminId,
    users,
    integration: { id: String(sa["id"]), clientId, clientSecret, token: String(issued["accessToken"]) },
  };
}

let cached: Promise<World> | undefined;

/** One world per test process (vitest runs each file in its own worker). */
export function world(): Promise<World> {
  cached ??= (async () => {
    const password = process.env["E2E_PA_PASSWORD"];
    if (password === undefined || password === "")
      throw new Error("E2E_PA_PASSWORD is not set (run via make test-e2e)");
    const pa = String(must(await login("platform", PA_EMAIL, password), 200, "platform admin login")["accessToken"]);
    const run = randomBytes(3).toString("hex");
    const [a, b] = [await tenant(pa, run, "a"), await tenant(pa, run, "b")];
    return {
      pa,
      a,
      b,
      token: (role, t = a) =>
        role === "PLATFORM_ADMIN" ? pa : role === "INTEGRATION" ? t.integration.token : t.users[role].token,
    };
  })();
  return cached;
}
