"""doc-extraction settings (PROJECT.md §6.9, §10.4): env only, validated once at startup."""

from aegis_platform.config import AmqpSettings, PlatformSettings

SERVICE = "doc-extraction"
PORT = 8088  # §5.4


class Settings(PlatformSettings, AmqpSettings):
    """All variables this runtime reads."""

    pass
