// AMQP consumer/publisher kit (PROJECT.md §6.4, §6.5, FR-MSG-01, NFR-02/07/10) on rxjs-rabbitmq 3.x
// (docs/evidence/rxjs-rabbitmq-3.0.0-review.md).
// - Runtime users never declare topology: the client runs in topology 'verify' (passive checks only).
// - Publishes are confirmed (confirm channel) and mandatory; envelopes carry the §6.4 AMQP properties/headers.
// - Consumers: parse + validate envelope → log/trace context → ONE handler (a service action) → ack;
//   failures are classified: TRANSIENT → republish to aegispulse.retry / {queue}.retry.{tier} with x-retry-count+1;
//   PERMANENT/POISON or retries exhausted → republish to aegispulse.dlx / {queue} with error headers.
//   Republish is confirm-then-ack (the library nack-requeues the original if the copy isn't confirmed).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { RabbitMQClient, type RmqEventMessage } from "rxjs-rabbitmq";
import type { Subscription } from "rxjs";
import type { CanonicalEnvelope } from "@aegispulse/contracts/generated/ts/envelope.ts";
import type { ExchangeName, QueueName, WorkQueueName } from "@aegispulse/contracts/generated/ts/topology.ts";
import { classifyFailure, describeError, PoisonMessageError, type ClassifiedFailure } from "../errors/index.js";
import { runWithContext, type Logger } from "../logging/index.js";
import { extractTraceContext, getMeter, injectTraceHeaders, SpanKind, withSpan } from "../telemetry/index.js";
import type { EnvelopePublisher, OutboxMessage } from "../outbox/index.js";

export type AegisAmqpClient = RabbitMQClient<QueueName, ExchangeName, string>;
export type AegisDelivery = RmqEventMessage<unknown, QueueName, ExchangeName, string>;

export const RETRY_EXCHANGE: ExchangeName = "aegispulse.retry";
export const DEAD_LETTER_EXCHANGE: ExchangeName = "aegispulse.dlx";

export const HEADERS = {
  retryCount: "x-retry-count",
  tenant: "x-aegis-tenant",
  schemaVersion: "x-aegis-schema-version",
  replayJob: "x-aegis-replay-job",
  replayGeneration: "x-aegis-replay-generation",
  errorCode: "x-aegis-error-code",
  originalQueue: "x-aegis-original-queue",
} as const;

// ── Topology policy (read from the contract, never hard-coded) ────────────────

interface TopologyQueue {
  readonly name: string;
  readonly role?: string;
  readonly prefetch?: number;
  readonly retryTiers?: readonly string[];
  readonly deadLetterQueue?: string | null;
}

export interface QueuePolicy {
  readonly queue: WorkQueueName;
  readonly prefetch: number;
  /** Delay tier per retry attempt, e.g. ["1s","5s","30s"]; attempt n uses tiers[n]. */
  readonly retryTiers: readonly string[];
  /** False for queues without a DLQ (events.deadletter.q): failures are requeued for the broker's delivery limit. */
  readonly deadLetter: boolean;
}

let policies: ReadonlyMap<string, QueuePolicy> | undefined;

function loadPolicies(): ReadonlyMap<string, QueuePolicy> {
  if (policies !== undefined) return policies;
  const path = fileURLToPath(import.meta.resolve("@aegispulse/contracts/topology"));
  const topology = JSON.parse(readFileSync(path, "utf8")) as { queues: TopologyQueue[] };
  const map = new Map<string, QueuePolicy>();
  for (const q of topology.queues) {
    if (q.role !== undefined) continue;
    map.set(q.name, {
      queue: q.name as WorkQueueName,
      prefetch: q.prefetch ?? 10,
      retryTiers: q.retryTiers ?? [],
      deadLetter: typeof q.deadLetterQueue === "string" && q.deadLetterQueue.length > 0,
    });
  }
  policies = map;
  return map;
}

export function queuePolicy(queue: WorkQueueName): QueuePolicy {
  const policy = loadPolicies().get(queue);
  if (policy === undefined) throw new TypeError(`queue ${queue} is not a work queue in the topology contract`);
  return policy;
}

