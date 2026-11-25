"""POST /internal/v1/score (FR-TXN-04): SERVICE token with act riskScoring.score only; contract model; idempotent
feature snapshot per eventId (an in-memory store with the Redis store's semantics; Redis itself in integration)."""

import time
import uuid
from typing import Any

import jwt
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from aegis_platform.auth import JwtVerifier
from aegis_platform.web import install_http
from aegis_risk.adapters.http.score import score_router
from aegis_risk.domain.fx import fx_static_v1
from aegis_risk.service.scoring import FeatureSnapshot, ScoringService

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ISS = "aegispulse-registry"


class MemoryFeatures:
    def __init__(self) -> None:
        self.seen: dict[str, FeatureSnapshot] = {}
        self.times: dict[str, list[tuple[str, int]]] = {}

    async def observe(self, tenant: str, event: str, account: str, cp: str, occurred_ms: int) -> FeatureSnapshot:
        key = f"{tenant}:{event}"
        if key not in self.seen:
            window = [e for e, t in self.times.get(account, []) if occurred_ms - 3_600_000 <= t <= occurred_ms]
            self.seen[key] = FeatureSnapshot(len(window) + 1, None)
            self.times.setdefault(account, []).append((event, occurred_ms))
        return self.seen[key]


def token(typ: str = "service", act: list[str] | None = None) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {"iss": ISS, "sub": "svc-orchestrator", "jti": "j", "iat": now, "exp": now + 600}
    if typ == "service":
        claims |= {"aud": "aegispulse-internal", "typ": "service", "act": act or ["riskScoring.score"]}
    else:
        claims |= {"aud": "aegispulse", "typ": "user", "tid": "t", "tslug": "t", "roles": ["ANALYST"]}
    return jwt.encode(claims, KEY, algorithm="RS256", headers={"kid": "k"})


def client() -> TestClient:
    app = FastAPI()
    install_http(app)
    verifier = JwtVerifier(issuer=ISS, audience="aegispulse", key_resolver=lambda _: KEY.public_key())
    service = ScoringService(features=MemoryFeatures(), fx=fx_static_v1(), default_high_risk=frozenset({"IR"}))
    app.include_router(score_router(verifier, service))
    return TestClient(app)


def body(**over: Any) -> dict[str, Any]:
    return {
        "tenantId": str(uuid.uuid4()),
        "eventId": str(uuid.uuid4()),
        "accountId": "acc-1",
        "counterpartyId": "cp-1",
        "amount": "50000.00",
        "currency": "USD",
        "country": "IR",
        "channel": "WIRE",
        "occurredAt": "2026-11-24T10:00:00Z",
        "watchlistHit": True,
        "tenantSettings": {"highValueThresholdUsd": "50000", "highRiskCountries": [], "demoMode": False},
        **over,
    }


def test_scores_with_contract_shape_and_default_high_risk_list() -> None:
    r = client().post("/internal/v1/score", json=body(), headers={"authorization": f"Bearer {token()}"})
    assert r.status_code == 200
    data = r.json()["data"]
    # 40 amount + 15 geo (empty tenant list → default IR) + 20 watchlist + 10 new counterparty = 85
    assert (data["score"], data["band"], data["modelVersion"]) == (85, "CRITICAL", "risk-heuristic-v1.0.0")
    assert data["featureVersion"] == "features-v1+fx-static-v1"
    assert {f["name"] for f in data["factors"]} == {"amount", "velocity", "geo", "watchlist", "new_counterparty"}


def test_redelivery_of_one_event_does_not_inflate_velocity() -> None:
    c = client()
    h = {"authorization": f"Bearer {token()}"}
    b = body(watchlistHit=False, country="DE")
    scores = [c.post("/internal/v1/score", json=b, headers=h).json()["data"] for _ in range(5)]
    assert {s["score"] for s in scores} == {scores[0]["score"]}
    velocity = [f["value"] for f in scores[-1]["factors"] if f["name"] == "velocity"]
    assert velocity == [1.0]


def test_refuses_user_tokens_missing_act_and_bad_bodies() -> None:
    c = client()
    assert (
        c.post("/internal/v1/score", json=body(), headers={"authorization": f"Bearer {token('user')}"}).status_code
        == 403
    )
    other = {"authorization": f"Bearer {token(act=['registry.checkWatchlists'])}"}
    assert c.post("/internal/v1/score", json=body(), headers=other).status_code == 403
    assert c.post("/internal/v1/score", json=body()).status_code == 401
    h = {"authorization": f"Bearer {token()}"}
    assert c.post("/internal/v1/score", json=body(amount="0.00"), headers=h).status_code == 422
    bad_ccy = c.post("/internal/v1/score", json=body(currency="XYZ"), headers=h)
    assert (bad_ccy.status_code, bad_ccy.json()["error"]["details"][0]["field"]) == (422, "currency")


def test_authenticates_before_validating_the_body() -> None:
    r = client().post("/internal/v1/score", json={}, headers={"authorization": "Bearer nope"})
    assert (r.status_code, r.json()["error"]["details"]) == (401, [])
