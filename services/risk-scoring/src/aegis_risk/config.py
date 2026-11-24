"""risk-scoring settings (PROJECT.md §6.9, §10.4): env only, validated once at startup."""

from pydantic import SecretStr

from aegis_platform.config import PlatformSettings

SERVICE = "risk-scoring"
PORT = 8086  # §5.4


class Settings(PlatformSettings):
    """All variables this runtime reads."""

    REDIS_URL: SecretStr
