"""Canonical envelope v1 conformance in Python (PROJECT.md §6.4, §11 Phase 1): same examples as the TS suite."""

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker

CONTRACTS = Path(__file__).resolve().parents[1]
SCHEMA = json.loads((CONTRACTS / "envelope" / "canonical-envelope.v1.schema.json").read_text())
VALIDATOR = Draft202012Validator(SCHEMA, format_checker=FormatChecker())


def _examples(kind: str) -> list[Path]:
    return sorted((CONTRACTS / "envelope" / "examples" / kind).glob("*.json"))


def test_schema_is_valid_2020_12() -> None:
    Draft202012Validator.check_schema(SCHEMA)


@pytest.mark.parametrize("path", _examples("valid"), ids=lambda p: p.stem)
def test_accepts_valid_examples(path: Path) -> None:
    errors = list(VALIDATOR.iter_errors(json.loads(path.read_text())))
    assert errors == []


@pytest.mark.parametrize("path", _examples("invalid"), ids=lambda p: p.stem)
def test_rejects_invalid_examples(path: Path) -> None:
    assert not VALIDATOR.is_valid(json.loads(path.read_text()))
