// Real local HTTP server (no HTTP mocking): retries, timeouts, status mapping, breaker, internal RPC.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TransientError } from "../errors/index.js";
import { runWithContext } from "../logging/context.js";
import { HttpClient, HttpStatusError, InternalServiceClient } from "./index.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;
let handler: Handler = (_req, res) => res.end();
let hits = 0;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits++;
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
};

describe("HttpClient (PROJECT.md §6.5, NFR-10)", () => {
  it("retries idempotent calls up to 2 times on 5xx, then succeeds", async () => {
    hits = 0;
    handler = (_req, res) => (hits < 3 ? json(res, 503, {}) : json(res, 200, { ok: true }));
    const client = new HttpClient({ name: "dep", baseUrl, timeoutMs: 1000, retryBaseMs: 1 });
    await expect(client.request({ method: "GET", path: "/x" })).resolves.toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(hits).toBe(3);
    await client.close();
  });

  it("never retries non-idempotent calls", async () => {
    hits = 0;
    handler = (_req, res) => json(res, 502, {});
    const client = new HttpClient({ name: "dep", baseUrl, timeoutMs: 1000, retryBaseMs: 1 });
    await expect(client.request({ method: "POST", path: "/x", body: { a: 1 } })).rejects.toBeInstanceOf(TransientError);
    expect(hits).toBe(1);
    await client.close();
  });

  it("maps 4xx to HttpStatusError with the §8.2 envelope code, without retrying", async () => {
    hits = 0;
    handler = (_req, res) => json(res, 404, { error: { code: "NOT_FOUND", message: "nope" }, meta: {} });
    const client = new HttpClient({ name: "registry", baseUrl, timeoutMs: 1000, retryBaseMs: 1 });
    const error = await client.request({ method: "GET", path: "/x" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpStatusError);
    expect(error).toMatchObject({ status: 404, code: "NOT_FOUND", dependency: "registry" });
    expect(hits).toBe(1);
    await client.close();
  });

  it("treats 429 as transient and times out slow dependencies", async () => {
    handler = (_req, res) => json(res, 429, {});
    const client = new HttpClient({ name: "dep", baseUrl, timeoutMs: 100, maxRetries: 0 });
    await expect(client.request({ method: "GET", path: "/x" })).rejects.toBeInstanceOf(TransientError);
    handler = (_req, res) => setTimeout(() => json(res, 200, {}), 500);
    const error = await client.request({ method: "GET", path: "/slow" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect((error as Error).message).toMatch(/timed out after 100ms/);
    await client.close();
  });

  it("opens the breaker after >= 50% failures over 20 calls; open is a TransientError (CIRCUIT_OPEN)", async () => {
    handler = (_req, res) => json(res, 500, {});
    const client = new HttpClient({ name: "scanner", baseUrl, timeoutMs: 1000, maxRetries: 0 });
    for (let i = 0; i < 20; i++) await client.request({ method: "GET", path: "/x" }).catch(() => undefined);
    expect(client.breakerState).toBe("open");
    hits = 0;
    const error = await client.request({ method: "GET", path: "/x" }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "TransientError", code: "CIRCUIT_OPEN" });
    expect(hits).toBe(0); // short-circuited, the dependency is not called
    await client.close();
  });

  it("4xx answers never open the breaker", async () => {
    handler = (_req, res) => json(res, 409, { error: { code: "CONFLICT" } });
    const client = new HttpClient({ name: "cases", baseUrl, timeoutMs: 1000 });
    for (let i = 0; i < 25; i++) await client.request({ method: "GET", path: "/x" }).catch(() => undefined);
    expect(client.breakerState).toBe("closed");
    await client.close();
  });
});

describe("InternalServiceClient (PROJECT.md §6.2 uniform RPC)", () => {
  it("POSTs /internal/v1/{action} with the service token and correlation id, returning data", async () => {
    let seen: { url?: string | undefined; auth?: string | undefined; corr?: string | undefined; body?: unknown } = {};
    handler = (req, res, body) => {
      seen = {
        url: req.url,
        auth: req.headers.authorization,
        corr: req.headers["x-correlation-id"] as string,
        body: JSON.parse(body) as unknown,
      };
      json(res, 200, { data: { tenantId: "t-1", retentionDays: 30 }, meta: {} });
    };
    const client = new InternalServiceClient("registry", {
      name: "registry",
      baseUrl,
      timeoutMs: 1000,
      serviceToken: async () => "svc.jwt.token",
    });
    const data = await runWithContext({ correlationId: "corr-9" }, () =>
      client.invoke("getTenantSettings", { tenantId: "t-1" }, { idempotent: true }),
    );
    expect(data).toEqual({ tenantId: "t-1", retentionDays: 30 });
    expect(seen).toEqual({
      url: "/internal/v1/getTenantSettings",
      auth: "Bearer svc.jwt.token",
      corr: "corr-9",
      body: { tenantId: "t-1" },
    });

    // a forwarded user token wins over the service token
    await client.invoke("getTenantSettings", { tenantId: "t-1" }, { authorization: "Bearer user.jwt" });
    expect(seen.auth).toBe("Bearer user.jwt");
    await client.close();
  });
});
