// Phase 5 exit demo (FR-FILE-01..05): init → presigned PUT → complete → VALIDATED (and doc.file.ready on the broker),
// plus an EICAR upload that ends QUARANTINED. Runs through the gateway as the bootstrap PLATFORM_ADMIN acting on the
// seeded demo tenant (X-Aegis-Tenant); the password arrives in the environment from scripts/demo/upload.sh and is
// never printed. Re-runnable: every run uploads fresh content.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env["GATEWAY_URL"] ?? "http://127.0.0.1:8080";
const STATE = new URL("../../.seed-state.json", import.meta.url);
const TENANT_SLUG = "tenant-acme-capital";
// The standard antivirus test string (harmless by design), assembled so the source file itself is not flagged.
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join("");

interface Reply {
  status: number;
  body: { data?: Record<string, unknown>; error?: { code: string; message: string } };
}

async function call(
  method: string,
  path: string,
  token: string,
  headers: Record<string, string>,
  body?: unknown,
): Promise<Reply> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? {} : (JSON.parse(text) as Reply["body"]) };
}

function data(r: Reply, expected: number[], what: string): Record<string, unknown> {
  if (!expected.includes(r.status) || r.body.data === undefined) {
    throw new Error(`${what}: HTTP ${String(r.status)} ${r.body.error?.code ?? ""} ${r.body.error?.message ?? ""}`);
  }
  return r.body.data;
}

const out = (line: string): boolean => process.stdout.write(`demo-upload: ${line}\n`);

async function upload(
  token: string,
  as: Record<string, string>,
  name: string,
  contentType: string,
  body: Buffer,
): Promise<string> {
  const init = data(
    await call("POST", "/v1/files/uploads/init", token, as, {
      filename: name,
      contentType,
      sizeBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      purpose: "FILING",
      allowDuplicate: true,
    }),
    [201],
    `init ${name}`,
  );
  const fileId = String(init["fileId"]);
  const target = init["upload"] as { url: string; headers: Record<string, string> };
  const put = await fetch(target.url, { method: "PUT", headers: target.headers, body });
  if (put.status !== 200) throw new Error(`PUT ${name}: HTTP ${String(put.status)}`);
  const done = data(await call("POST", `/v1/files/uploads/${fileId}/complete`, token, as), [200], `complete ${name}`);
  out(`${name}: init 201 → PUT 200 → complete → ${String(done["status"])} (fileId ${fileId})`);
  for (let i = 0; i < 120; i++) {
    const f = data(await call("GET", `/v1/files/${fileId}`, token, as), [200], `get ${name}`);
    if (f["status"] !== "UPLOADED") {
      const reason = f["failureReason"] === null ? "" : ` reason=${String(f["failureReason"])}`;
      out(`${name}: ${String(f["status"])} detectedType=${String(f["detectedType"])}${reason}`);
      return String(f["status"]);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${name}: still UPLOADED after 60 s`);
}

async function main(): Promise<void> {
  const password = process.env["SEED_PA_PASSWORD"];
  if (password === undefined || password === "")
    throw new Error("SEED_PA_PASSWORD is not set (run via make demo-upload)");
  const state = (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {}) as Record<string, string>;
  const tenantId = state[TENANT_SLUG];
  if (tenantId === undefined) throw new Error(`no ${TENANT_SLUG} in .seed-state.json (run make seed first)`);
  const login = await fetch(`${BASE}/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tenantSlug: "platform",
      email: process.env["SEED_PA_EMAIL"] ?? "admin@aegispulse.local",
      password,
    }),
  });
  const token = String(((await login.json()) as { data?: { accessToken?: string } }).data?.accessToken ?? "");
  if (login.status !== 200 || token === "") throw new Error(`platform admin login: HTTP ${String(login.status)}`);
  const as = { "x-aegis-tenant": tenantId };

  const clean = await upload(
    token,
    as,
    "q3-filing.pdf",
    "application/pdf",
    Buffer.from(`%PDF-1.7\n% demo filing ${randomUUID()}\n`),
  );
  const eicar = await upload(token, as, "eicar.txt", "text/plain", Buffer.from(EICAR));
  out("doc.file.ready for the clean file waits on doc.extraction.q (consumer arrives in Phase 11)");
  if (clean !== "VALIDATED" || eicar !== "QUARANTINED") throw new Error("unexpected outcome");
}

main().catch((error: unknown) => {
  process.stderr.write(`demo-upload: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
