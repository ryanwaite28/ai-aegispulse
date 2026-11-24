// Demo seed through the public API (PROJECT.md §1.4.7, §14; Phase 3 exit evidence). Idempotent and safe to re-run:
// tenants are created with fixed Idempotency-Keys and their ids remembered in .seed-state.json (gitignored), since
// there is no list-tenants route; entities and watchlists are looked up by name on 409. Runs as the bootstrap
// PLATFORM_ADMIN via X-Aegis-Tenant; prints names and ids only. Node 24 runs this file directly (type stripping).
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const BASE = process.env["SEED_BASE_URL"] ?? "http://127.0.0.1:8080";
const STATE = new URL("../../.seed-state.json", import.meta.url);

type Json = Record<string, unknown>;
interface Reply {
  status: number;
  body: { data?: Json | Json[]; error?: { code: string; message: string } };
}

/** `data` as one object (create/login responses). */
const one = (r: Reply): Json => (Array.isArray(r.body.data) ? {} : (r.body.data ?? {}));
/** `data` as a list (list responses). */
const many = (r: Reply): Json[] => (Array.isArray(r.body.data) ? r.body.data : []);
const out = (line: string): boolean => process.stdout.write(`${line}\n`);

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

function fail(what: string, r: Reply): never {
  throw new Error(`seed: ${what} → ${String(r.status)} ${r.body.error?.code ?? ""} ${r.body.error?.message ?? ""}`);
}

const TENANTS = [
  { slug: "tenant-acme-capital", displayName: "ACME Capital", demoMode: true },
  { slug: "tenant-globex-bank", displayName: "Globex Bank", demoMode: false },
];
// §1.4.7 seed entities (all fictional) and the "Sanctions Watch" watchlist containing Globex Clearing.
const ENTITIES = [
  { name: "ACME Holdings", entityType: "ORGANIZATION", ticker: "ACMH", aliases: ["ACME Capital Holdings"] },
  { name: "Globex Clearing", entityType: "COUNTERPARTY", ticker: "GLBX", aliases: [] },
  { name: "Initech Securities", entityType: "ORGANIZATION", aliases: [] },
  { name: "Umbrella Pharma", entityType: "ORGANIZATION", ticker: "UMBR", aliases: [] },
  { name: "Stark Analytics", entityType: "ORGANIZATION", aliases: [] },
];
const WATCHLIST = {
  name: "Sanctions Watch",
  reason: "Demo: counterparties under sanctions review",
  severityFloor: "HIGH",
};

async function main(): Promise<void> {
  const password = process.env["SEED_PA_PASSWORD"];
  if (password === undefined || password === "")
    throw new Error("seed: SEED_PA_PASSWORD is not set (run via make seed)");
  const login = await call("POST", "/v1/auth/login", undefined, {
    tenantSlug: "platform",
    email: process.env["SEED_PA_EMAIL"] ?? "admin@aegispulse.local",
    password,
  });
  if (login.status !== 200) fail("platform admin login", login);
  const pa = String(one(login)["accessToken"]);
  const state = (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}) as Record<string, string>;

  for (const t of TENANTS) {
    let id = state[t.slug];
    if (id === undefined) {
      const r = await call("POST", "/v1/tenants", pa, t, { "idempotency-key": `seed-${t.slug}` });
      if (r.status !== 201) fail(`create tenant ${t.slug}`, r);
      id = String(one(r)["id"]);
      state[t.slug] = id;
      writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    }
    const as = { "x-aegis-tenant": id };
    const ids: Record<string, string> = {};
    for (const e of ENTITIES) {
      const r = await call("POST", "/v1/entities", pa, e, as);
      if (r.status === 201) ids[e.name] = String(one(r)["id"]);
      else if (r.body.error?.code === "ENTITY_DUPLICATE") {
        const found = await call("GET", `/v1/entities?q=${encodeURIComponent(e.name)}&limit=1`, pa, undefined, as);
        ids[e.name] = String(many(found)[0]?.["id"]);
      } else fail(`entity ${e.name}`, r);
    }
    const created = await call("POST", "/v1/watchlists", pa, WATCHLIST, as);
    let wlId: string;
    if (created.status === 201) wlId = String(one(created)["id"]);
    else if (created.body.error?.code === "WATCHLIST_NAME_TAKEN") {
      const all = many(await call("GET", "/v1/watchlists?limit=100", pa, undefined, as));
      wlId = String(all.find((w) => w["name"] === WATCHLIST.name)?.["id"]);
    } else fail("watchlist", created);
    const entry = await call(
      "POST",
      `/v1/watchlists/${wlId}/entries`,
      pa,
      { entityId: ids["Globex Clearing"], note: "demo" },
      as,
    );
    if (entry.status !== 201) fail("watchlist entry", entry);
    out(
      `seed: ${t.slug} (${id}) entities=${String(Object.keys(ids).length)} watchlist="${WATCHLIST.name}" (${wlId}) ← Globex Clearing`,
    );
  }
  out("seed: done (re-runnable)");
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
