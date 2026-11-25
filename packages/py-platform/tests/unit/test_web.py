"""§8.2 envelopes for FastAPI services (aegis_platform.web)."""

from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

from aegis_platform.errors import (
    DomainError,
    ErrorDetail,
    NotFoundError,
    TransientError,
    ValidationFailedError,
)
from aegis_platform.web import install_http, success


class Body(BaseModel):
    n: int


def _client() -> TestClient:
    app = FastAPI()
    install_http(app)

    @app.post("/ok")
    async def ok(body: Body) -> dict[str, object]:
        return success({"n": body.n})

    @app.post("/missing")
    async def missing() -> None:
        raise NotFoundError("CASE_NOT_FOUND", "no such case")

    @app.post("/invalid")
    async def invalid() -> None:
        raise ValidationFailedError("VALIDATION_ERROR", "bad", (ErrorDetail("amount", "must be > 0"),))

    @app.post("/suspended")
    async def suspended() -> None:
        raise DomainError("TENANT_SUSPENDED", "tenant suspended")

    @app.post("/down")
    async def down() -> None:
        raise TransientError("DEPENDENCY_UNAVAILABLE", "redis timeout at 10.0.0.5")

    @app.post("/boom")
    async def boom() -> None:
        raise RuntimeError("secret detail")

    return TestClient(app, raise_server_exceptions=False)


def test_success_envelope_echoes_request_and_correlation_ids() -> None:
    corr = "corr-0193a0b2-7c4d-7e8f-9a0b-1c2d3e4f5a6b"
    r = _client().post("/ok", json={"n": 2}, headers={"x-correlation-id": corr, "x-request-id": "req-1"})
    assert r.status_code == 200
    assert r.json() == {"data": {"n": 2}, "meta": {"requestId": "req-1", "correlationId": corr}}
    assert r.headers["x-correlation-id"] == corr


def test_errors_map_to_status_and_envelope_without_leaking_internals() -> None:
    c = _client()
    assert (c.post("/missing").status_code, c.post("/missing").json()["error"]["code"]) == (404, "CASE_NOT_FOUND")
    inv = c.post("/invalid").json()["error"]
    assert inv["details"] == [{"field": "amount", "message": "must be > 0"}]
    assert c.post("/suspended").status_code == 403
    down = c.post("/down")
    assert (down.status_code, down.json()["error"]["message"]) == (503, "dependency unavailable")
    boom = c.post("/boom")
    assert boom.status_code == 500
    assert "secret" not in boom.text
    bad = c.post("/ok", json={"n": "x"})
    assert bad.status_code == 422
    assert bad.json()["error"]["details"][0]["field"] == "n"
