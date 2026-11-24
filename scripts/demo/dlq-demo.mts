// Phase 7 exit demo (FR-MSG-01..03; PROJECT.md §11 "forced failure demo"): with ClamAV stopped, a clean upload's
// files.validation.q delivery fails TRANSIENT (DEPENDENCY_UNAVAILABLE) → retries through the 1 s / 5 s / 30 s TTL
// queues → DLQ → events dead-letter registry. ClamAV comes back, the PLATFORM_ADMIN replays the dead letter through
// /v1/ops/dead-letters/{id}/replay, and the file ends VALIDATED. The password arrives in the environment from
// scripts/demo/dlq-demo.sh and is never printed. Local stack only.
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

const BASE = process.env["GATEWAY_URL"] ?? "http://127.0.0.1:8080";
const STATE = new URL("../../.seed-state.json", import.meta.url);
const TENANT_SLUG = "tenant-acme-capital";
const COMPOSE = ["compose", "--env-file", ".env", "-f", "deploy/compose/docker-compose.yml"];

interface Reply {
  status: number;
  body: { data?: unknown; error?: { code: string; message: string } };
}

const out = (line: string): boolean => process.stdout.write(`demo-dlq: ${line}\n`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const compose = (...args: string[]): string => execFileSync("docker", [...COMPOSE, ...args], { encoding: "utf8" });

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

function data<T>(r: Reply, expected: number[], what: string): T {
  if (!expected.includes(r.status) || r.body.data === undefined) {
    throw new Error(`${what}: HTTP ${String(r.status)} ${r.body.error?.code ?? ""} ${r.body.error?.message ?? ""}`);
  }
  return r.body.data as T;
}

async function fileStatus(token: string, as: Record<string, string>, fileId: string): Promise<string> {
  const f = data<Record<string, unknown>>(await call("GET", `/v1/files/${fileId}`, token, as), [200], "get file");
  return String(f["status"]);
}

/** The files consumer's own retry/DLQ log lines for this delivery (structured JSON, no payloads). */
function retryLog(since: string, eventId: string): string[] {
  const lines = compose("logs", "files", "--no-log-prefix", "--since", since).split("\n");
  const picked: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("{")) continue;
    const l = JSON.parse(line) as Record<string, unknown>;
    if (l["eventId"] !== eventId || l["queue"] !== "files.validation.q") continue;
    if (l["msg"] === "handler failed; scheduled retry" || l["msg"] === "message dead-lettered") {
      picked.push(
        `${String(l["ts"])}  retryCount=${String(l["retryCount"])}  ${String(l["msg"])}${l["tier"] === undefined ? "" : ` → ${String(l["tier"])}`}  code=${String(l["code"])}`,
      );
    }
  }
  return picked;
}

/** The registry's outbox events land in the archive on the failed upload's correlation chain. */
async function opsEvents(token: string, as: Record<string, string>, correlationId: string): Promise<void> {
  const wanted = ["ops.dead_letter.recorded", "ops.audit.dead_letter_resolved"];
  for (let i = 0; i < 60; i++) {
    const rows = data<Record<string, unknown>[]>(
      await call("GET", `/v1/events?correlationId=${encodeURIComponent(correlationId)}&limit=50`, token, as),
      [200],
      "search events",
    );
    const types = rows.map((r) => String(r["eventType"]));
    if (wanted.every((t) => types.includes(t))) {
      out(`7. archived on ${correlationId}: ${types.join(", ")}`);
      return;
    }
    await sleep(500);
  }
  throw new Error("ops.dead_letter.recorded / ops.audit.dead_letter_resolved not archived within 30 s");
}