// ── Envelope validation ───────────────────────────────────────────────────────

let validator: ValidateFunction | undefined;

function envelopeValidator(): ValidateFunction {
  if (validator !== undefined) return validator;
  const path = fileURLToPath(import.meta.resolve("@aegispulse/contracts/envelope"));
  const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true });
  (addFormatsImport as unknown as (a: Ajv2020) => Ajv2020)(ajv);
  validator = ajv.compile(JSON.parse(readFileSync(path, "utf8")) as object);
  return validator;
}

/** Parses and validates a message body as a canonical envelope (schemaVersion 1.x). Throws PoisonMessageError. */
export function parseEnvelope(content: Buffer): CanonicalEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(content.toString("utf8")) as unknown;
  } catch (error: unknown) {
    throw new PoisonMessageError("ENVELOPE_INVALID", "message body is not JSON", { cause: error });
  }
  const validate = envelopeValidator();
  if (!validate(value)) {
    const first = validate.errors?.[0];
    const where = first === undefined ? "" : ` at ${first.instancePath || "/"} (${first.keyword})`;
    throw new PoisonMessageError("ENVELOPE_INVALID", `envelope failed schema validation${where}`);
  }
  return value as CanonicalEnvelope;
}

// ── Client ────────────────────────────────────────────────────────────────────

export interface AmqpClientOptions {
  /** AMQP_URL (vhost per environment). */
  readonly url: string;
  /** Runtime name, shown as the broker connection name. */
  readonly service: string;
  readonly logger: Logger;
  /** Work queues this runtime consumes (verified at init; prefetch comes from the contract). */
  readonly consumes?: readonly WorkQueueName[];
  /** Exchanges this runtime publishes to (verified at init). */
  readonly publishesTo?: readonly ExchangeName[];
  /** AMQP_PREFETCH_DEFAULT, used when the runtime consumes nothing. */
  readonly defaultPrefetch?: number;
}

/**
 * Creates (does not connect) the runtime's client. Call `client.init()` inside connectWithRetry at startup.
 * One consume channel carries one basic.qos, so with several queues the smallest contract prefetch wins
 * (memory stays bounded for the most expensive queue).
 */
export function createAmqpClient(options: AmqpClientOptions): AegisAmqpClient {
  const consumes = options.consumes ?? [];
  const exchanges = new Set<ExchangeName>(options.publishesTo ?? []);
  if (consumes.length > 0) {
    exchanges.add(RETRY_EXCHANGE);
    exchanges.add(DEAD_LETTER_EXCHANGE);
  }
  const prefetch =
    consumes.length > 0 ? Math.min(...consumes.map((q) => queuePolicy(q).prefetch)) : (options.defaultPrefetch ?? 10);
  const log = options.logger.child({ component: "amqp" });
  return new RabbitMQClient<QueueName, ExchangeName, string>({
    connection_url: options.url,
    socketOptions: { clientProperties: { connection_name: options.service } },
    stopAutoInit: true,
    topology: "verify",
    confirm: true,
    unhandledMessages: "nack-requeue",
    prefetch,
    retryAttempts: 0, // recover forever after the first successful connect; startup is bounded by connectWithRetry
    retryDelay: 1_000,
    maxRetryDelay: 30_000,
    readyTimeoutMs: 10_000,
    drainTimeoutMs: 20_000,
    queues: consumes.map((name) => ({ name })),
    exchanges: [...exchanges].map((name) => ({ name, type: name === RETRY_EXCHANGE ? "direct" : "topic" })),
    // Bodies are parsed by the kit, so an undeserializable message becomes POISON → DLQ instead of a silent reject.
    serializers: {
      "application/json": {
        serialize: (value: unknown) => Buffer.from(JSON.stringify(value), "utf8"),
        deserialize: (value: Buffer) => value,
      },
    },
    hooks: {
      onPublish: (properties) => injectTraceHeaders(properties.headers),
    },
    logger: {
      debug: (...args: unknown[]) => log.debug({ detail: args.slice(1).map((a) => describeError(a)) }, String(args[0])),
      info: (...args: unknown[]) => log.info(String(args[0])),
      warn: (...args: unknown[]) => log.warn({ detail: args.slice(1).map((a) => describeError(a)) }, String(args[0])),
      error: (...args: unknown[]) => log.error({ detail: args.slice(1).map((a) => describeError(a)) }, String(args[0])),
    },
  });
}

