# Phase 06 (slice 6b) — Event queries — Exit Evidence

| | |
|---|---|
| Commit SHA | base `e557bc7` + uncommitted slice 6b |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers MongoDB 8.0.38 replica set; compose stack |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus); every stack command run by Claude Code |
| Resulting status | Slice 6b `RUNTIME-VERIFIED` locally |

## Scope
Spec: [FR-EVT-CLS-events-archive-classification](../specs/FR-EVT-CLS-events-archive-classification.md) §2 "Queries".

## Commands and results
```
services/events: vitest (unit) → 34/34 (+ causal ordering 2)
services/events: test:integration → 10/10 (archive 5, query 5):
  filters + keyset pages (2 + 1) + bad cursor 422; other tenant's event never returned
  restricted: VIEWER/ANALYST/TENANT_ADMIN → search excludes it, tier=restricted 403, get 404; CA → masked payload
  getEvent lineage: publisher CRITICAL + TRUSTED → final CRITICAL over algorithm MEDIUM; statusHistory INGESTED →
  RULE_SCANNED; PA without X-Aegis-Tenant 403, with it 200; other tenant 404
  correlation chain: root → effect → effect-of-effect (earlier occurredAt) → unrelated root
  searchEventsForEntities: external.* vs exact types, other tenant empty, user token 403; tenantless query refused
gateway: vitest → 17/17
make lint (0) · make typecheck (0) · make check (0) · make contracts (0) · make test-unit (0)
```

### Compose stack (2026-11-24, run by Claude Code)
```
rebuild + recreate events, gateway
make test-e2e → Test Files 6 passed · Tests 260 passed
  events E2E 1 (Phase 6 exit item "webhook visible via GET /v1/events?correlationId= with lineage"):
    signed webhook (x-correlation-id corr-…) → GET /v1/events?correlationId=…&eventType=external. →
    {external.market.alert, RULE_SCANNED, standard, CONFIDENTIAL, publisher HIGH, UNTRUSTED, algorithm MEDIUM,
     final MEDIUM, RULES, rules-v1.0.0}, no payload in the summary → GET /v1/events/{id}: exchange
    aegispulse.ingress, pendingAiScan true, statusHistory [INGESTED, RULE_SCANNED] →
    GET /v1/events/correlation/{corr}: [external.market.alert, classification.scan.requested (causationId = webhook)]
  events E2E 2 (Phase 6 exit item "masking demo with synthetic PAN"):
    summary "Client paid with card 4111 1111 1111 1111 yesterday" → restricted tier, RESTRICTED/PII;
    CA tier=restricted → "Client paid with card ************1111 yesterday", redaction payload.summary
    pii.payment_card; the full response never contains the card; VIEWER: standard search empty, tier=restricted 403,
    get 404; tenant B's CA: empty
  role matrix + searchEvents, getEvent, getEventCorrelationChain × 6 roles
```

## Pending (at the time of this slice)
> Superseded: every item below was completed later in the phase; see [phase-06.md](phase-06.md) for what remains.

- 6c analyst override (FR-CLS-07), 6d retention TTL/purge + the Mongo index listing (exit item).
