"""doc-extraction settings (§6.9, §10.4, NFR-11)."""

import pytest
from fastapi.testclient import TestClient

from aegis_extract.config import PORT, Settings
from aegis_extract.main import create_app
from aegis_platform.config import ConfigError, load_settings

VALID = {"AEGIS_ENV": "local", "AMQP_URL": "amqp://u:p@rabbitmq:5672/aegispulse-local"}


def test_accepts_documented_variables_and_uses_the_5_4_port() -> None:
    assert load_settings(Settings, VALID).AEGIS_ENV == "local"
    assert PORT == 8088


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
