"""``riskScoring.score`` (FR-TXN-04; spec FR-TXN-04-risk-scoring). Converts the amount with ``fx-static-v1``,
observes the transaction in the feature store (idempotent by eventId: a redelivery gets the first delivery's
features, so velocity is never inflated) and applies ``risk-heuristic-v1.0.0``. Tenant settings arrive with the
request (the orchestrator reads them, cached ≤ 60 s, FR-TEN-08); an empty high-risk list falls back to
HIGH_RISK_COUNTRIES_DEFAULT (§1.4.4).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Protocol

from aegis_platform.errors import ErrorDetail, ValidationFailedError
from aegis_platform.logging import get_logger
from aegis_risk.domain.fx import FxTable
from aegis_risk.domain.heuristic_v1 import MODEL_VERSION, Inputs, Score, counterparty_seen_within_30d, score

FEATURE_VERSION = "features-v1"


@dataclass(frozen=True, slots=True)
class FeatureSnapshot:
    """Features as of this transaction: count in the last hour including it, last time the pair was seen before."""

    txn_count_1h: int
    counterparty_last_seen_ms: int | None


class FeatureStore(Protocol):
    async def observe(
        self, tenant_id: str, event_id: str, account_id: str, counterparty_id: str, occurred_ms: int
    ) -> FeatureSnapshot: ...


@dataclass(frozen=True, slots=True)
class ScoreInput:
    tenant_id: str
    event_id: str
    account_id: str
    counterparty_id: str
    amount: Decimal
    currency: str
    country: str
    occurred_at: datetime
    watchlist_hit: bool
    high_value_threshold_usd: Decimal
    high_risk_countries: frozenset[str]
    demo_mode: bool
    demo_scenario: str | None


@dataclass(frozen=True, slots=True)
class ScoreResult:
    score: Score
    model_version: str
    feature_version: str
    computed_at: datetime


class ScoringService:
    def __init__(self, *, features: FeatureStore, fx: FxTable, default_high_risk: frozenset[str]) -> None:
        self._features = features
        self._fx = fx
        self._default_high_risk = default_high_risk
        self._log = get_logger("aegis_risk.scoring")

    async def score(self, i: ScoreInput) -> ScoreResult:
        try:
            amount_usd = self._fx.to_usd(i.amount, i.currency)
        except KeyError:
            raise ValidationFailedError(
                "VALIDATION_ERROR", "request failed validation", (ErrorDetail("currency", "not in fx-static-v1"),)
            ) from None
        occurred_ms = int(i.occurred_at.timestamp() * 1000)
        snap = await self._features.observe(i.tenant_id, i.event_id, i.account_id, i.counterparty_id, occurred_ms)
        result = score(
            Inputs(
                amount_usd=amount_usd,
                high_value_threshold_usd=i.high_value_threshold_usd,
                txn_count_1h=snap.txn_count_1h,
                country=i.country,
                high_risk_countries=i.high_risk_countries or self._default_high_risk,
                watchlist_hit=i.watchlist_hit,
                counterparty_seen_within_30d=counterparty_seen_within_30d(snap.counterparty_last_seen_ms, occurred_ms),
                demo_mode=i.demo_mode,
                demo_scenario=i.demo_scenario,
            )
        )
        self._log.info(
            "transaction.scored", tenantId=i.tenant_id, eventId=i.event_id, score=result.score, band=result.band
        )
        return ScoreResult(result, MODEL_VERSION, f"{FEATURE_VERSION}+{self._fx.version}", datetime.now(UTC))
