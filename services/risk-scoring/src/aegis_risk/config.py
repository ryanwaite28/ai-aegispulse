"""risk-scoring settings (PROJECT.md §6.9, §10.4): env only, validated once at startup."""

from typing import Literal

from pydantic import Field, SecretStr

from aegis_platform.config import JwtVerifySettings, PlatformSettings

SERVICE = "risk-scoring"
PORT = 8086  # §5.4


class Settings(PlatformSettings, JwtVerifySettings):
    """All variables this runtime reads."""

    REDIS_URL: SecretStr
    RISK_MODEL: Literal["heuristic", "iforest"] = "heuristic"
    #: §1.4.4 default high-risk list when the tenant's list is empty (comma-separated ISO alpha-2).
    HIGH_RISK_COUNTRIES_DEFAULT: str = Field(default="IR,KP,SY,CU,RU", pattern=r"^([A-Z]{2}(,[A-Z]{2})*)?$")

    def default_high_risk(self) -> frozenset[str]:
        return frozenset(c for c in self.HIGH_RISK_COUNTRIES_DEFAULT.split(",") if c)
