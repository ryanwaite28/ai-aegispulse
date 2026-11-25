// /v1/files/uploads* (FR-FILE-01..04): transport only. The gateway forwards the caller's token, X-Aegis-Tenant and
// Idempotency-Key to files, maps init to 201 (new) or 200 (dedup hit), and validates the path id locally.
import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Writable } from "node:stream";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JwtVerifier } from "@aegispulse/ts-platform/auth";
import { HealthRegistry } from "@aegispulse/ts-platform/health";
import { createLogger } from "@aegispulse/ts-platform/logging";
import type { Config } from "../config.js";
import { createGateway } from "../main.js";

const FILE_ID = "0b6f3c1e-2f4a-4c55-9d2e-6a7b8c9d0e1f";
const TENANT = "8a92269a-91aa-4d80-b6fd-093a350304fe";
let fake: Server;
let app: Awaited<ReturnType<typeof createGateway>>;
let token: string;
let auditorToken: string;
let deduplicated = false;
let notScored = false;
let seen: {
  path: string;
  auth?: string | undefined;
  tenant?: string | undefined;
  idem?: string | undefined;
  body: Record<string, unknown>;
}[] = [];

beforeAll(async () => {
  fake = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const h = (n: string): string | undefined => (typeof req.headers[n] === "string" ? req.headers[n] : undefined);
      seen.push({
        path: req.url ?? "",
        ...(h("authorization") === undefined ? {} : { auth: h("authorization") }),
        ...(h("x-aegis-tenant") === undefined ? {} : { tenant: h("x-aegis-tenant") }),
        ...(h("idempotency-key") === undefined ? {} : { idem: h("idempotency-key") }),
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });
      if (req.url === "/internal/v1/getTransactionEvaluation" && notScored) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "no evaluation", details: [] }, meta: {} }));
        return;
      }
      if (req.url === "/internal/v1/getTransactionEvaluation") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: "e-1", score: 82, caseId: FILE_ID }, meta: {} }));
        return;
      }
      const data =
        req.url === "/internal/v1/initUpload"
          ? { fileId: FILE_ID, status: "INITIATED", deduplicated }
          : { id: FILE_ID, status: "UPLOADED" };
      res.writeHead(deduplicated || req.url !== "/internal/v1/initUpload" ? 200 : 201, {
        "content-type": "application/json",
      });
      res.end(JSON.stringify({ data, meta: {} }));
    });
  });
  await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${String((fake.address() as AddressInfo).port)}`;
  const config = {
    AEGIS_ENV: "local",
    LOG_LEVEL: "info",
    OTEL_SERVICE_NAMESPACE: "aegispulse",
    REGISTRY_URL: url,
    INGESTION_URL: url,
    CASES_URL: url,
    FILES_URL: url,
    EVENTS_URL: url,
    JWT_ISSUER: "aegispulse-registry",
    JWT_AUDIENCE: "aegispulse",
    SERVICE_CLIENT_ID: "svc-gateway",
    SERVICE_CLIENT_SECRET: randomBytes(16).toString("hex"),
  } as Config;
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" }] });
  const verifier = new JwtVerifier({ jwks, issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE });
  token = await new SignJWT({ typ: "user", tid: "t-1", tslug: "acme", roles: ["PLATFORM_ADMIN"] })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject("u-1")
    .setJti("j-1")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  auditorToken = await new SignJWT({ typ: "user", tid: TENANT, tslug: "acme", roles: ["COMPLIANCE_AUDITOR"] })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE)
    .setSubject("u-2")
    .setJti("j-2")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  const logger = createLogger({
    service: "gateway",
    version: "test",
    env: "local",
    destination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
  app = await createGateway(config, verifier, new HealthRegistry(), logger);
});

afterAll(async () => {
  await app.close();
  fake.closeAllConnections();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  deduplicated = false;
  notScored = false;
});

const get = (url: string, headers: Record<string, string> = {}): Promise<{ statusCode: number }> =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({ method: "GET", url, headers: { authorization: `Bearer ${token}`, ...headers } });

const post = (
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ statusCode: number; json: () => unknown }> =>
  app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });

describe("files upload routes over the gateway (FR-FILE-01..04)", () => {
  it("init forwards token, X-Aegis-Tenant and Idempotency-Key; 201 for a new upload, 200 for a dedup hit", async () => {
    const input = {
      filename: "a.pdf",
      contentType: "application/pdf",
      sizeBytes: 3,
      sha256: "a".repeat(64),
      purpose: "FILING",
    };
    const created = await post("/v1/files/uploads/init", input, { "x-aegis-tenant": TENANT, "idempotency-key": "k-1" });
    expect(created.statusCode).toBe(201);
    expect(seen[0]).toEqual({
      path: "/internal/v1/initUpload",
      auth: `Bearer ${token}`,
      tenant: TENANT,
      idem: "k-1",
      body: input,
    });
    deduplicated = true;
    const dup = await post("/v1/files/uploads/init", input, { "x-aegis-tenant": TENANT });
    expect(dup.statusCode).toBe(200);
    expect(dup.json()).toMatchObject({ data: { fileId: FILE_ID, deduplicated: true } });
  });

  it("complete/abort send the path id (no body needed); a malformed id is a local 404 (uuidParam convention)", async () => {
    expect(
      (await post(`/v1/files/uploads/${FILE_ID}/complete`, undefined, { "x-aegis-tenant": TENANT })).statusCode,
    ).toBe(200);
    expect((await post(`/v1/files/uploads/${FILE_ID}/abort`, undefined, { "x-aegis-tenant": TENANT })).statusCode).toBe(
      200,
    );
    expect(seen.map((s) => [s.path, s.body])).toEqual([
      ["/internal/v1/completeUpload", { fileId: FILE_ID }],
      ["/internal/v1/abortUpload", { fileId: FILE_ID }],
    ]);
    expect((await post("/v1/files/uploads/not-a-uuid/complete")).statusCode).toBe(404);
    expect(seen).toHaveLength(2);
  });

  it("GET routes pass filters through, map acknowledgeQuarantine to a boolean, and reject other values locally", async () => {
    const t = { "x-aegis-tenant": TENANT };
    expect((await get("/v1/files?status=VALIDATED&limit=5", t)).statusCode).toBe(200);
    expect((await get(`/v1/files/${FILE_ID}`, t)).statusCode).toBe(200);
    expect((await get(`/v1/files/${FILE_ID}/download-url?acknowledgeQuarantine=true`, t)).statusCode).toBe(200);
    expect((await get(`/v1/files/${FILE_ID}/download-url`, t)).statusCode).toBe(200);
    expect(seen.map((x) => [x.path, x.body, x.tenant])).toEqual([
      ["/internal/v1/listFiles", { status: "VALIDATED", limit: 5 }, TENANT],
      ["/internal/v1/getFile", { fileId: FILE_ID }, TENANT],
      ["/internal/v1/getDownloadUrl", { fileId: FILE_ID, acknowledgeQuarantine: true }, TENANT],
      ["/internal/v1/getDownloadUrl", { fileId: FILE_ID, acknowledgeQuarantine: false }, TENANT],
    ]);
    expect((await get(`/v1/files/${FILE_ID}/download-url?acknowledgeQuarantine=yes`, t)).statusCode).toBe(422);
    expect(seen).toHaveLength(4);
  });
});

describe("dead-letter routes over the gateway (FR-MSG-03)", () => {
  const ID = "6745c1f0a3b2c4d5e6f70812";

  it("list/get forward filters and X-Aegis-Tenant (PLATFORM_ADMIN may omit it); replay/discard forward Idempotency-Key", async () => {
    expect((await get("/v1/ops/dead-letters?queue=files.validation.q&errorCode=NOT_FOUND&limit=10")).statusCode).toBe(
      200,
    );
    expect((await get(`/v1/ops/dead-letters/${ID}`, { "x-aegis-tenant": TENANT })).statusCode).toBe(200);
    expect((await post(`/v1/ops/dead-letters/${ID}/replay`, undefined, { "idempotency-key": "r-1" })).statusCode).toBe(
      200,
    );
    expect((await post(`/v1/ops/dead-letters/${ID}/discard`, { reason: "fixed upstream" })).statusCode).toBe(200);
    expect(seen.map((x) => [x.path, x.body, x.tenant, x.idem])).toEqual([
      [
        "/internal/v1/listDeadLetters",
        { queue: "files.validation.q", errorCode: "NOT_FOUND", limit: 10 },
        undefined,
        undefined,
      ],
      ["/internal/v1/getDeadLetter", { deadLetterId: ID }, TENANT, undefined],
      ["/internal/v1/replayDeadLetter", { deadLetterId: ID }, undefined, "r-1"],
      ["/internal/v1/discardDeadLetter", { reason: "fixed upstream", deadLetterId: ID }, undefined, undefined],
    ]);
  });

  it("a malformed id is a local 404 and never reaches events", async () => {
    expect((await get("/v1/ops/dead-letters/not%20an%20id")).statusCode).toBe(404);
    expect((await post("/v1/ops/dead-letters/a.b/replay")).statusCode).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

describe("transaction intake over the gateway (FR-TXN-01)", () => {
  it("forwards the body, token, X-Aegis-Tenant and Idempotency-Key to ingestion and answers 202", async () => {
    const body = { idempotencyKey: "t-1", accountId: "a", amount: "1.00" };
    const r = await post("/v1/transactions", body, { "x-aegis-tenant": TENANT, "idempotency-key": "t-1" });
    expect(r.statusCode).toBe(202);
    expect(seen.map((x) => [x.path, x.body, x.tenant, x.idem])).toEqual([
      ["/internal/v1/submitTransaction", body, TENANT, "t-1"],
    ]);
  });
});

describe("transaction detail over the gateway (FR-TXN-06)", () => {
  const TXN = "1c9e0f4a-7a33-4b44-9c6d-7e8f9a0b1c2d";

  it("composes the submission with the latest evaluation: CASE_OPENED when a case is linked", async () => {
    const r = (await get(`/v1/transactions/${TXN}`, { "x-aegis-tenant": TENANT })) as {
      statusCode: number;
      json: () => { data: Record<string, unknown> };
    };
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toMatchObject({
      processingStatus: "CASE_OPENED",
      caseId: FILE_ID,
      latestEvaluation: { score: 82 },
    });
    expect(seen.map((x) => [x.path, x.body, x.tenant])).toEqual([
      ["/internal/v1/getTransaction", { transactionId: TXN }, TENANT],
      ["/internal/v1/getTransactionEvaluation", { transactionId: TXN }, TENANT],
    ]);
  });

  it("ACCEPTED with a null evaluation while cases has none (404); malformed ids are a local 404", async () => {
    notScored = true;
    const r = (await get(`/v1/transactions/${TXN}`)) as {
      statusCode: number;
      json: () => { data: Record<string, unknown> };
    };
    expect(r.json().data).toMatchObject({ processingStatus: "ACCEPTED", latestEvaluation: null, caseId: null });
    expect((await get("/v1/transactions/nope")).statusCode).toBe(404);
  });
});

describe("audit routes over the gateway (FR-AUD-03)", () => {
  it("list passes filters; verify passes integer seq bounds and rejects others locally", async () => {
    const auditor = { authorization: `Bearer ${auditorToken}` };
    expect((await get("/v1/audit")).statusCode).toBe(403); // PLATFORM_ADMIN is not an audit role
    expect((await get("/v1/audit?action=CASE_TRANSITION&limit=5", auditor)).statusCode).toBe(200);
    expect((await get("/v1/audit/verify?fromSeq=2&toSeq=9", auditor)).statusCode).toBe(200);
    expect(seen.map((x) => [x.path, x.body])).toEqual([
      ["/internal/v1/listAuditEntries", { action: "CASE_TRANSITION", limit: 5 }],
      ["/internal/v1/verifyAuditChain", { fromSeq: 2, toSeq: 9 }],
    ]);
    expect((await get("/v1/audit/verify?fromSeq=0", auditor)).statusCode).toBe(422);
    expect((await get("/v1/audit/verify?toSeq=abc", auditor)).statusCode).toBe(422);
    expect(seen).toHaveLength(2);
  });
});
