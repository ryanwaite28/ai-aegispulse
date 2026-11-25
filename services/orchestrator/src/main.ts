// orchestrator composition root: config → telemetry → logs → owned clients → probes → saga consumers → HTTP.
// No business logic here: sagas live in src/service/orchestrators/; adapters only parse and dispatch.
import { amqpReadyCheck, createAmqpClient } from "@aegispulse/ts-platform/amqp";
import { buildVersion } from "@aegispulse/ts-platform/build-info";
import { ConfigError, loadConfig } from "@aegispulse/ts-platform/config";
import { connectWithRetry, HealthRegistry, Lifecycle } from "@aegispulse/ts-platform/health";
import { createHttpServer, registerHealthRoutes } from "@aegispulse/ts-platform/http";
import { createLogger } from "@aegispulse/ts-platform/logging";
import { startTelemetry } from "@aegispulse/ts-platform/telemetry";
import { configSchema, PORT, SERVICE } from "./config.js";

import { consumeTransactions } from "./adapters/amqp/txn.consumer.js";
import { SagaClients } from "./clients/saga-clients.js";
import { ScoreTransactionSaga } from "./service/orchestrators/score-transaction.saga.js";
import { ServiceTokenProvider } from "@aegispulse/ts-platform/auth";
import { InternalServiceClient } from "@aegispulse/ts-platform/http-client";
import { TenantSettingsCache } from "@aegispulse/ts-platform/tenant-settings";

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

  const amqp = createAmqpClient({
    url: config.AMQP_URL,
    service: `aegispulse-${SERVICE}`,
    logger,
    consumes: [
      "orchestrator.txn.q",
      "orchestrator.correlation.q",
      "orchestrator.correlation-request.q",
      "orchestrator.review.q",
      "orchestrator.notify.q",
    ],
    publishesTo: ["aegispulse.domain"],
    defaultPrefetch: config.AMQP_PREFETCH_DEFAULT,
  });
  await connectWithRetry("rabbitmq", () => amqp.init(), { logger });
  health.addCheck("rabbitmq", amqpReadyCheck(amqp));
  lifecycle.onShutdown("consumers", "rabbitmq", () => amqp.close({ drainTimeoutMs: 20_000 }));

  // SERVICE token for every callee (svc-orchestrator act[], §5.7.4); per-call timeouts and breakers per §6.5.
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
  const scoring = new InternalServiceClient("riskScoring", {
    name: "risk-scoring",
    baseUrl: config.RISK_SCORING_URL,
    timeoutMs: 2_000, // FR-TXN-03
    serviceToken: tokens.token,
  });
  const cases = new InternalServiceClient("cases", {
    name: "cases",
    baseUrl: config.CASES_URL,
    timeoutMs: 3_000,
    serviceToken: tokens.token,
  });
  lifecycle.onShutdown("pools", "clients", async () => {
    await Promise.all([registry.close(), registryAuth.close(), scoring.close(), cases.close()]);
  });
  const saga = new ScoreTransactionSaga(
    new SagaClients(TenantSettingsCache.forRegistry(registry), registry, scoring, cases),
    logger,
  );
  consumeTransactions(amqp, logger, saga);

  const app = createHttpServer({ logger });
  registerHealthRoutes(app, health);
  await app.listen({ host: "0.0.0.0", port: PORT });
  lifecycle
    .onShutdown("http", "fastify", () => app.close())
    .onShutdown("telemetry", "otel", () => telemetry.shutdown());
  health.markRunning();
  logger.info({ port: PORT }, "orchestrator ready");
}

main().catch((error: unknown) => {
  // Config problems are listed key by key (never values); anything else is a startup failure.
  const detail = error instanceof ConfigError ? { issues: error.issues } : { err: String(error) };
  process.stderr.write(`${JSON.stringify({ level: "fatal", service: SERVICE, msg: "startup failed", ...detail })}\n`);
  process.exit(1);
});
