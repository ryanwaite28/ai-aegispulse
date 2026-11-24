"""Shared fixtures: schema-valid envelopes (PROJECT.md §6.4) and repo paths."""

import json
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from aegis_contracts.envelope.canonical_envelope_v1_schema import CanonicalEnvelope

REPO = Path(__file__).resolve().parents[3]
CONTRACTS = REPO / "packages" / "contracts"


def example_payload(event_type: str) -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads((CONTRACTS / "events" / "examples" / f"{event_type}.json").read_text())
    return loaded


def envelope(event_type: str = "classification.finalized", **overrides: Any) -> CanonicalEnvelope:
    now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    data: dict[str, Any] = {
        "eventId": str(uuid.uuid4()),
        "correlationId": f"corr-{uuid.uuid4()}",
        "causationId": None,
        "tenantId": str(uuid.uuid4()),
        "schemaVersion": "1.1.0",
        "eventType": event_type,
        "source": "service:events",
        "producer": "aegispulse-events@abc1234",
        "occurredAt": now,
        "ingestedAt": now,
        "idempotencyKey": f"events:{uuid.uuid4()}",
        "classification": {"sensitivity": "INTERNAL", "status": "CLASSIFIED"},
        "payload": example_payload(event_type),
    }
    data.update(overrides)
    return CanonicalEnvelope.model_validate(data)
