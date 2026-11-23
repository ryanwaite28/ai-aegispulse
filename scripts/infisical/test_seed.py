"""MB-06 seeder logic, without touching Infisical: catalog validity, idempotent planning, generators, prod guard."""

import base64
import importlib.util
import sys
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("seed", Path(__file__).with_name("seed.py"))
assert _spec is not None
assert _spec.loader is not None
seed = importlib.util.module_from_spec(_spec)
sys.modules["seed"] = seed
_spec.loader.exec_module(seed)


def test_catalog_is_valid_and_covers_every_runtime() -> None:
    folders = seed.load_catalog()
    for runtime in (
        "gateway",
        "ingestion",
        "files",
        "events",
        "registry",
        "cases",
        "risk-scoring",
        "sensitivity-scanner",
        "doc-extraction",
        "data-intel",
        "orchestrator",
        "scheduler-trigger",
    ):
        assert "SERVICE_CLIENT_SECRET" in folders[runtime]
    assert folders["registry"]["JWT_SIGNING_KEY_CURRENT_PEM"] == "rsa2048-pem"


def test_plan_never_overwrites_and_defers_reference_and_external() -> None:
    keys = {"A": "hex24", "B": "hex32", "URL": "reference", "TOKEN": "external"}
    plan = seed.plan_folder("x", keys, existing={"A"})
    assert plan.present == ["A"]
    assert plan.to_generate == {"B": "hex32"}
    assert set(plan.deferred) == {"URL", "TOKEN"}
    assert seed.plan_folder("x", keys, existing=set(keys)).to_generate == {}


def test_generators_produce_well_formed_values() -> None:
    assert len(seed.GENERATORS["hex24"]()) == 48
    assert len(base64.b64decode(seed.GENERATORS["b64-32"]())) == 32
    keyfile = seed.GENERATORS["mongo-keyfile"]()
    assert 6 <= len(keyfile) <= 1024
    assert seed.GENERATORS["rsa2048-pem"]().startswith("-----BEGIN PRIVATE KEY-----")
    assert seed.GENERATORS["hex24"]() != seed.GENERATORS["hex24"]()


def test_refuses_without_token(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    monkeypatch.delenv("INFISICAL_TOKEN", raising=False)
    assert seed.main(["--env", "dev", "--dry-run"]) == 2
    assert "INFISICAL_TOKEN" in capsys.readouterr().err


def test_prod_requires_typed_confirmation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("INFISICAL_TOKEN", "test-only-not-a-token")
    monkeypatch.setattr("builtins.input", lambda _prompt: "yes")
    assert seed.main(["--env", "prod"]) == 1  # refused before any CLI call
