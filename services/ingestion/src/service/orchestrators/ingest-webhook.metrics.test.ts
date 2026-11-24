// Regression (Phase 4 exit): aegispulse_webhook_rejected_total was created at module load, before the MeterProvider
// existed, so it never recorded. Here the provider is installed after the module is imported — exactly as in main().
import { Writable } from "node:stream";
import { metrics } from "@opentelemetry/api";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { afterAll, describe, expect, it } from "vitest";
import type { ServicePrincipal } from "@aegispulse/ts-platform/auth";
import { createLogger } from "@aegispulse/ts-platform/logging";
import type { OutboxRepository, SqlPool } from "@aegispulse/ts-platform/outbox";
import { parseKek } from "../../domain/crypto.js";
import type { WebhookDeliveryRepository } from "../../db/webhook-deliveries.repository.js";
import { IngestWebhookUseCase } from "./ingest-webhook.usecase.js";

const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 3_600_000 });
const provider = new MeterProvider({ readers: [reader] });
metrics.setGlobalMeterProvider(provider);

afterAll(async () => {
  await provider.shutdown();
  metrics.disable();
});

const gateway: ServicePrincipal = {
  kind: "service",
  clientId: "svc-gateway",
  actions: ["ingestion.ingestWebhookDelivery"],
};

describe("webhook rejection metric (FR-WHK-03, NFR-07)", () => {
  it("records rejections once telemetry has started, labelling unknown source keys as 'unknown'", async () => {
    const usecase = new IngestWebhookUseCase({
      pool: {} as SqlPool,
      deliveries: { sourceForDelivery: () => Promise.resolve(undefined) } as unknown as WebhookDeliveryRepository,
      outbox: {} as OutboxRepository,
      nonces: { claim: () => Promise.resolve(true) },
      raw: { put: () => Promise.resolve() },
      tenants: { isActive: () => Promise.resolve(true) },
      kek: parseKek(Buffer.alloc(32, 1).toString("base64"), 1),
      version: "test",
      logger: createLogger({
        service: "ingestion",
        version: "t",
        env: "local",
        destination: new Writable({ write: (_c, _e, cb) => cb() }),
      }),
    });
    const input = {
      headers: {},
      rawBodyBase64: "",
      receivedAt: new Date().toISOString(),
      clientIp: "203.0.113.9",
    };
    for (const sourceKey of ["random-a", "random-b"]) {
      await expect(usecase.execute(gateway, { ...input, sourceKey })).rejects.toMatchObject({
        code: "WEBHOOK_SOURCE_NOT_FOUND",
      });
    }
    await reader.forceFlush();
    const points = exporter
      .getMetrics()
      .flatMap((r) => r.scopeMetrics.flatMap((s) => s.metrics))
      .filter((m) => m.descriptor.name === "aegispulse_webhook_rejected_total")
      .flatMap((m) => m.dataPoints as readonly { attributes: unknown; value: unknown }[]);
    expect(points.map((p) => ({ attrs: p.attributes, value: p.value }))).toEqual([
      { attrs: { source: "unknown", reason: "source" }, value: 2 },
    ]);
  });
});
