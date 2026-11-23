import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { DomainError, TransientError } from "../errors/index.js";
import { HealthRegistry } from "../health/index.js";
import { createLogger, getContext } from "../logging/index.js";
import { createHttpServer, registerHealthRoutes } from "./index.js";

const logger = createLogger({
  service: "t",
  version: "v",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

function app(): ReturnType<typeof createHttpServer> {
  const server = createHttpServer({ logger, bodyLimit: 64 });
  server.get("/ctx", async () => getContext());
  server.post("/echo", async (req) => req.body);
  server.get("/domain", async () => {
    throw new DomainError("NOT_FOUND", "no such case");
  });
  server.get("/transient", async () => {
    throw new TransientError("DEPENDENCY_UNAVAILABLE", "scanner down");
  });
  server.get("/boom", async () => {
    throw new Error("secret internal detail");
  });
  return server;
}

describe("createHttpServer (§8.2, NFR-07)", () => {
  it("keeps well-formed request/correlation ids, mints others, and binds them to the log context", async () => {
    const server = app();
    const good = "corr-0b6e1e6c-6a7d-4c35-9d3b-7f1d4f3b2a10";
    const res = await server.inject({ url: "/ctx", headers: { "x-correlation-id": good, "x-request-id": "req_1" } });
    expect(res.json()).toEqual({ correlationId: good, requestId: "req_1" });
    expect(res.headers["x-correlation-id"]).toBe(good);
    const minted = await server.inject({ url: "/ctx", headers: { "x-correlation-id": "<script>" } });
    expect(minted.headers["x-correlation-id"]).toMatch(/^corr-[0-9a-f-]{36}$/);
    expect(minted.headers["x-request-id"]).toMatch(/^req_/);
  });

  it("maps errors to §8.2 envelopes without leaking internals", async () => {
    const server = app();
    const domain = await server.inject({ url: "/domain" });
    expect(domain.statusCode).toBe(404);
    expect(domain.json()).toMatchObject({
      error: { code: "NOT_FOUND", message: "no such case" },
      meta: { correlationId: expect.any(String) },
    });
    expect((await server.inject({ url: "/transient" })).statusCode).toBe(503);
    const boom = await server.inject({ url: "/boom" });
    expect(boom.statusCode).toBe(500);
    expect(boom.json().error).toEqual({ code: "INTERNAL_ERROR", message: "internal error", details: [] });
    expect(boom.body).not.toContain("secret internal detail");
    const tooBig = await server.inject({ method: "POST", url: "/echo", payload: { x: "y".repeat(200) } });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe("PAYLOAD_TOO_LARGE");
    const missing = await server.inject({ url: "/nope" });
    expect([missing.statusCode, missing.json().error.code]).toEqual([404, "NOT_FOUND"]);
  });

  it("serves probes: livez always, readyz 503 until running and healthy (NFR-11)", async () => {
    const server = createHttpServer({ logger });
    const health = new HealthRegistry().addCheck("db", async () => undefined);
    registerHealthRoutes(server, health);
    expect((await server.inject({ url: "/livez" })).json()).toEqual({ status: "ok" });
    expect((await server.inject({ url: "/readyz" })).statusCode).toBe(503);
    health.markRunning();
    expect((await server.inject({ url: "/readyz" })).statusCode).toBe(200);
    expect((await server.inject({ url: "/healthz" })).json()).toMatchObject({
      ready: true,
      checks: [{ name: "db", status: "up" }],
    });
  });
});