/** Readiness check (NFR-11 d): connected, channels open, topology verified, consumers attached. */
export function amqpReadyCheck(client: AegisAmqpClient): () => Promise<void> {
  return async () => {
    if (client.state !== "ready") throw new Error(`amqp client is ${client.state}`);
  };
}

// ── Publisher ─────────────────────────────────────────────────────────────────

/** Confirmed envelope publisher (used by the outbox relay and by storeless producers). */
export class AmqpPublisher implements EnvelopePublisher {
  constructor(private readonly client: AegisAmqpClient) {}

  publishEnvelope(message: OutboxMessage, extraHeaders: Readonly<Record<string, string | number>> = {}): Promise<void> {
    const { envelope } = message;
    const headers: Record<string, unknown> = { [HEADERS.schemaVersion]: envelope.schemaVersion, ...extraHeaders };
    if (envelope.tenantId !== null) headers[HEADERS.tenant] = envelope.tenantId;
    return this.client.publishEvent({
      exchange: message.exchange,
      routingKey: message.routingKey,
      data: envelope,
      publishOptions: {
        messageId: envelope.eventId,
        correlationId: envelope.correlationId,
        type: envelope.eventType,
        contentType: "application/json",
        persistent: true,
        mandatory: true,
        timestamp: Math.floor(Date.now() / 1000),
        headers,
      },
    });
  }
}

// ── Consumer ──────────────────────────────────────────────────────────────────

export interface DeliveryContext {
  readonly queue: WorkQueueName;
  /** Exchange and routing key the message was published with (archived with the event, FR-EVT-03). */
  readonly exchange: string;
  readonly routingKey: string;
  /** Retries already spent (x-retry-count). */
  readonly retryCount: number;
  /** 0 for original deliveries; replays carry x-aegis-replay-generation (dedup key, NFR-02). */
  readonly replayGeneration: number;
  readonly replayJob: string | undefined;
  readonly redelivered: boolean;
}

/** "duplicate" when the service's dedup check found the message already processed (acked either way). */
export type HandlerOutcome = "processed" | "duplicate";

export type EnvelopeHandler = (
  envelope: CanonicalEnvelope,
  context: DeliveryContext,
  // `void` lets plain `async () => { … }` handlers type-check; only an explicit "duplicate" changes the outcome.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
) => Promise<HandlerOutcome | void>;

export type ConsumerOutcome = "success" | "duplicate" | "retry" | "dead_letter" | "requeue";

export interface ConsumeOptions {
  readonly client: AegisAmqpClient;
  readonly queue: WorkQueueName;
  readonly logger: Logger;
  /** Calls exactly one service action. */
  readonly handler: EnvelopeHandler;
}

