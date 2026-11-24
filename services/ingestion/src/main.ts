// ingestion composition root: config → telemetry → logs → owned clients → probes → outbox relay → HTTP routes.
// No business logic here: services own it; adapters only parse and dispatch.
import { AmqpPublisher, amqpReadyCheck, createAmqpClient } from "@aegispulse/ts-platform/amqp";
import { JwtVerifier } from "@aegispulse/ts-platform/auth";
import { buildVersion } from "@aegispulse/ts-platform/build-info";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import {
  connectWithRetry,
  HealthRegistry,
  Lifecycle,
  flywaySchemaVersionCheck,
  postgresPingCheck,
} from "@aegispulse/ts-platform/health";
import { createHttpServer, registerHealthRoutes } from "@aegispulse/ts-platform/http";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { IdempotencyRepository } from "@aegispulse/ts-platform/idempotency";
import { OutboxRelay, OutboxRepository } from "@aegispulse/ts-platform/outbox";
import { startTelemetry } from "@aegispulse/ts-platform/telemetry";
import { registerWebhookSourceRoutes } from "./adapters/http/webhook-sources.routes.js";
import { WebhookSourceRepository } from "./db/webhook-sources.repository.js";
import { parseKek } from "./domain/crypto.js";
import { WebhookSourceService } from "./service/webhook-source.service.js";
import { configSchema, PORT, SERVICE } from "./config.js";
import { createPostgresPool } from "./db/postgres.js";
import { connectRedis, redisCheck } from "./storage/redis.js";
import { createObjectStore, objectStoreCheck } from "./storage/objectstore.js";

async function main(): Promise<void> {
  const config = loadConfig(configSchema);
  const kek = parseKek(config.INGESTION_KEK_BASE64, config.INGESTION_KEK_VERSION); // fails startup if malformed
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

  const pg = createPostgresPool(config);
  await connectWithRetry("postgres", async () => pg.query("SELECT 1"), { logger });
  health.addCheck("postgres", postgresPingCheck(pg)).addCheck("schema", flywaySchemaVersionCheck(pg, "ingestion", "3"));
  lifecycle.onShutdown("pools", "postgres", () => pg.end());
  const redis = await connectWithRetry("redis", () => connectRedis(config), { logger });
  health.addCheck("redis", redisCheck(redis));
  lifecycle.onShutdown("pools", "redis", async () => void (await redis.quit()));
  const s3 = createObjectStore(config);
  health.addCheck("objectstore", objectStoreCheck(s3, config));
  lifecycle.onShutdown("pools", "objectstore", async () => s3.destroy());
  const amqp = createAmqpClient({
    url: config.AMQP_URL,
    service: `aegispulse-${SERVICE}`,
    logger,
    consumes: [],
    publishesTo: ["aegispulse.ingress", "aegispulse.intelligence"],
    defaultPrefetch: config.AMQP_PREFETCH_DEFAULT,
  });
  await connectWithRetry("rabbitmq", () => amqp.init(), { logger });
  health.addCheck("rabbitmq", amqpReadyCheck(amqp));
  lifecycle.onShutdown("consumers", "rabbitmq", () => amqp.close({ drainTimeoutMs: 20_000 }));

  const outbox = new OutboxRepository("ingestion");
  const relay = new OutboxRelay({ pool: pg, repository: outbox, publisher: new AmqpPublisher(amqp), logger });
  relay.start();
  lifecycle.onShutdown("outbox", "relay", () => relay.stop());
  const verifier = new JwtVerifier({
    jwks: new URL("/.well-known/jwks.json", config.REGISTRY_URL),
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });
  const sources = new WebhookSourceService({
    pool: pg,
    sources: new WebhookSourceRepository(),
    outbox,
    idempotency: new IdempotencyRepository("ingestion"),
    kek,
    version,
    logger,
  });

  const app = createHttpServer({ logger });
  registerHealthRoutes(app, health);
  registerWebhookSourceRoutes(app, verifier, sources);
  await app.listen({ host: "0.0.0.0", port: PORT });
  lifecycle
    .onShutdown("http", "fastify", () => app.close())
    .onShutdown("telemetry", "otel", () => telemetry.shutdown());
  health.markRunning();
  logger.info({ port: PORT }, "ingestion ready");
}

main().catch((error: unknown) => {
  // Config problems are listed key by key (never values); anything else is a startup failure.
  const detail = error instanceof ConfigError ? { issues: error.issues } : { err: String(error) };
  process.stderr.write(`${JSON.stringify({ level: "fatal", service: SERVICE, msg: "startup failed", ...detail })}\n`);
  process.exit(1);
});
