"""NFR-07: mandatory log fields, redaction, trace propagation through AMQP headers."""

import io
import json
from typing import Any

from opentelemetry import trace

from aegis_platform.logging import REDACTED, configure_logging, get_logger, log_context, mask_email
from aegis_platform.telemetry import extract_trace_context, inject_trace_headers, start_telemetry, tracer

TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"


def _lines(stream: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line]


def test_mandatory_fields_context_and_trace_ids() -> None:
    start_telemetry(service="t", version="v", env="local", export_enabled=False)
    out = io.StringIO()
    configure_logging(service="data-intel", version="abc1234", env="local", stream=out)
    with (
        tracer().start_as_current_span("work", context=extract_trace_context({"traceparent": TRACEPARENT})),
        log_context(correlationId="corr-1", tenantId="t-1", eventId="e-1"),
    ):
        get_logger().info("fact recorded", queue="intel.facts.q")
    get_logger().info("outside")
    first, second = _lines(out)
    assert first["msg"] == "fact recorded"
    for key, value in {
        "level": "info",
        "service": "data-intel",
        "version": "abc1234",
        "env": "local",
        "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
        "correlationId": "corr-1",
        "tenantId": "t-1",
        "eventId": "e-1",
        "queue": "intel.facts.q",
    }.items():
        assert first[key] == value
    assert first["ts"].endswith("Z")
    assert len(first["spanId"]) == 16
    assert "correlationId" not in second  # context does not leak past the block


def test_redacts_by_key_name_at_any_depth() -> None:
    out = io.StringIO()
    configure_logging(service="s", version="v", env="local", stream=out)
    get_logger().warning(
        "login", password="p1", headers={"Authorization": "Bearer abc"}, req={"body": {"x": 1}}, ok="yes"
    )
    (line,) = _lines(out)
    assert line["password"] == REDACTED
    assert line["headers"]["Authorization"] == REDACTED
    assert line["req"]["body"] == REDACTED
    assert line["ok"] == "yes"
    assert "Bearer abc" not in json.dumps(line)
    assert mask_email("jane@example.com") == "j***@example.com"


def test_round_trips_w3c_context_through_message_headers() -> None:
    start_telemetry(service="t", version="v", env="local", export_enabled=False)
    ctx = extract_trace_context({"traceparent": TRACEPARENT.encode()})  # amqp may deliver bytes
    with tracer().start_as_current_span("publish", context=ctx):
        headers: dict[str, Any] = {}
        inject_trace_headers(headers)
        assert headers["traceparent"].split("-")[1] == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert not trace.get_current_span(extract_trace_context(None)).get_span_context().is_valid