function headerInt(headers: Record<string, unknown>, name: string): number {
  const raw = headers[name];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

function headerString(headers: Record<string, unknown>, name: string): string | undefined {
  const raw = headers[name];
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  return undefined;
}

const processedCounter = (() => {
  let counter: ReturnType<ReturnType<typeof getMeter>["createCounter"]> | undefined;
  return () =>
    (counter ??= getMeter().createCounter("aegispulse_consumer_processed_total", {
      description: "Consumer deliveries by queue and outcome",
    }));
})();

/** Decides what happens to a failed delivery (pure; exported for tests). */
export function failureRoute(
  policy: QueuePolicy,
  retryCount: number,
  failure: ClassifiedFailure,
): { action: "retry"; routingKey: string } | { action: "dead_letter" } | { action: "requeue" } {
  if (failure.kind === "TRANSIENT" && retryCount < policy.retryTiers.length) {
    return { action: "retry", routingKey: `${policy.queue}.retry.${policy.retryTiers[retryCount] ?? ""}` };
  }
  return policy.deadLetter ? { action: "dead_letter" } : { action: "requeue" };
}

/**
 * Subscribes the handler to `queue` (consumption starts lazily on subscribe). Unsubscribe or client.close()
 * stops it; close() drains in-flight handlers first (NFR-11).
 */
export function consumeEnvelopes(options: ConsumeOptions): Subscription {
  const { client, queue, logger, handler } = options;
  const policy = queuePolicy(queue);
  const log = logger.child({ queue });

  const settleFailure = async (
    delivery: AegisDelivery,
    retryCount: number,
    error: unknown,
  ): Promise<ConsumerOutcome> => {
    const failure = classifyFailure(error);
    const route = failureRoute(policy, retryCount, failure);
    const fields = { code: failure.code, kind: failure.kind, retryCount, err: describeError(error) };
    try {
      if (route.action === "retry") {
        await delivery.republish({
          exchange: RETRY_EXCHANGE,
          routingKey: route.routingKey,
          headers: { [HEADERS.retryCount]: retryCount + 1 },
        });
        log.warn({ ...fields, tier: route.routingKey }, "handler failed; scheduled retry");
        return "retry";
      }
      if (route.action === "dead_letter") {
        await delivery.republish({
          exchange: DEAD_LETTER_EXCHANGE,
          routingKey: queue,
          headers: { [HEADERS.errorCode]: failure.code, [HEADERS.originalQueue]: queue },
        });
        log.error(fields, "message dead-lettered");
        return "dead_letter";
      }
      delivery.nack(true);
      log.error(fields, "handler failed on a queue without DLQ; requeued (broker delivery limit applies)");
      return "requeue";
    } catch (republishError: unknown) {
      // The library already nack-requeued the original; the broker redelivers it.
      log.error(
        { ...fields, republishErr: describeError(republishError) },
        "retry/DLQ republish failed; original requeued",
      );
      return "requeue";
    }
  };

  const onDelivery = async (delivery: AegisDelivery): Promise<void> => {
    const headers = (delivery.message.properties.headers ?? {}) as Record<string, unknown>;
    const retryCount = headerInt(headers, HEADERS.retryCount);
    let outcome: ConsumerOutcome;
    let envelope: CanonicalEnvelope;
    try {
      envelope = parseEnvelope(delivery.message.content);
    } catch (error: unknown) {
      outcome = await settleFailure(delivery, retryCount, error);
      processedCounter().add(1, { queue, outcome });
      return;
    }
    const context: DeliveryContext = {
      queue,
      exchange: delivery.message.fields.exchange,
      routingKey: delivery.message.fields.routingKey,
      retryCount,
      replayGeneration: headerInt(headers, HEADERS.replayGeneration),
      replayJob: headerString(headers, HEADERS.replayJob),
      redelivered: delivery.message.fields.redelivered,
    };
    const logContext = {
      correlationId: envelope.correlationId,
      eventId: envelope.eventId,
      ...(envelope.tenantId === null ? {} : { tenantId: envelope.tenantId }),
    };
    outcome = await runWithContext(logContext, () =>
      withSpan(
        `${queue} process`,
        {
          kind: SpanKind.CONSUMER,
          parent: extractTraceContext(headers),
          attributes: {
            "messaging.system": "rabbitmq",
            "messaging.destination.name": queue,
            "messaging.message.id": envelope.eventId,
            "messaging.operation.type": "process",
            "aegis.event_type": envelope.eventType,
            "aegis.retry_count": retryCount,
          },
        },
        async (): Promise<ConsumerOutcome> => {
          try {
            const result = await handler(envelope, context);
            delivery.ack();
            return result === "duplicate" ? "duplicate" : "success";
          } catch (error: unknown) {
            return settleFailure(delivery, retryCount, error);
          }
        },
      ),
    );
    processedCounter().add(1, { queue, outcome });
  };

  return client.onQueue(queue).handleAll((delivery) => onDelivery(delivery));
}
