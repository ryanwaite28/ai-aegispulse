// OpenTelemetry bootstrap and propagation helpers (NFR-07): traces and metrics over OTLP/HTTP to OpenObserve,
// W3C traceparent across HTTP (auto-instrumented) and AMQP (headers, via the helpers below).
// Exporter endpoint and headers come from the standard OTEL_EXPORTER_OTLP_* variables (§10.4).
import {
  context,
  metrics,
  propagation,
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Context,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, TracerProvider } from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly env: string;
  readonly serviceNamespace?: string;
  /** Default true. False registers propagation only (unit tests, CLI tools). */
  readonly exportEnabled?: boolean;
  readonly metricExportIntervalMs?: number;
}

export interface TelemetryHandle {
  /** Flushes and stops exporters (call during graceful shutdown, NFR-11). */
  shutdown(): Promise<void>;
}

const INSTRUMENTATION_SCOPE = "@aegispulse/ts-platform";

/** Starts the OTel SDK. Call once, before the service creates servers or clients. */
export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  // Async context + W3C propagation always (log correlation, AMQP traceparent), exporters only when enabled.
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  if (options.exportEnabled === false) {
    return {
      shutdown: async () => {
        context.disable();
        propagation.disable();
      },
    };
  }
  // Composed from the minimal SDK parts (not @opentelemetry/sdk-node, which drags in gRPC/protobuf/zipkin/prometheus
  // exporters and pushed the image layer over the 95 MB cap, NFR-15). Endpoint/headers: standard OTEL_EXPORTER_OTLP_*.
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_SERVICE_VERSION]: options.serviceVersion,
    "service.namespace": options.serviceNamespace ?? "aegispulse",
    "deployment.environment.name": options.env,
  });
  const tracerProvider = new TracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })],
  });
  trace.setGlobalTracerProvider(tracerProvider);
  const meterProvider = new MeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: options.metricExportIntervalMs ?? 15_000,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(meterProvider);
  const disableInstrumentations = registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // Kubernetes probes would dominate traces; /healthz (human-facing) stays traced.
        ignoreIncomingRequestHook: (req) => req.url === "/livez" || req.url === "/readyz",
      }),
      new UndiciInstrumentation(),
    ],
  });
  return {
    shutdown: async () => {
      disableInstrumentations();
      await Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]);
    },
  };
}

export function getTracer(): Tracer {
  return trace.getTracer(INSTRUMENTATION_SCOPE);
}

export function getMeter(): Meter {
  return metrics.getMeter(INSTRUMENTATION_SCOPE);
}

/** A header bag as AMQP carries it. */
export type MessageHeaders = Record<string, unknown>;

/** Writes traceparent/tracestate of the active (or given) context into message headers. */
export function injectTraceHeaders(headers: MessageHeaders, ctx: Context = context.active()): void {
  propagation.inject(ctx, headers, {
    set: (carrier, key, value) => {
      carrier[key] = value;
    },
  });
}

/** Reads traceparent/tracestate from message headers into a context (root context if absent). */
export function extractTraceContext(headers: MessageHeaders | undefined): Context {
  return propagation.extract(context.active(), headers ?? {}, {
    get: (carrier, key) => {
      const value = carrier[key];
      if (typeof value === "string") return value;
      if (Buffer.isBuffer(value)) return value.toString("utf8");
      return undefined;
    },
    keys: (carrier) => Object.keys(carrier),
  });
}

/**
 * Runs `fn` inside a span. The span ends when `fn` settles, records the exception and marks ERROR on failure.
 * `parent` lets a consumer continue the producer's trace (extractTraceContext).
 */
export async function withSpan<T>(
  name: string,
  options: { kind?: SpanKind; attributes?: Attributes; parent?: Context },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = options.parent ?? context.active();
  const span = getTracer().startSpan(
    name,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      ...(options.attributes === undefined ? {} : { attributes: options.attributes }),
    },
    parent,
  );
  return context.with(trace.setSpan(parent, span), async () => {
    try {
      return await fn(span);
    } catch (error: unknown) {
      span.recordException(error instanceof Error ? error : new Error(String(error)));
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

export { SpanKind };
