"""Transaction risk score ``risk-heuristic-v1.0.0`` (PROJECT.md §1.4.4). Pure: features in, score + factors out.

amount_factor    = min(40, 40 * amount_usd / high_value_threshold_usd)
velocity_factor  = min(25, 5 * max(0, txn_count_1h - 3))      (count includes this transaction)
geo_factor       = 15 if country ∈ high_risk_countries
watchlist_factor = 20 if the counterparty is on an ACTIVE tenant watchlist
new_counterparty = 10 if (account, counterparty) was not seen in the last 30 days
demo_override    = 100 if the tenant is in demo mode and metadata.demoScenario = FORCE_CRITICAL
score            = min(100, round-half-up(sum))   band LOW < 40 | MEDIUM 40-69 | HIGH 70-84 | CRITICAL ≥ 85
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

MODEL_VERSION = "risk-heuristic-v1.0.0"
NEW_COUNTERPARTY_WINDOW_MS = 30 * 24 * 3600 * 1000
VELOCITY_WINDOW_MS = 3600 * 1000

Band = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]


@dataclass(frozen=True, slots=True)
class Inputs:
    amount_usd: Decimal
    high_value_threshold_usd: Decimal
    txn_count_1h: int
    country: str
    high_risk_countries: frozenset[str]
    watchlist_hit: bool
    counterparty_seen_within_30d: bool
    demo_mode: bool
    demo_scenario: str | None


@dataclass(frozen=True, slots=True)
class Factor:
    name: str
    value: float
    contribution: float


@dataclass(frozen=True, slots=True)
class Score:
    score: int
    band: Band
    factors: tuple[Factor, ...]


def band(score: int) -> Band:
    if score >= 85:
        return "CRITICAL"
    if score >= 70:
        return "HIGH"
    if score >= 40:
        return "MEDIUM"
    return "LOW"


def _amount_factor(amount_usd: Decimal, threshold: Decimal) -> Decimal:
    if threshold <= 0:
        return Decimal(40) if amount_usd > 0 else Decimal(0)
    return min(Decimal(40), Decimal(40) * amount_usd / threshold)


def score(i: Inputs) -> Score:
    amount = _amount_factor(i.amount_usd, i.high_value_threshold_usd).quantize(Decimal("0.01"), ROUND_HALF_UP)
    velocity = Decimal(min(25, 5 * max(0, i.txn_count_1h - 3)))
    geo = Decimal(15 if i.country in i.high_risk_countries else 0)
    watchlist = Decimal(20 if i.watchlist_hit else 0)
    new_cp = Decimal(0 if i.counterparty_seen_within_30d else 10)
    factors = [
        Factor("amount", float(i.amount_usd.quantize(Decimal("0.01"), ROUND_HALF_UP)), float(amount)),
        Factor("velocity", float(i.txn_count_1h), float(velocity)),
        Factor("geo", 1.0 if geo else 0.0, float(geo)),
        Factor("watchlist", 1.0 if watchlist else 0.0, float(watchlist)),
        Factor("new_counterparty", 1.0 if new_cp else 0.0, float(new_cp)),
    ]
    total = amount + velocity + geo + watchlist + new_cp
    if i.demo_mode and i.demo_scenario == "FORCE_CRITICAL":
        factors.append(Factor("demo_override", 1.0, 100.0))
        total += 100
    value = int(min(Decimal(100), total).quantize(Decimal(1), ROUND_HALF_UP))
    return Score(value, band(value), tuple(factors))


def counterparty_seen_within_30d(last_seen_ms: int | None, occurred_ms: int) -> bool:
    return last_seen_ms is not None and occurred_ms - last_seen_ms <= NEW_COUNTERPARTY_WINDOW_MS
