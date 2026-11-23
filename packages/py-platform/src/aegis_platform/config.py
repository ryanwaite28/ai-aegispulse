"""Typed settings (PROJECT.md §6.9, §10.4, NFR-11): env vars only, parsed at startup by Pydantic Settings.

Every problem is reported in one ``ConfigError``; values are never echoed, so secrets cannot leak.
"""

from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConfigError(Exception):
    """All configuration problems, as ``(key, problem)`` pairs; no values."""

    def __init__(self, issues: list[tuple[str, str]]) -> None:
        self.issues = issues
        super().__init__("invalid configuration: " + "; ".join(f"{k} ({p})" for k, p in issues))


class AegisSettings(BaseSettings):
    """Base for service settings: env-only, case-sensitive names, unknown env ignored."""

    model_config = SettingsConfigDict(case_sensitive=True, extra="ignore", env_ignore_empty=True)


class PlatformSettings(AegisSettings):
    """Global variables (§10.4)."""

    AEGIS_ENV: Literal["local", "dev", "prod"]
    LOG_LEVEL: Literal["critical", "error", "warning", "info", "debug"] = "info"
    OTEL_SERVICE_NAMESPACE: str = "aegispulse"


class AmqpSettings(AegisSettings):
    """RabbitMQ (§10.4)."""

    AMQP_URL: SecretStr
    AMQP_PREFETCH_DEFAULT: int = Field(default=10, ge=1, le=1000)

    @field_validator("AMQP_URL")
    @classmethod
    def _amqp_scheme(cls, value: SecretStr) -> SecretStr:
        if not value.get_secret_value().startswith(("amqp://", "amqps://")):
            raise ValueError("must be an amqp:// or amqps:// URL")
        return value


class PostgresSettings(AegisSettings):
    """PostgreSQL for the owning service (§10.4)."""

    PG_HOST: str = Field(min_length=1)
    PG_PORT: int = Field(default=5432, ge=1, le=65535)
    PG_DATABASE: str = Field(min_length=1)
    PG_USER: str = Field(pattern=r"^svc_[a-z_]+$")
    PG_PASSWORD: SecretStr = Field(min_length=1)

    def conninfo(self) -> str:
        """libpq connection string (password included; never log it)."""
        return (
            f"host={self.PG_HOST} port={self.PG_PORT} dbname={self.PG_DATABASE} "
            f"user={self.PG_USER} password={self.PG_PASSWORD.get_secret_value()}"
        )


class JwtVerifySettings(AegisSettings):
    """Token verification (FR-AUTH-05)."""

    REGISTRY_URL: AnyHttpUrl
    JWT_ISSUER: str = Field(min_length=1)
    JWT_AUDIENCE: str = Field(min_length=1)


class AuthSettings(JwtVerifySettings):
    """Token verification + the runtime's SERVICE credentials (§10.4, FR-TEN-07)."""

    SERVICE_CLIENT_ID: str = Field(pattern=r"^svc-[a-z-]+$")
    SERVICE_CLIENT_SECRET: SecretStr = Field(min_length=16)


def load_settings[S: AegisSettings](cls: type[S], env: dict[str, str] | None = None) -> S:
    """Parse settings from ``env`` (default: the process environment). Raises ``ConfigError`` listing every problem."""
    try:
        if env is None:
            return cls()
        return cls.model_validate({k: v for k, v in env.items() if v != ""})
    except ValidationError as e:
        issues = [
            (".".join(str(p) for p in err["loc"]) or "(root)", "required" if err["type"] == "missing" else err["msg"])
            for err in e.errors(include_input=False, include_url=False, include_context=False)
        ]
        raise ConfigError(issues) from None
