"""Canonical envelope codec (§6.4, FR-EVT-01): JSON Schema validation against the contract (non-JSON, invalid or
unknown-major envelopes are POISON ``ENVELOPE_INVALID``) and wire encoding that omits null optional members."""

import json
from functools import cache
from importlib.resources import files
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker

from aegis_contracts.envelope.canonical_envelope_v1_schema import CanonicalEnvelope, Uuid
from aegis_platform.errors import PoisonMessageError

ENVELOPE_INVALID = "ENVELOPE_INVALID"


@cache
def _schema() -> dict[str, Any]:
    raw = files("aegis_contracts.resources").joinpath("canonical-envelope.v1.schema.json").read_text("utf-8")
    loaded: dict[str, Any] = json.loads(raw)
    return loaded


@cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(_schema(), format_checker=FormatChecker())


def uuid_str(value: Uuid | None) -> str | None:
    """The plain UUID string of a generated ``Uuid`` root model (``str()`` would render ``root='…'``)."""
    return None if value is None else value.root


def event_id(envelope: CanonicalEnvelope) -> str:
    return envelope.eventId.root


def decode_envelope(body: bytes) -> CanonicalEnvelope:
    try:
        value = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise PoisonMessageError(ENVELOPE_INVALID, "message body is not JSON") from None
    error = next(iter(_validator().iter_errors(value)), None)
    if error is not None:
        where = "/" + "/".join(str(p) for p in error.absolute_path)
        raise PoisonMessageError(ENVELOPE_INVALID, f"envelope failed schema validation at {where} ({error.validator})")
    return CanonicalEnvelope.model_validate(value)


def encode_envelope(envelope: CanonicalEnvelope) -> bytes:
    """JSON with null optional members omitted (the closed schema allows null only where it says so)."""
    data: dict[str, Any] = envelope.model_dump(mode="json")
    required = set(_schema()["required"])
    data = {k: v for k, v in data.items() if v is not None or k in required}
    classification = data.get("classification")
    if isinstance(classification, dict):
        data["classification"] = {k: v for k, v in classification.items() if v is not None}
    return json.dumps(data, separators=(",", ":")).encode("utf-8")
