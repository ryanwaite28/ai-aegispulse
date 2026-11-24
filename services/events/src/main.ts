// events composition root: config → telemetry → logs → owned clients → probes → Mongo outbox relay → consumers → HTTP.
// No business logic here: services own it; adapters only parse and dispatch.
import { AmqpPublisher, amqpReadyCheck, createAmqpClient, workQueueNames } from "@aegispulse/ts-platform/amqp";
import { JwtVerifier, ServiceTokenProvider } from "@aegispulse/ts-platform/auth";
import { InternalServiceClient } from "@aegispulse/ts-platform/http-client";
import { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";
import { consumeArchive } from "./adapters/amqp/archive.consumer.js";
import { consumeDeadLetters } from "./adapters/amqp/deadletter.consumer.js";
import { registerDeadLetterRoutes } from "./adapters/http/dead-letters.routes.js";
import { DeadLetterRepository } from "./db/dead-letter.repository.js";
import { DeadLetterService } from "./service/dead-letter.service.js";
import { TopologyReplayPublisher } from "./storage/dead-letter-replay.js";
import { registerEventRoutes } from "./adapters/http/events.routes.js";
import { EventQueryRepository } from "./db/event-query.repository.js";
import { EventQueryService } from "./service/event-query.service.js";
import { OverrideService } from "./service/override.service.js";
import { ArchiveRepository } from "./db/archive.repository.js";
import { MongoOutboxRepository } from "./db/outbox.repository.js";
import { ArchiveService } from "./service/archive.service.js";
import { MongoOutboxRelay } from "./storage/mongo-outbox-relay.js";
import { RegistryTenantRetention } from "./storage/tenant-retention.js";
import { buildVersion } from "@aegispulse/ts-platform/build-info";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import { connectWithRetry, HealthRegistry, Lifecycle } from "@aegispulse/ts-platform/health";
import { createHttpServer, registerHealthRoutes } from "@aegispulse/ts-platform/http";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { startTelemetry } from "@aegispulse/ts-platform/telemetry";
import { configSchema, PORT, SERVICE } from "./config.js";
import { connectMongo, DATABASE, mongoPingCheck, mongoSchemaCheck } from "./db/mongo.js";
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

  const db = mongo.db(DATABASE);
  const outbox = new MongoOutboxRepository(db);
  const relay = new MongoOutboxRelay({ repository: outbox, publisher: new AmqpPublisher(amqp), logger });
  relay.start();
  lifecycle.onShutdown("outbox", "relay", () => relay.stop());

  // Registry calls (tenant retentionDays, FR-EVT-03) use events' own SERVICE token (§5.7.4 registry.getTenantSettings).
  const registryAuth = new InternalServiceClient("registry", {
    name: "registry",
    baseUrl: config.REGISTRY_URL,
    timeoutMs: 3_000,
  });
  const tokens = new ServiceTokenProvider({
    clientId: config.SERVICE_CLIENT_ID,
    clientSecret: config.SERVICE_CLIENT_SECRET,
    issue: (input) =>
      registryAuth.invoke<"issueClientCredentialsToken", { accessToken: string; expiresIn: number }>(
        "issueClientCredentialsToken",
        input,
      ),
  });
  const registry = new InternalServiceClient("registry", {
    name: "registry",
    baseUrl: config.REGISTRY_URL,
    timeoutMs: 1_000,
    serviceToken: tokens.token,
  });
  lifecycle.onShutdown("pools", "registry", async () => {
    await registry.close();
    await registryAuth.close();
  });
  const archive = new ArchiveService({
    client: mongo,
    archive: new ArchiveRepository(db),
    outbox,
    tenants: new RegistryTenantRetention(TenantSettingsCache.forRegistry(registry), logger),
    version,
    logger,
  });
  consumeArchive(amqp, logger, archive);
  const deadLetters = new DeadLetterService({
    client: mongo,
    repo: new DeadLetterRepository(db),
    outbox,
    replay: new TopologyReplayPublisher(amqp),
    version,
    logger,
  });
  deadLetters.primeMetrics(workQueueNames());
  consumeDeadLetters(amqp, logger, deadLetters);

  const app = createHttpServer({ logger });
  registerHealthRoutes(app, health);
  const verifier = new JwtVerifier({
    jwks: new URL("/.well-known/jwks.json", config.REGISTRY_URL),
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });
  registerEventRoutes(
    app,
    verifier,
    new EventQueryService(new EventQueryRepository(db)),
    new OverrideService({ client: mongo, archive: new ArchiveRepository(db), outbox, version, logger }),
  );
  registerDeadLetterRoutes(app, verifier, deadLetters);
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
