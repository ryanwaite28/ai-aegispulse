// files composition root: config → telemetry → logs → owned clients → probes → outbox relay → HTTP routes.
// No business logic here: services own it; adapters only parse and dispatch.
import { AmqpPublisher, amqpReadyCheck, createAmqpClient } from "@aegispulse/ts-platform/amqp";
import { JwtVerifier, ServiceTokenProvider } from "@aegispulse/ts-platform/auth";
import { InternalServiceClient } from "@aegispulse/ts-platform/http-client";
import { IdempotencyRepository } from "@aegispulse/ts-platform/idempotency";
import { OutboxRelay, OutboxRepository } from "@aegispulse/ts-platform/outbox";
import { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";
import { registerUploadRoutes } from "./adapters/http/uploads.routes.js";
import { registerFileRoutes } from "./adapters/http/files.routes.js";
import { FileProcessingService } from "./service/file-processing.service.js";
import { FileQueryService } from "./service/file-query.service.js";
import { FilesRepository } from "./db/files.repository.js";
import { FileUploadService } from "./service/file-upload.service.js";
import {
  RedisDedupIndex,
  RedisFileStatusCache,
  RedisInitRateLimiter,
  RedisUploadSessions,
  RegistryTenantStatus,
  S3DownloadSigner,
  S3UploadStore,
} from "./storage/upload-infra.js";
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
import { startTelemetry } from "@aegispulse/ts-platform/telemetry";
import { configSchema, PORT, SERVICE } from "./config.js";
import { createPostgresPool } from "./db/postgres.js";
import { connectRedis, redisCheck } from "./storage/redis.js";
import {
  bucketName,
  createObjectStore,
  createPresigner,
  objectStoreCheck,
  quarantineBucketName,
} from "./storage/objectstore.js";
import { ClamdScanner } from "./storage/clamav.js";
import { RegistryTenantSlug, S3ValidationStore } from "./storage/validation-infra.js";
import { FileValidationService } from "./service/file-validation.service.js";
import { consumeFileValidation } from "./adapters/amqp/files-validation.consumer.js";
import { ProcessedMessagesRepository } from "@aegispulse/ts-platform/idempotency";
import { clamavCheck } from "./storage/clamav.js";

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

  const pg = createPostgresPool(config);
  await connectWithRetry("postgres", async () => pg.query("SELECT 1"), { logger });
  health.addCheck("postgres", postgresPingCheck(pg)).addCheck("schema", flywaySchemaVersionCheck(pg, "files", "4"));
  lifecycle.onShutdown("pools", "postgres", () => pg.end());
  const redis = await connectWithRetry("redis", () => connectRedis(config), { logger });
  health.addCheck("redis", redisCheck(redis));
  lifecycle.onShutdown("pools", "redis", async () => void (await redis.quit()));
  const s3 = createObjectStore(config);
  health.addCheck("objectstore", objectStoreCheck(s3, config));
  lifecycle.onShutdown("pools", "objectstore", async () => s3.destroy());
  if (config.FILES_AV_ENABLED) health.addCheck("clamav", clamavCheck(config.CLAMAV_HOST), { timeoutMs: 3_000 });
  const amqp = createAmqpClient({
    url: config.AMQP_URL,
    service: `aegispulse-${SERVICE}`,
    logger,
    consumes: ["files.validation.q"],
    publishesTo: ["aegispulse.ingress", "aegispulse.enrichment", "aegispulse.intelligence"],
    defaultPrefetch: config.AMQP_PREFETCH_DEFAULT,
  });
  await connectWithRetry("rabbitmq", () => amqp.init(), { logger });
  health.addCheck("rabbitmq", amqpReadyCheck(amqp));
  lifecycle.onShutdown("consumers", "rabbitmq", () => amqp.close({ drainTimeoutMs: 20_000 }));

  const outbox = new OutboxRepository("files");
  const relay = new OutboxRelay({ pool: pg, repository: outbox, publisher: new AmqpPublisher(amqp), logger });
  relay.start();
  lifecycle.onShutdown("outbox", "relay", () => relay.stop());
  const verifier = new JwtVerifier({
    jwks: new URL("/.well-known/jwks.json", config.REGISTRY_URL),
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });
  // Registry calls (tenant status, FR-FILE-01) use files' own SERVICE token (§5.7.4 registry.getTenantSettings).
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
  const tenantSettings = TenantSettingsCache.forRegistry(registry);
  const presigner = createPresigner(config);
  lifecycle.onShutdown("pools", "presigner", async () => presigner.destroy());
  const uploads = new FileUploadService({
    pool: pg,
    files: new FilesRepository(),
    outbox,
    idempotency: new IdempotencyRepository("files"),
    sessions: new RedisUploadSessions(redis),
    dedup: new RedisDedupIndex(redis),
    rate: new RedisInitRateLimiter(redis),
    objects: new S3UploadStore(s3, presigner, bucketName(config)),
    statusCache: new RedisFileStatusCache(redis),
    tenants: new RegistryTenantStatus(tenantSettings),
    version,
    logger,
  });
  const validation = new FileValidationService({
    pool: pg,
    files: new FilesRepository(),
    outbox,
    processed: new ProcessedMessagesRepository("files"),
    objects: new S3ValidationStore(s3, bucketName(config), quarantineBucketName(config)),
    av: config.FILES_AV_ENABLED ? new ClamdScanner(config.CLAMAV_HOST) : undefined,
    tenants: new RegistryTenantSlug(tenantSettings),
    statusCache: new RedisFileStatusCache(redis),
    version,
    logger,
  });
  consumeFileValidation(amqp, logger, validation);
  const statusCache = new RedisFileStatusCache(redis);
  const signer = new S3DownloadSigner(s3, presigner);
  const queries = new FileQueryService({
    pool: pg,
    files: new FilesRepository(),
    outbox,
    signer,
    cache: statusCache,
    version,
    logger,
  });
  const processing = new FileProcessingService({
    pool: pg,
    files: new FilesRepository(),
    outbox,
    signer,
    statusCache,
    version,
    logger,
  });

  const app = createHttpServer({ logger });
  registerHealthRoutes(app, health);
  registerUploadRoutes(app, verifier, uploads);
  registerFileRoutes(app, verifier, queries, processing);
  await app.listen({ host: "0.0.0.0", port: PORT });
  lifecycle
    .onShutdown("http", "fastify", () => app.close())
    .onShutdown("telemetry", "otel", () => telemetry.shutdown());
  health.markRunning();
  logger.info({ port: PORT }, "files ready");
}

main().catch((error: unknown) => {
  // Config problems are listed key by key (never values); anything else is a startup failure.
  const detail = error instanceof ConfigError ? { issues: error.issues } : { err: String(error) };
  process.stderr.write(`${JSON.stringify({ level: "fatal", service: SERVICE, msg: "startup failed", ...detail })}\n`);
  process.exit(1);
});
