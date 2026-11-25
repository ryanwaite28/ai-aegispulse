"""FastAPI transport helpers for Python services (PROJECT.md §8.2, NFR-07): request/correlation ids in the log
context and response headers, the §8.2 error envelope for every failure, and the success envelope.

Transport only: services raise ``DomainError`` subclasses (or ``TransientError``) and never build HTTP responses.
Never leaks stacks or internal messages for 5xx.
"""

import re
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from opentelemetry import trace
from pydantic import BaseModel, ValidationError
from structlog.contextvars import get_contextvars

from aegis_platform.errors import (
    DomainError,
    ErrorDetail,
    PermanentError,
    PoisonMessageError,
    TransientError,
    ValidationFailedError,
)
from aegis_platform.logging import get_logger, log_context

_CORRELATION = re.compile(r"^corr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

#: §8.4 codes whose status differs from the raising class's default (plain DomainError defaults to 409).
STATUS_BY_CODE: dict[str, int] = {
    "VALIDATION_ERROR": 422,
    "BAD_REQUEST": 400,
    "UNAUTHORIZED": 401,
    "FORBIDDEN": 403,
    "NOT_FOUND": 404,
    "CONFLICT": 409,
    "PAYLOAD_TOO_LARGE": 413,
    "RATE_LIMITED": 429,
    "INTERNAL_ERROR": 500,
    "DEPENDENCY_UNAVAILABLE": 503,
    "TENANT_SUSPENDED": 403,
}

_log = get_logger("aegis_platform.web")


def _meta() -> dict[str, str]:
    ctx = get_contextvars()
    meta: dict[str, str] = {k: str(ctx[k]) for k in ("requestId", "correlationId") if k in ctx}
    span = trace.get_current_span().get_span_context()
    if span.is_valid:
        meta["traceId"] = format(span.trace_id, "032x")
    return meta


def success(data: Any, next_cursor: str | None = None) -> dict[str, Any]:
    """§8.2 success envelope."""
    meta: dict[str, Any] = {k: v for k, v in _meta().items() if k != "traceId"}
    if next_cursor is not None:
        meta["nextCursor"] = next_cursor
    return {"data": data, "meta": meta}


def error_response(status: int, code: str, message: str, details: list[dict[str, str]] | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"error": {"code": code, "message": message, "details": details or []}, "meta": _meta()},
    )


def install_http(app: FastAPI) -> None:
    """Request ids + correlation ids (validated, echoed) and §8.2 error mapping for every route of ``app``."""

    @app.middleware("http")
    async def _ids(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        inbound = request.headers.get("x-request-id")
        request_id = inbound if inbound is not None and _REQUEST_ID.fullmatch(inbound) else str(uuid.uuid4())
        corr = request.headers.get("x-correlation-id")
        correlation_id = corr if corr is not None and _CORRELATION.fullmatch(corr) else f"corr-{uuid.uuid4()}"
        with log_context(requestId=request_id, correlationId=correlation_id):
            response = await call_next(request)
        response.headers["x-request-id"] = request_id
        response.headers["x-correlation-id"] = correlation_id
        return response

    @app.exception_handler(DomainError)
    async def _domain(_: Request, error: DomainError) -> JSONResponse:
        status = STATUS_BY_CODE.get(error.code, type(error).http_status)
        details = [{"field": d.field, "message": d.issue} for d in error.details]
        return error_response(status, error.code, error.message, details)

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, error: RequestValidationError) -> JSONResponse:
        details = [
            {"field": ".".join(str(p) for p in e.get("loc", ()) if p != "body") or "body", "message": str(e.get("msg"))}
            for e in error.errors()
        ]
        return error_response(422, "VALIDATION_ERROR", "request failed validation", details)

    @app.exception_handler(TransientError)
    async def _transient(_: Request, error: TransientError) -> JSONResponse:
        _log.warning("dependency unavailable", code=error.code)
        return error_response(503, "DEPENDENCY_UNAVAILABLE", "dependency unavailable")

    @app.exception_handler(PermanentError)
    async def _permanent(_: Request, error: PermanentError) -> JSONResponse:
        return error_response(422, error.code, str(error))

    @app.exception_handler(PoisonMessageError)
    async def _poison(_: Request, error: PoisonMessageError) -> JSONResponse:
        return error_response(422, error.code, str(error))

    @app.exception_handler(Exception)
    async def _unexpected(_: Request, error: Exception) -> JSONResponse:
        _log.error("unhandled error", err=type(error).__name__)
        return error_response(500, "INTERNAL_ERROR", "internal error")


def parse_model[M: BaseModel](model: type[M], data: object) -> M:
    """Validate a request body after authentication (routes take the raw JSON so auth runs first): 422 with details."""
    try:
        return model.model_validate(data)
    except ValidationError as e:
        details = tuple(
            ErrorDetail(".".join(str(p) for p in err.get("loc", ())) or "body", str(err.get("msg")))
            for err in e.errors(include_input=False, include_url=False, include_context=False)
        )
        raise ValidationFailedError("VALIDATION_ERROR", "request failed validation", details) from None