async function main(): Promise<void> {
  const password = process.env["SEED_PA_PASSWORD"];
  if (password === undefined || password === "") throw new Error("SEED_PA_PASSWORD is not set (run via make demo-dlq)");
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

  out("1. stopping ClamAV (the scanner dependency) to force TRANSIENT failures");
  compose("stop", "clamav");
  const since = new Date().toISOString();

  const body = Buffer.from(`%PDF-1.7\n% dlq demo ${randomUUID()}\n`);
  const init = data<Record<string, unknown>>(
    await call("POST", "/v1/files/uploads/init", token, as, {
      filename: "dlq-demo.pdf",
      contentType: "application/pdf",
      sizeBytes: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      purpose: "FILING",
      allowDuplicate: true,
    }),
    [201],
    "init",
  );
  const fileId = String(init["fileId"]);
  const target = init["upload"] as { url: string; headers: Record<string, string> };
  const put = await fetch(target.url, { method: "PUT", headers: target.headers, body });
  if (put.status !== 200) throw new Error(`PUT: HTTP ${String(put.status)}`);
  data(await call("POST", `/v1/files/uploads/${fileId}/complete`, token, as), [200], "complete");
  const completedAt = Date.now();
  out(`2. uploaded dlq-demo.pdf (fileId ${fileId}); file.uploaded → files.validation.q`);

  out("3. waiting for retries (1 s, 5 s, 30 s) and the dead-letter registry entry …");
  let dead: Record<string, unknown> | undefined;
  for (let i = 0; i < 120 && dead === undefined; i++) {
    await sleep(1_000);
    const page = data<Record<string, unknown>[]>(
      await call("GET", "/v1/ops/dead-letters?queue=files.validation.q&limit=20", token, as),
      [200],
      "list dead letters",
    );
    for (const s of page.filter((d) => d["status"] === "OPEN")) {
      const d = data<Record<string, unknown>>(
        await call("GET", `/v1/ops/dead-letters/${String(s["id"])}`, token, as),
        [200],
        "get dead letter",
      );
      const payload = (d["envelope"] as { payload?: { fileId?: string } }).payload;
      if (payload?.fileId === fileId) dead = d;
    }
  }
  if (dead === undefined) throw new Error("no dead letter for the upload within 120 s");
  const eventId = String(dead["eventId"]);
  for (const line of retryLog(since, eventId)) out(`   ${line}`);
  out(
    `   registry: id=${String(dead["id"])} status=${String(dead["status"])} errorCode=${String(dead["errorCode"])} ` +
      `retryCount=${String(dead["retryCount"])} stackHash=${String(dead["stackHash"])} ` +
      `(${String(Math.round((Date.parse(String(dead["lastFailedAt"])) - completedAt) / 1000))} s after complete)`,
  );
  out(`   errorMessage: ${String(dead["errorMessage"])}`);
  out(`   file status while dead-lettered: ${await fileStatus(token, as, fileId)}`);

  out("4. restarting ClamAV and waiting until it is healthy …");
  compose("up", "-d", "--wait", "clamav");

  out("5. replaying the dead letter (POST /v1/ops/dead-letters/{id}/replay)");
  const replayed = data<Record<string, unknown>>(
    await call(
      "POST",
      `/v1/ops/dead-letters/${String(dead["id"])}/replay`,
      token,
      { ...as, "idempotency-key": randomUUID() },
      {},
    ),
    [200],
    "replay",
  );
  out(`   status=${String(replayed["status"])} resolvedBy=${String(replayed["resolvedBy"])}`);

  for (let i = 0; i < 120; i++) {
    const status = await fileStatus(token, as, fileId);
    if (status !== "UPLOADED") {
      out(`6. file status after replay: ${status}`);
      if (status !== "VALIDATED") throw new Error(`expected VALIDATED, got ${status}`);
      await opsEvents(token, as, String((dead["envelope"] as { correlationId?: string }).correlationId ?? ""));
      return;
    }
    await sleep(500);
  }
  throw new Error("file still UPLOADED 60 s after the replay");
}

main().catch((error: unknown) => {
  process.stderr.write(`demo-dlq: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
