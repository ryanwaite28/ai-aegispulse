"""FR-MSG-01 routing, FR-EVT-01 envelope suite (Python kit), outbox policy (§6.6)."""

import json
from pathlib import Path

import pytest

from aegis_contracts.topology import QueueName, policy
from aegis_platform.amqp import RouteAction, failure_route, header_int
from aegis_platform.db import qualified
from aegis_platform.envelope import decode_envelope, encode_envelope
from aegis_platform.errors import ClassifiedFailure, FailureKind, PoisonMessageError
from aegis_platform.outbox import OutboxMessage, backoff_seconds
from tests.fixtures import CONTRACTS, envelope

TRANSIENT = ClassifiedFailure(FailureKind.TRANSIENT, "X")


def test_retry_tiers_then_dlq_from_the_contract() -> None:
    facts = policy(QueueName.INTEL_FACTS_Q)
    assert facts.prefetch == 50
    assert [failure_route(facts, n, TRANSIENT).routing_key for n in range(3)] == [
        "intel.facts.q.retry.1s",
        "intel.facts.q.retry.5s",
        "intel.facts.q.retry.30s",
    ]
    assert failure_route(facts, 3, TRANSIENT).action is RouteAction.DEAD_LETTER
    assert failure_route(policy(QueueName.DOC_EXTRACTION_Q), 0, TRANSIENT).routing_key == "doc.extraction.q.retry.5s"
    assert failure_route(facts, 0, ClassifiedFailure(FailureKind.POISON, "E")).action is RouteAction.DEAD_LETTER
    assert failure_route(policy(QueueName.EVENTS_DEADLETTER_Q), 0, TRANSIENT).action is RouteAction.REQUEUE
    with pytest.raises(KeyError):
        policy(QueueName.INTEL_FACTS_Q_DLQ)


def test_reads_headers_defensively() -> None:
    assert header_int({"x-retry-count": 2}, "x-retry-count") == 2
    assert header_int({"g": b"3"}, "g") == 3
    assert header_int({"g": "-1; drop"}, "g") == 0
    assert header_int({"g": True}, "g") == 0
    assert header_int({}, "g") == 0


@pytest.mark.parametrize(
    "path", sorted((CONTRACTS / "envelope" / "examples" / "valid").glob("*.json")), ids=lambda p: p.stem
)
def test_decodes_valid_examples(path: Path) -> None:
    assert decode_envelope(path.read_bytes()).schemaVersion.startswith("1.")


@pytest.mark.parametrize(
    "path", sorted((CONTRACTS / "envelope" / "examples" / "invalid").glob("*.json")), ids=lambda p: p.stem
)
def test_rejects_invalid_examples_as_poison_fr_evt_01(path: Path) -> None:
    with pytest.raises(PoisonMessageError) as caught:
        decode_envelope(path.read_bytes())
    assert caught.value.code == "ENVELOPE_INVALID"


def test_encode_omits_null_optionals_and_round_trips() -> None:
    e = envelope()
    wire = json.loads(encode_envelope(e))
    assert "tenantSlug" not in wire
    assert wire["causationId"] is None
    assert "final_severity" not in wire["classification"]
    assert decode_envelope(encode_envelope(e)) == e
    with pytest.raises(PoisonMessageError):
        decode_envelope(b"{not json")


def test_outbox_policy() -> None:
    assert [backoff_seconds(n) for n in (1, 2, 8, 9, 20)] == [2, 4, 256, 300, 300]
    with pytest.raises(ValueError, match="routing key"):
        OutboxMessage("aegispulse.intelligence", "intel.drift.detected", envelope())
    assert qualified("analytics", "outbox_events") == '"analytics".outbox_events'
    with pytest.raises(ValueError, match="identifier"):
        qualified("analytics; drop", "x")
