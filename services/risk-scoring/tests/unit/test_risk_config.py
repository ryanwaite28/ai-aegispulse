"""risk-scoring settings (§6.9, §10.4, NFR-11)."""

import pytest
from fastapi.testclient import TestClient

from aegis_platform.config import ConfigError, load_settings
from aegis_risk.config import PORT, Settings
from aegis_risk.main import create_app

VALID = {
    "AEGIS_ENV": "local",
    "REDIS_URL": "redis://risk_scoring:pw@redis:6379/0",
    "REGISTRY_URL": "http://registry:8084",
    "JWT_ISSUER": "aegispulse-registry",
    "JWT_AUDIENCE": "aegispulse",
}


def test_accepts_documented_variables_and_uses_the_5_4_port() -> None:
    assert load_settings(Settings, VALID).AEGIS_ENV == "local"
    assert PORT == 8086


def test_refuses_to_start_naming_keys_not_values() -> None:
    with pytest.raises(ConfigError) as caught:
        load_settings(Settings, {"AEGIS_ENV": "staging", "AMQP_URL": "http://u:topsecret@x"})
    assert "AEGIS_ENV" in [k for k, _ in caught.value.issues]
    assert "topsecret" not in str(caught.value)


def test_livez_answers_without_dependencies() -> None:
    # No `with`: the lifespan (dependency connections) does not run; liveness must not need it (NFR-11).
    client = TestClient(create_app(load_settings(Settings, VALID)))
    assert client.get("/livez").json() == {"status": "ok"}
    assert client.get("/readyz").status_code == 503  # not running yet
