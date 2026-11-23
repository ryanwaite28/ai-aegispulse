"""Errors (§6.8) and settings (§6.9, NFR-11)."""

import pytest

from aegis_platform.config import (
    AmqpSettings,
    AuthSettings,
    ConfigError,
    PlatformSettings,
    PostgresSettings,
    load_settings,
)
from aegis_platform.errors import (
    ConflictError,
    FailureKind,
    PermanentError,
    PoisonMessageError,
    TransientError,
    classify_failure,
    describe_error,
)


def test_classifies_consumer_failures_fr_msg_01() -> None:
    assert classify_failure(TransientError("DEPENDENCY_UNAVAILABLE", "x")).kind is FailureKind.TRANSIENT
    assert classify_failure(PermanentError("NOT_FOUND", "x")).kind is FailureKind.PERMANENT
    assert classify_failure(PoisonMessageError("ENVELOPE_INVALID", "x")).kind is FailureKind.POISON
    assert classify_failure(ConflictError("CONFLICT", "x")).code == "CONFLICT"
    unknown = classify_failure(RuntimeError("bug"))
    assert (unknown.kind, unknown.code) == (FailureKind.TRANSIENT, "INTERNAL_ERROR")


def test_domain_errors_validate_codes_and_describe_safely() -> None:
    with pytest.raises(ValueError, match="invalid error code"):
        ConflictError("not-a-code", "x")
    assert (
        describe_error(TransientError("DEPENDENCY_UNAVAILABLE", "down"))
        == "TransientError[DEPENDENCY_UNAVAILABLE]: down"
    )
    assert len(describe_error(RuntimeError("x" * 2000))) == 500


def test_settings_parse_and_apply_defaults() -> None:
    env = {"AEGIS_ENV": "local", "AMQP_URL": "amqp://u:p@rabbitmq:5672/aegispulse-local"}
    assert load_settings(PlatformSettings, env).LOG_LEVEL == "info"
    assert load_settings(AmqpSettings, env).AMQP_PREFETCH_DEFAULT == 10


def test_config_errors_list_every_problem_without_values() -> None:
    secret = "never-print-this-secret"
    with pytest.raises(ConfigError) as caught:
        load_settings(
            PostgresSettings,
            {
                "PG_HOST": "",
                "PG_DATABASE": "aegispulse",
                "PG_USER": "postgres",
                "PG_PASSWORD": secret,
                "PG_PORT": "99999",
            },
        )
    keys = sorted(k for k, _ in caught.value.issues)
    assert keys == ["PG_HOST", "PG_PORT", "PG_USER"]
    assert dict(caught.value.issues)["PG_HOST"] == "required"
    assert secret not in str(caught.value)
    assert "99999" not in str(caught.value)
    with pytest.raises(ConfigError, match="SERVICE_CLIENT_SECRET"):
        load_settings(
            AuthSettings,
            {
                "REGISTRY_URL": "http://registry:8084",
                "JWT_ISSUER": "aegispulse-registry",
                "JWT_AUDIENCE": "aegispulse",
                "SERVICE_CLIENT_ID": "svc-data-intel",
                "SERVICE_CLIENT_SECRET": "short",
            },
        )
