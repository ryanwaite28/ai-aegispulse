"""Structured JSON logs (NFR-07): ts, level, service, version, env, traceId, spanId, correlationId, tenantId, eventId,
msg. Context is carried in contextvars; sensitive keys are censored by name at any depth."""

import logging
import sys
from collections.abc import Iterator, Mapping, MutableMapping
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

import structlog
from opentelemetry import trace

REDACTED = "[REDACTED]"
SENSITIVE_KEYS = frozenset(
    {
        "password",
        "newpassword",
        "currentpassword",
        "secret",
        "clientsecret",
        "client_secret",
        "token",
        "accesstoken",
        "refreshtoken",
        "authorization",
        "cookie",
        "apikey",
        "privatekey",
        "rawbody",
        "rawbodybase64",
        "body",
        "content",
        "filecontent",
        "signature",
        "kek",
    }
)
_CONTEXT_KEYS = ("correlationId", "tenantId", "eventId", "requestId")


def _redact(value: Any) -> Any:
    if isinstance(value, Mapping):
        return {k: (REDACTED if str(k).lower() in SENSITIVE_KEYS else _redact(v)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_redact(v) for v in value]
    return value


def _redact_processor(_: Any, __: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    for key in list(event.keys()):
        event[key] = REDACTED if key.lower() in SENSITIVE_KEYS else _redact(event[key])
    return event


def _trace_processor(_: Any, __: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
    ctx = trace.get_current_span().get_span_context()
    if ctx.is_valid:
        event["traceId"] = format(ctx.trace_id, "032x")
        event["spanId"] = format(ctx.span_id, "016x")
    return event


def configure_logging(*, service: str, version: str, env: str, level: str = "info", stream: Any = None) -> None:
    """Configure structlog JSON output to stdout (or ``stream`` for tests)."""

    def _static(_: Any, __: str, event: MutableMapping[str, Any]) -> MutableMapping[str, Any]:
        event["ts"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        event["service"] = service
        event["version"] = version
        event["env"] = env
        event["msg"] = event.pop("event", "")
        return event

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            _trace_processor,
            _static,
            _redact_processor,
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(logging.getLevelNamesMapping()[level.upper()]),
        logger_factory=structlog.PrintLoggerFactory(stream if stream is not None else sys.stdout),
        cache_logger_on_first_use=False,
    )


def get_logger(name: str | None = None) -> Any:
    """A bound structlog logger."""
    return structlog.get_logger(name)


@contextmanager
def log_context(**fields: str | None) -> Iterator[None]:
    """Bind correlationId / tenantId / eventId / requestId for the block (contextvars; asyncio-safe)."""
    unknown = set(fields) - set(_CONTEXT_KEYS)
    if unknown:
        raise ValueError(f"unknown log context keys: {sorted(unknown)}")
    values = {k: v for k, v in fields.items() if v is not None}
    tokens = structlog.contextvars.bind_contextvars(**values)
    try:
        yield
    finally:
        structlog.contextvars.reset_contextvars(**tokens)


def mask_email(email: str) -> str:
    """'jane@example.com' → 'j***@example.com' (§1.4.2)."""
    at = email.find("@")
    return "***" if at <= 0 else f"{email[0]}***{email[at:]}"
