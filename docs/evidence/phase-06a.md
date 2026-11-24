# Phase 06 (slice 6a) — Archive consumer, Stage 1, finalization — Exit Evidence

| | |
|---|---|
| Commit SHA | base `8ff8457` + uncommitted slice 6a |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers MongoDB 8.0.38 (single-node replica set, baseline migration) + RabbitMQ 4.4.1; compose stack |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus); every stack command run by Claude Code |
| Resulting status | Slice 6a `RUNTIME-VERIFIED` locally |

## Scope
Spec: [FR-EVT-CLS-events-archive-classification](../specs/FR-EVT-CLS-events-archive-classification.md) §2 "Source trust", "archiveEvent", "Mongo outbox".

## Commands and results
```
services/events: vitest (unit) → 32/32
  rules-v1 baseline 20 rows (incl. 6 terminal families) · masking goldens: AWS key, PEM header, Slack token, generic
  assignment → "creds AKIA**************** … password=****"; card 4111… → ************1111, Luhn-invalid kept;
  SSN → ***-**-6789, 666/9xx kept; PII keys incl. nested arrays (payload.customer.contacts[0].accountNumber);
  MNPI → HIGH/CONFIDENTIAL unmasked; uuids/hex/dates untouched; p95 ≤ 5 ms over 2,000 runs
  severity-resolver: 1,440 combinations elevate-only; AI ≥ 0.60 only; publisher only when TRUSTED; override wins
  retention 400 d / 30 d / 7 y; platform, tenantless and unknown tenants → 400 (no failure)
services/events: test:integration → 5/5 (real Mongo replica set + RabbitMQ, production consumer adapter):
  3× publish of one event → 1 document; RULE_SCANNED, pendingAiScan, final HIGH (trusted publisher) over algorithm
  MEDIUM; scan.requested in the outbox once and on the broker once after the relay
  untrusted CRITICAL publisher → final MEDIUM; classification.finalized (terminal) archived CLASSIFIED, no outbox entry
  txn with a card → events_restricted_audit only, payload masked, redaction path, sha256 of the original, 7-year expiry,
  classification.finalized without payload text
  file.uploaded expiry = +30 d (tenant setting); replay header → replay.count 1 / lastJobId; unknown replay → no record
  missing eventId and non-JSON → events.archive.q.dlq with x-aegis-error-code ENVELOPE_INVALID, retry 0
services/ingestion: unit 15/15, integration 11/11 (trust stamp)
gradle :java-platform:test :registry:test :registry:integrationTest → BUILD SUCCESSFUL (registry envelopes validated)
make lint (0) · make typecheck (0) · make check (0) · make contracts (0) · make test-unit (0)
```

### Compose stack (2026-11-24, run by Claude Code)
```
rebuild + recreate events, ingestion → events /readyz ready (mongo, schema, objectstore, rabbitmq up)
events.archive.q backlog: 1,229 → 0 within 10 s (every event routed since Phase 4, now archived)
make demo-webhook → 202 eventId 01a20ecd-b1cd-7aed-8f50-34bdfbf3a3fc →
  events_archive: external.market.alert, exchange aegispulse.ingress, status RULE_SCANNED, pendingAiScan true,
  classification {CONFIDENTIAL, publisher_stated_severity HIGH, source_trust_level UNTRUSTED, algorithm MEDIUM,
  final MEDIUM, RULES, rules-v1.0.0, revision 1}, expireAt archivedAt + 400 d
  outbox classification.scan.requested: SENT
make test-e2e → Test Files 5 passed · Tests 240 passed
```

### Defects found and fixed during the slice
- **Platform-tenant envelopes were dead-lettered.** `getTenantSettings` 404s for the reserved platform tenant, and the archive treated that as permanent. The retention lookup now falls back to the default (unit-tested).
  - The one historical message (eventId `01a20b10-…`) stays in `events.archive.q.dlq`; the dead-letter registry and replay arrive in Phase 7.
- **Registry did not compile after the envelope amendment.** The generated Java `Classification` record gained a component; `RegistryEvents` now passes `source_trust_level = null`, which is omitted on the wire.

## Pending (at the time of this slice)
> Superseded: every item below was completed later in the phase; see [phase-06.md](phase-06.md) for what remains.

- 6b query APIs (the exit item `GET /v1/events?correlationId=` with lineage), 6c override, 6d retention TTL / purge, Mongo index listing.
