"""OpenTelemetry (NFR-07): OTLP/HTTP traces + metrics (endpoint/headers from the standard OTEL_EXPORTER_OTLP_* env),
W3C trace context propagated in AMQP headers via the helpers below."""

from collections.abc import Mapping, MutableMapping
from dataclasses import dataclass
from typing import Any

from opentelemetry import metrics, propagate, trace
from opentelemetry.context import Context
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace.propagation.tracecontext import TraceContextTextMapPropagator

SCOPE = "aegis_platform"


@dataclass
class TelemetryHandle:
    """Flush and stop exporters on shutdown (NFR-11)."""

    tracer_provider: TracerProvider | None
    meter_provider: MeterProvider | None

    def shutdown(self) -> None:
        if self.tracer_provider is not None:
            self.tracer_provider.shutdown()
        if self.meter_provider is not None:
            self.meter_provider.shutdown()


def start_telemetry(
    *, service: str, version: str, env: str, namespace: str = "aegispulse", export_enabled: bool = True
) -> TelemetryHandle:
    """Install the W3C propagator and (unless disabled) OTLP exporters. Call once at startup."""
    propagate.set_global_textmap(TraceContextTextMapPropagator())
    resource = Resource.create(
        {
            "service.name": service,
            "service.version": version,
            "service.namespace": namespace,
            "deployment.environment.name": env,
        }
    )
    tracer_provider = TracerProvider(resource=resource)
    meter_provider: MeterProvider | None = None
    if export_enabled:
        tracer_provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
        meter_provider = MeterProvider(
            resource=resource, metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter())]
        )
        metrics.set_meter_provider(meter_provider)
    trace.set_tracer_provider(tracer_provider)
    return TelemetryHandle(tracer_provider, meter_provider)


def tracer() -> trace.Tracer:
    return trace.get_tracer(SCOPE)


def meter() -> metrics.Meter:
    return metrics.get_meter(SCOPE)


def inject_trace_headers(headers: MutableMapping[str, Any]) -> None:
    """Write traceparent/tracestate of the current context into message headers."""
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    headers.update(carrier)


def extract_trace_context(headers: Mapping[str, Any] | None) -> Context:
    """Read traceparent/tracestate from message headers (bytes or str values)."""
    carrier: dict[str, str] = {}
    for key, value in (headers or {}).items():
        if isinstance(value, bytes):
            carrier[key] = value.decode("utf-8", "replace")
        elif isinstance(value, str):
            carrier[key] = value
    return propagate.extract(carrier)
