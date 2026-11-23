// events composition root (Phase 1e skeleton): config → telemetry → logs → owned clients → probes → HTTP.
// No business logic: service actions, repositories and adapters arrive with their FRs.
import { amqpReadyCheck, createAmqpClient } from "@aegispulse/ts-platform/amqp";
import { buildVersion } from "@aegispulse/ts-platform/build-info";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import { connectWithRetry, HealthRegistry, Lifecycle } from "@aegispulse/ts-platform/health";
import { createHttpServer, registerHealthRoutes } from "@aegispulse/ts-platform/http";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { startTelemetry } from "@aegispulse/ts-platform/telemetry";
import { configSchema, PORT, SERVICE } from "./config.js";
import { connectMongo, mongoPingCheck, mongoSchemaCheck } from "./db/mongo.js";
import { createObjectStore, objectStoreCheck } from "./storage/objectstore.js";

async function main(): Promise<void> {
  const config = loadConfig(configSchema);
  const version = buildVersion();
  const telemetry = startTelemetry({
    serviceName: `aegispulse-${SERVICE}`,
    serviceVersion: version,
    env: config.AEGIS_ENV,
    serviceNamespace: config.OTEL_SERVICE_NAMESPACE,
  });
  const logger = createLogger({ service: SERVICE, version, env: config.AEGIS_ENV, level: config.LOG_LEVEL });
  const health = new HealthRegistry();
  const lifecycle = new Lifecycle({ logger, health }).install();

  const mongo = await connectWithRetry("mongo", () => connectMongo(config), { logger });
  health.addCheck("mongo", mongoPingCheck(mongo)).addCheck("schema", mongoSchemaCheck(mongo));
  lifecycle.onShutdown("pools", "mongo", () => mongo.close());
  const s3 = createObjectStore(config);
  health.addCheck("objectstore", objectStoreCheck(s3, config));
  lifecycle.onShutdown("pools", "objectstore", async () => s3.destroy());
  const amqp = createAmqpClient({
    url: config.AMQP_URL,
    service: `aegispulse-${SERVICE}`,
    logger,
    consumes: ["events.archive.q", "events.classification.q", "events.deadletter.q"],
    publishesTo: ["aegispulse.enrichment", "aegispulse.intelligence"],
    defaultPrefetch: config.AMQP_PREFETCH_DEFAULT,
  });
  await connectWithRetry("rabbitmq", () => amqp.init(), { logger });
  health.addCheck("rabbitmq", amqpReadyCheck(amqp));
  lifecycle.onShutdown("consumers", "rabbitmq", () => amqp.close({ drainTimeoutMs: 20_000 }));

  const app = createHttpServer({ logger });
  registerHealthRoutes(app, health);
  await app.listen({ host: "0.0.0.0", port: PORT });
  lifecycle
    .onShutdown("http", "fastify", () => app.close())
    .onShutdown("telemetry", "otel", () => telemetry.shutdown());
  health.markRunning();
  logger.info({ port: PORT }, "events ready");
}

main().catch((error: unknown) => {
  // Config problems are listed key by key (never values); anything else is a startup failure.
  const detail = error instanceof ConfigError ? { issues: error.issues } : { err: String(error) };
  process.stderr.write(`${JSON.stringify({ level: "fatal", service: SERVICE, msg: "startup failed", ...detail })}\n`);
  process.exit(1);
});
