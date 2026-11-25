"""FR-TXN-04 factor table for risk-heuristic-v1.0.0 (PROJECT.md §1.4.4)."""

from dataclasses import replace
from decimal import Decimal

import pytest

from aegis_risk.domain.fx import fx_static_v1
from aegis_risk.domain.heuristic_v1 import Inputs, band, counterparty_seen_within_30d, score

BASE = Inputs(
    amount_usd=Decimal("10000"),
    high_value_threshold_usd=Decimal("50000"),
    txn_count_1h=1,
    country="DE",
    high_risk_countries=frozenset({"IR", "KP"}),
    watchlist_hit=False,
    counterparty_seen_within_30d=True,
    demo_mode=False,
    demo_scenario=None,
)


def contributions(i: Inputs) -> dict[str, float]:
    return {f.name: f.contribution for f in score(i).factors}


@pytest.mark.parametrize(
    ("change", "expected_score", "expected_band"),
    [
        ({}, 8, "LOW"),  # 40 x 10k / 50k
        ({"amount_usd": Decimal("50000")}, 40, "MEDIUM"),
        ({"amount_usd": Decimal("500000")}, 40, "MEDIUM"),  # capped at 40
        ({"txn_count_1h": 4}, 13, "LOW"),  # 5 x (4 - 3)
        ({"txn_count_1h": 20}, 33, "LOW"),  # velocity capped at 25
        ({"country": "IR"}, 23, "LOW"),
        ({"watchlist_hit": True}, 28, "LOW"),
        ({"counterparty_seen_within_30d": False}, 18, "LOW"),
        (
            {
                "amount_usd": Decimal("60000"),
                "txn_count_1h": 9,
                "country": "KP",
                "watchlist_hit": True,
                "counterparty_seen_within_30d": False,
            },
            100,
            "CRITICAL",
        ),  # 40 + 25 + 15 + 20 + 10 = 110 → capped
        ({"amount_usd": Decimal("50000"), "watchlist_hit": True, "counterparty_seen_within_30d": False}, 70, "HIGH"),
    ],
)
def test_factor_table(change: dict[str, object], expected_score: int, expected_band: str) -> None:
    s = score(replace(BASE, **change))  # type: ignore[arg-type]
    assert (s.score, s.band) == (expected_score, expected_band)


def test_demo_override_only_in_demo_mode() -> None:
    forced = replace(BASE, demo_scenario="FORCE_CRITICAL")
    assert score(forced).score == 8  # ignored without demoMode
    on = score(replace(forced, demo_mode=True))
    assert (on.score, on.band) == (100, "CRITICAL")
    assert contributions(replace(forced, demo_mode=True))["demo_override"] == 100.0


def test_bands_and_rounding_and_zero_threshold() -> None:
    assert [band(v) for v in (39, 40, 69, 70, 84, 85)] == ["LOW", "MEDIUM", "MEDIUM", "HIGH", "HIGH", "CRITICAL"]
    assert score(replace(BASE, amount_usd=Decimal("6875"))).score == 6  # 5.5 → 6 (half up)
    assert contributions(replace(BASE, high_value_threshold_usd=Decimal("0")))["amount"] == 40.0


def test_new_counterparty_window_and_fx() -> None:
    day = 24 * 3600 * 1000
    assert counterparty_seen_within_30d(None, 0) is False
    assert counterparty_seen_within_30d(0, 30 * day) is True
    assert counterparty_seen_within_30d(0, 30 * day + 1) is False
    fx = fx_static_v1()
    assert fx.version == "fx-static-v1"
    assert fx.to_usd(Decimal("100"), "EUR") == Decimal("108.00")
    with pytest.raises(KeyError):
        fx.to_usd(Decimal("1"), "XYZ")
