"""Static FX table ``fx-static-v1`` (PROJECT.md §1.4.4): USD amounts without live FX. Pure; the table is the contract
reference file shipped as an ``aegis_contracts`` package resource."""

import json
from dataclasses import dataclass
from decimal import Decimal
from functools import cache
from importlib.resources import files


@dataclass(frozen=True, slots=True)
class FxTable:
    version: str
    usd_per_unit: dict[str, Decimal]

    def to_usd(self, amount: Decimal, currency: str) -> Decimal:
        rate = self.usd_per_unit.get(currency)
        if rate is None:
            raise KeyError(currency)
        return amount * rate


@cache
def fx_static_v1() -> FxTable:
    raw = json.loads(files("aegis_contracts.resources").joinpath("fx-static-v1.json").read_text("utf-8"))
    return FxTable(raw["version"], {ccy: Decimal(rate) for ccy, rate in raw["usdPerUnit"].items()})
