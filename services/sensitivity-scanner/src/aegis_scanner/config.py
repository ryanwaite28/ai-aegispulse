"""sensitivity-scanner settings (PROJECT.md §6.9, §10.4): env only, validated once at startup."""

from aegis_platform.config import PlatformSettings

SERVICE = "sensitivity-scanner"
PORT = 8087  # §5.4


class Settings(PlatformSettings):
    """All variables this runtime reads."""

    pass
