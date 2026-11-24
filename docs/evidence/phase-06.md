# Phase 06 — Events Archive & Stage-1 Classification — Exit Evidence

| | |
|---|---|
| Commit SHA | slices `e557bc7` (6a), `a1ba6c1` (6b) + uncommitted 6c, 6d and exit |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local compose stack (MongoDB 8 rs0, RabbitMQ 4); Testcontainers suites per slice |
| Pipeline | pending |
| Verified by | Claude Code (Opus); every stack command below was run by Claude Code |
| Resulting status | `RUNTIME-VERIFIED` locally; the exit waits on green pipelines |

Slice evidence: [6a](phase-06a.md) · [6b](phase-06b.md) · [6c + 6d](phase-06c.md). Spec: [FR-EVT-CLS](../specs/FR-EVT-CLS-events-archive-classification.md).

## §11 exit items
### 1. Webhook from Phase 4 visible via `GET /v1/events?correlationId=` with lineage
Captured by `tests/e2e/events.e2e.test.ts` on the stack ([6b](phase-06b.md)):
- A signed webhook (`x-correlation-id corr-…`) is found by its correlation id, with classification {CONFIDENTIAL, publisher HIGH, source_trust_level UNTRUSTED, algorithm MEDIUM, final MEDIUM, RULES, rules-v1.0.0}.
- `GET /v1/events/{id}` shows `statusHistory [INGESTED, RULE_SCANNED]`, `exchange aegispulse.ingress` and `pendingAiScan true`.
- The correlation chain is `external.market.alert` → `classification.scan.requested` (causationId = the webhook).
- The `make demo-webhook` event from Phase 4 was archived the same way ([6a](phase-06a.md)).

### 2. Masking demo with a synthetic PAN
A webhook summary of "Client paid with card 4111 1111 1111 1111 yesterday" was handled like this:
- It landed in `events_restricted_audit` (RESTRICTED, PII).
- COMPLIANCE_AUDITOR saw "Client paid with card ************1111 yesterday", with redaction `payload.summary` / `pii.payment_card`. The card number never appears in any response.
- VIEWER saw nothing: search empty, `tier=restricted` → 403, get → 404. Tenant B's auditor saw nothing ([6b](phase-06b.md)).

### 3. Mongo index listing (compose stack, `aegispulse_events`, 2026-11-24)
```
events_archive  (documents: 1886)
  _id_  {"_id":1}
  ux_tenant_event  {"tenantId":1,"eventId":1}  unique
  ix_tenant_correlation_time  {"tenantId":1,"correlationId":1,"occurredAt":-1}
  ix_tenant_final_severity_time  {"tenantId":1,"classification.final_severity":1,"occurredAt":-1}
  ix_status_time  {"status":1,"occurredAt":1}
  ix_tenant_type_time  {"tenantId":1,"eventType":1,"occurredAt":-1}
  ix_tenant_entity_time  {"tenantId":1,"mentionedEntityIds":1,"occurredAt":-1}
  ix_pending_ai_scan  {"pendingAiScan":1,"archivedAt":1}  partial={"pendingAiScan":true}
  ttl_expire_at  {"expireAt":1}  ttl=0s
events_restricted_audit  (documents: 3)
  _id_  {"_id":1}
  ux_tenant_event  {"tenantId":1,"eventId":1}  unique
  ix_tenant_correlation_time  {"tenantId":1,"correlationId":1,"occurredAt":-1}
  ix_tenant_final_severity_time  {"tenantId":1,"classification.final_severity":1,"occurredAt":-1}
  ix_status_time  {"status":1,"occurredAt":1}
  ix_tenant_type_time  {"tenantId":1,"eventType":1,"occurredAt":-1}
  ix_tenant_entity_time  {"tenantId":1,"mentionedEntityIds":1,"occurredAt":-1}
  ix_pending_ai_scan  {"pendingAiScan":1,"archivedAt":1}  partial={"pendingAiScan":true}
  ttl_expire_at  {"expireAt":1}  ttl=0s
outbox  (documents: 269)
  _id_  {"_id":1}
  ux_event_id  {"eventId":1}  unique
  ix_status_available  {"status":1,"availableAt":1}
  ttl_sent_7d  {"sentAt":1}  ttl=604800s
processed_messages  (documents: 0)
  _id_  {"_id":1}
  ux_consumer_event_generation  {"consumer":1,"eventId":1,"replayGeneration":1}  unique
  ttl_processed_14d  {"processedAt":1}  ttl=1209600s
```

## Final sweep (2026-11-24)
```
make lint (0) · make typecheck (0) · make check (0) · make contracts (0) · make test-unit (0; events 34/34)
services/events test:integration → 17/17 · make test-e2e → 267/267
```

## Notes
- Stage 2 (scanner, `events.classification.q`, the pending-scan sweep) is Phase 12. Until then, Stage-2 events stay `RULE_SCANNED` with `pendingAiScan`, and `final_severity` = the rule resolution (FR-CLS-06 "never blocked").
- One historical platform-tenant event sits in `events.archive.q.dlq` (dead-lettered before the 6a fix); the Phase 7 dead-letter tooling will replay it.

## Pending
- Green pipelines for the Phase 6 commits.
