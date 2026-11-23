"""data-intel settings (PROJECT.md §6.9, §10.4): env only, validated once at startup."""

from pydantic import AnyHttpUrl, Field, SecretStr

from aegis_platform.config import AmqpSettings, PlatformSettings, PostgresSettings

SERVICE = "data-intel"
PORT = 8089  # §5.4


class Settings(PlatformSettings, AmqpSettings, PostgresSettings):
    """All variables this runtime reads."""

    S3_ENDPOINT: AnyHttpUrl
    S3_REGION: str = Field(min_length=1)
    S3_FORCE_PATH_STYLE: bool = True
    S3_ACCESS_KEY_ID: SecretStr
    S3_SECRET_ACCESS_KEY: SecretStr
    S3_BUCKET_PREFIX: str = Field(pattern=r"^aegispulse-(local|dev|prod)$")
