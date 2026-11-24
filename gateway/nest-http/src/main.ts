// Gateway composition root (ADR-0013): NestFactory + FastifyAdapter over the platform Fastify instance, which brings
// request/correlation ids, the 256 KiB body limit and §8.2 envelopes; Nest adds the JWKS guard and controllers.
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";
import { JwtVerifier } from "@aegispulse/ts-platform/auth";
import { buildVersion } from "@aegispulse/ts-platform/build-info";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import { HealthRegistry, Lifecycle } from "@aegispulse/ts-platform/health";
import { createHttpServer } from "@aegispulse/ts-platform/http";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { startTelemetry } from "@aegispulse/ts-platform/telemetry";
import { AppModule } from "./app.module.js";
import { installBodyParsing } from "./common/body-parsing.js";
import { IngestionClient } from "./clients/ingestion.client.js";
import { RegistryClient } from "./clients/registry.client.js";
import { configSchema, JSON_BODY_LIMIT, PORT, SERVICE, type Config } from "./config.js";

export async function createGateway(
  config: Config,
  verifier: JwtVerifier,
  health: HealthRegistry,
  logger: ReturnType<typeof createLogger>,
  registry: RegistryClient = new RegistryClient(config),
  ingestion: IngestionClient = new IngestionClient(config, registry.gatewayToken),
): Promise<NestFastifyApplication> {
  const fastify = createHttpServer({ logger, bodyLimit: JSON_BODY_LIMIT, nestManaged: true });
  installBodyParsing(fastify);
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register({ config, verifier, health, registry, ingestion }),
    new FastifyAdapter(fastify as never),
    { logger: false, bodyParser: false },
  );
  await app.init();
  return app;
}

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
  const verifier = new JwtVerifier({
    jwks: new URL("/.well-known/jwks.json", config.REGISTRY_URL),
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
  });
  const registry = new RegistryClient(config);
  const ingestion = new IngestionClient(config, registry.gatewayToken);
  const app = await createGateway(config, verifier, health, logger, registry, ingestion);
  await app.listen({ host: "0.0.0.0", port: PORT });
  lifecycle
    .onShutdown("http", "nest", () => app.close())
    .onShutdown("pools", "registry", () => registry.close())
    .onShutdown("pools", "ingestion", () => ingestion.close())
    .onShutdown("telemetry", "otel", () => telemetry.shutdown());
  health.markRunning();
  logger.info({ port: PORT }, "gateway ready");
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    const detail = error instanceof ConfigError ? { issues: error.issues } : { err: String(error) };
    process.stderr.write(`${JSON.stringify({ level: "fatal", service: SERVICE, msg: "startup failed", ...detail })}\n`);
    process.exit(1);
  });
}
