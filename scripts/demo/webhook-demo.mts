// Phase 4 exit demo: a signed webhook → 202 → event on aegispulse.ingress (FR-WHK-01..05). Re-runnable.
//   1. The platform admin creates a throwaway TENANT_ADMIN in the seeded demo tenant (make seed first).
//   2. That admin creates the `demo-market-feed` source, or rotates its secret on later runs. The one-time secret is
//      held in memory only and never printed or written.
//   3. A signed AEGIS_MARKET_EVENT_V1 is sent to POST /webhooks/demo-market-feed. The delivery list shows ACCEPTED.
//   4. The throwaway admin is disabled.
// The event then waits on events.archive.q (bound to `#`; the events consumer arrives in Phase 6). See it in the
// RabbitMQ UI at http://localhost:15672 → Queues → events.archive.q → Get messages.
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env["GATEWAY_URL"] ?? "http://127.0.0.1:8080";
const STATE = new URL("../../.seed-state.json", import.meta.url);
const TENANT_SLUG = "tenant-acme-capital";
const SOURCE_KEY = "demo-market-feed";

interface Reply {
  status: number;
  body: { data?: unknown; error?: { code: string; message: string } };
}

async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<Reply> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Reply["body"]) };
}

function data(r: Reply, expected: number, what: string): Record<string, unknown> {
  if (r.status !== expected) {
    throw new Error(`${what}: HTTP ${String(r.status)} ${r.body.error?.code ?? ""} ${r.body.error?.message ?? ""}`);
  }
  return r.body.data as Record<string, unknown>;
}

const out = (line: string): boolean => process.stdout.write(`demo-webhook: ${line}\n`);

async function main(): Promise<void> {
  const paPassword = process.env["SEED_PA_PASSWORD"];
  if (paPassword === undefined || paPassword === "")
    throw new Error("SEED_PA_PASSWORD is not set (run via make demo-webhook)");
  const state = (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}) as Record<string, string>;
  const tenantId = state[TENANT_SLUG];
  if (tenantId === undefined) throw new Error(`no ${TENANT_SLUG} in .seed-state.json (run make seed first)`);

  const pa = String(
    data(
      await call("POST", "/v1/auth/login", undefined, {
        tenantSlug: "platform",
        email: process.env["SEED_PA_EMAIL"] ?? "admin@aegispulse.local",
        password: paPassword,
      }),
      200,
      "platform admin login",
    )["accessToken"],
  );
  const asTenant = { "x-aegis-tenant": tenantId };
  const email = `webhook-demo-${randomBytes(4).toString("hex")}@acme-capital.example`;
  const password = `Demo-${randomBytes(18).toString("base64url")}`;
  const user = data(
    await call(
      "POST",
      "/v1/users",
      pa,
      { email, displayName: "Webhook demo (temporary)", roles: ["TENANT_ADMIN"], initialPassword: password },
      asTenant,
    ),
    201,
    "create temporary tenant admin",
  );
  try {
    const ta = String(
      data(
        await call("POST", "/v1/auth/login", undefined, { tenantSlug: TENANT_SLUG, email, password }),
        200,
        "tenant admin login",
      )["accessToken"],
    );
    const sources = data(
      await call("GET", "/v1/webhook-sources?limit=100", ta),
      200,
      "list sources",
    ) as unknown as Record<string, unknown>[];
    const existing = sources.find((s) => s["sourceKey"] === SOURCE_KEY);
    let sourceId: string;
    let secret: string;
    if (existing === undefined) {
      const created = data(
        await call("POST", "/v1/webhook-sources", ta, { sourceKey: SOURCE_KEY, displayName: "Demo market feed" }),
        201,
        "create source",
      );
      sourceId = String(created["id"]);
      secret = String(created["signingSecret"]);
      out(`created source ${SOURCE_KEY} (${sourceId})`);
    } else {
      sourceId = String(existing["id"]);
      secret = String(
        data(await call("POST", `/v1/webhook-sources/${sourceId}/rotate-secret`, ta), 200, "rotate secret")[
          "signingSecret"
        ],
      );
      out(`rotated the secret of ${SOURCE_KEY} (${sourceId}); the previous one stays valid 72 h`);
    }

    const raw = Buffer.from(
      JSON.stringify({
        externalId: `demo-${randomUUID()}`,
        category: "MARKET_ALERT",
        title: "Demo: unusual trading volume in ACMH",
        summary: "Synthetic alert sent by make demo-webhook",
        publishedAt: new Date().toISOString(),
        severity: "HIGH",
        mentionedEntities: ["ACME Holdings"],
        tickers: ["ACMH"],
      }),
    );
    const ts = String(Math.floor(Date.now() / 1000));
    const deliveryId = `demo-${randomUUID()}`;
    const signature = createHmac("sha256", secret)
      .update(Buffer.concat([Buffer.from(`${ts}.${deliveryId}.`), raw]))
      .digest("hex");
    const res = await fetch(`${BASE}/webhooks/${SOURCE_KEY}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-aegis-signature": `v1=${signature}`,
        "x-aegis-timestamp": ts,
        "x-aegis-delivery-id": deliveryId,
      },
      body: raw,
    });
    out(`POST /webhooks/${SOURCE_KEY} → ${String(res.status)} ${await res.text()}`);
    if (res.status !== 202) throw new Error("webhook was not accepted");

    const deliveries = data(
      await call("GET", `/v1/webhook-sources/${sourceId}/deliveries?limit=1`, ta),
      200,
      "list deliveries",
    ) as unknown as Record<string, unknown>[];
    const d = deliveries[0] ?? {};
    out(
      `latest delivery: outcome=${String(d["outcome"])} eventId=${String(d["eventId"])} slot=${String(d["signatureSlot"])}`,
    );
    out("the event now waits on events.archive.q: http://localhost:15672 → Queues → events.archive.q → Get messages");
  } finally {
    await retireDemoAdmins(pa, asTenant, String(user["id"]));
  }
}

/**
 * Disables earlier temporary admins, then this run's. The registry keeps at least one active TENANT_ADMIN per tenant
 * (409 LAST_TENANT_ADMIN). When the temporary admin is the only one, it stays active, but its password existed in this
 * process's memory only, so nobody can sign in as it. The next run's admin replaces it.
 */
async function retireDemoAdmins(pa: string, asTenant: Record<string, string>, currentId: string): Promise<void> {
  const users = data(
    await call("GET", "/v1/users?limit=100", pa, undefined, asTenant),
    200,
    "list users",
  ) as unknown as Record<string, unknown>[];
  const earlier = users.filter(
    (u) => u["id"] !== currentId && u["status"] === "ACTIVE" && String(u["email"]).startsWith("webhook-demo-"),
  );
  let retired = 0;
  for (const u of earlier) {
    const r = await call("PATCH", `/v1/users/${String(u["id"])}`, pa, { status: "DISABLED" }, asTenant);
    if (r.status === 200) retired += 1;
  }
  if (retired > 0) out(`disabled ${String(retired)} earlier temporary admin(s)`);
  const r = await call("PATCH", `/v1/users/${currentId}`, pa, { status: "DISABLED" }, asTenant);
  if (r.status === 200) out("temporary tenant admin disabled");
  else if (r.body.error?.code === "LAST_TENANT_ADMIN") {
    out("temporary tenant admin kept active: it is the tenant's only admin (its password was never stored)");
  } else out(`could not disable the temporary admin (HTTP ${String(r.status)} ${r.body.error?.code ?? ""})`);
}

main().catch((error: unknown) => {
  process.stderr.write(`demo-webhook: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
