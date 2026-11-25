"""``POST /internal/v1/score`` (§6.2 ``riskScoring.score``; contract risk-scoring.internal.yaml). Transport only:
SERVICE token with ``riskScoring.score`` in act[] (callers: orchestrator) → contract model → one service call →
§8.2 envelope. Tenant (user/integration) tokens are refused: scoring is not a tenant-facing action."""

from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Body, Header

from aegis_contracts.openapi.risk_scoring import ScoreRequest
from aegis_platform.auth import JwtVerifier, ServicePrincipal
from aegis_platform.errors import ForbiddenError
from aegis_platform.web import parse_model, success
from aegis_risk.service.scoring import ScoreInput, ScoringService

ACTION = "riskScoring.score"


def score_router(verifier: JwtVerifier, service: ScoringService) -> APIRouter:
    router = APIRouter()

    @router.post("/internal/v1/score")
    async def score(
        raw: Annotated[Any, Body()] = None, authorization: Annotated[str | None, Header()] = None
    ) -> dict[str, Any]:
        principal = verifier.authorize_internal(authorization, ACTION)
        if not isinstance(principal, ServicePrincipal):
            raise ForbiddenError("FORBIDDEN", "scoring is called by services only")
        body = parse_model(ScoreRequest, raw)
        demo = (body.metadata or {}).get("demoScenario")
        result = await service.score(
            ScoreInput(
                tenant_id=str(body.tenantId.root),
                event_id=str(body.eventId.root),
                account_id=body.accountId,
                counterparty_id=body.counterpartyId,
                amount=Decimal(body.amount),
                currency=body.currency,
                country=body.country,
                occurred_at=body.occurredAt.root,
                watchlist_hit=body.watchlistHit,
                high_value_threshold_usd=Decimal(body.tenantSettings.highValueThresholdUsd),
                high_risk_countries=frozenset(c.root for c in body.tenantSettings.highRiskCountries),
                demo_mode=body.tenantSettings.demoMode,
                demo_scenario=demo if isinstance(demo, str) else None,
            )
        )
        s = result.score
        return success(
            {
                "score": s.score,
                "band": s.band,
                "factors": [{"name": f.name, "value": f.value, "contribution": f.contribution} for f in s.factors],
                "modelVersion": result.model_version,
                "featureVersion": result.feature_version,
                "computedAt": result.computed_at.isoformat().replace("+00:00", "Z"),
            }
        )

    return router
