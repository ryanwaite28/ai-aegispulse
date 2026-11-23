import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logging/index.js";
import type { SqlExecutor } from "../outbox/sql.js";
import { connectWithRetry, flywaySchemaVersionCheck, HealthRegistry, Lifecycle } from "./index.js";

const silent = createLogger({
  service: "t",
  version: "v",
  env: "local",
  destination: new Writable({ write: (_c, _e, cb) => cb() }),
});

describe("HealthRegistry (NFR-11)", () => {
  it("is not ready while starting or stopping, and reports each check", async () => {
    const health = new HealthRegistry()
      .addCheck("postgres", async () => undefined)
      .addCheck("amqp", async () => undefined);
    expect((await health.readyz()).ready).toBe(false);
    health.markRunning();
    const ready = await health.readyz();
    expect(ready.ready).toBe(true);
    expect(ready.checks.map((c) => [c.name, c.status])).toEqual([
      ["postgres", "up"],
      ["amqp", "up"],
    ]);
    health.markStopping();
    expect((await health.readyz()).ready).toBe(false);
    expect(health.livez()).toEqual({ status: "ok" }); // liveness never depends on dependencies
  });

  it("marks failing and hanging checks down without throwing", async () => {
    const health = new HealthRegistry()
      .addCheck("broken", async () => {
        throw new Error("connection refused");
      })
      .addCheck("hang", () => new Promise(() => undefined), { timeoutMs: 50 });
    health.markRunning();
    const report = await health.readyz();
    expect(report.ready).toBe(false);
    expect(report.checks).toEqual([
      expect.objectContaining({ name: "broken", status: "down", detail: "Error: connection refused" }),
      expect.objectContaining({ name: "hang", status: "down", detail: "Error: timed out after 50ms" }),
    ]);
  });

  it("checks the Flyway version numerically", async () => {
    const db = (versions: string[]): SqlExecutor => ({
      query: async <R>() => ({ rows: versions.map((version) => ({ version })) as R[], rowCount: versions.length }),
    });
    await expect(flywaySchemaVersionCheck(db(["1", "2", "10"]), "files", "9")()).resolves.toBeUndefined();
    await expect(flywaySchemaVersionCheck(db(["1", "2"]), "files", "3")()).rejects.toThrow(
      "schema files at V2, need >= V3",
    );
    await expect(flywaySchemaVersionCheck(db([]), "files", "1")()).rejects.toThrow(/no applied migrations/);
    expect(() => flywaySchemaVersionCheck(db([]), 'files"; drop', "1")).toThrow(TypeError);
  });
});

describe("Lifecycle (NFR-11 graceful shutdown)", () => {
  it("runs stages in order, survives a failing hook, and marks the registry stopping", async () => {
    const order: string[] = [];
    const health = new HealthRegistry();
    health.markRunning();
    const lifecycle = new Lifecycle({ logger: silent, health, exit: () => undefined })
      .onShutdown("pools", "pg", async () => void order.push("pools"))
      .onShutdown("http", "server", async () => void order.push("http"))
      .onShutdown("consumers", "amqp", async () => {
        order.push("consumers");
        throw new Error("cancel failed");
      })
      .onShutdown("outbox", "relay", async () => void order.push("outbox"))
      .onShutdown("telemetry", "otel", async () => void order.push("telemetry"));
    await Promise.all([lifecycle.shutdown("SIGTERM"), lifecycle.shutdown("SIGTERM")]);
    expect(order).toEqual(["http", "consumers", "outbox", "telemetry", "pools"]);
    expect(health.currentPhase).toBe("stopping");
  });

  it("bounds a hanging hook by the grace budget", async () => {
    const lifecycle = new Lifecycle({ logger: silent, graceMs: 50, exit: () => undefined }).onShutdown(
      "http",
      "hang",
      () => new Promise(() => undefined),
    );
    const started = Date.now();
    await lifecycle.shutdown("SIGTERM");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("connectWithRetry (NFR-11 startup order not assumed)", () => {
  it("retries with backoff until the dependency answers", async () => {
    let attempts = 0;
    const value = await connectWithRetry(
      "postgres",
      async () => {
        if (++attempts < 3) throw new Error("ECONNREFUSED");
        return "connected";
      },
      { logger: silent, initialDelayMs: 1 },
    );
    expect([value, attempts]).toEqual(["connected", 3]);
  });

  it("gives up after the max wait", async () => {
    await expect(
      connectWithRetry(
        "amqp",
        async () => {
          throw new Error("down");
        },
        { logger: silent, maxWaitMs: 30, initialDelayMs: 5 },
      ),
    ).rejects.toThrow("down");
  });
});
