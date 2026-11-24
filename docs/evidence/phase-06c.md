# Phase 06 (slices 6c + 6d) — Analyst override, retention TTL — Exit Evidence

| | |
|---|---|
| Commit SHA | base `a1ba6c1` + uncommitted slices 6c + 6d |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers MongoDB 8.0.38 replica set; compose stack |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus); every stack command run by Claude Code |
| Resulting status | Slices 6c + 6d `RUNTIME-VERIFIED` locally |

## Scope
Spec: [FR-EVT-CLS-events-archive-classification](../specs/FR-EVT-CLS-events-archive-classification.md) §2 "Analyst override", "Retention".

## Commands and results
```
services/events: test:integration → 17/17 (archive 5, query 5, override 4, retention 3):
  FR-CLS-07 ANALYST: acquisition HIGH → LOW → OVERRIDDEN, source ANALYST, revision 2, statusHistory
            [INGESTED, RULE_SCANNED, OVERRIDDEN], classificationHistory[1] {ANALYST, LOW, analyst-override, actor,
            trimmed justification}, pendingAiScan false; outbox classification.overridden {before {CONFIDENTIAL, HIGH},
            after {CONFIDENTIAL, LOW}, actorId, justification}; identical repeat → revision stays 2, still one event
            short justification → 422 CLASSIFICATION_JUSTIFICATION_REQUIRED; VIEWER → 403; no fields → 422;
            restricted event → 404; other tenant → 404 (no event written)
            TENANT_ADMIN sensitivity RESTRICTED + CRITICAL → moved to events_restricted_audit, expireAt + 7 y
            two concurrent overrides → revisions 2 and 3, two events
  FR-EVT-07 TTL index ttl_expire_at (expireAfterSeconds 0) + ux_tenant_event + full §7.6 set on both tiers;
            expireAt 30 d / 3650 d per tenant, ≥ 2556 d restricted; TTL monitor (1 s, test only) deletes expired
            standard and restricted records, keeps a live one
gateway: vitest → 17/17 · events unit 34/34
make lint (0) · make typecheck (0) · make check (0) · make contracts (0) · make test-unit (0)
```

### Compose stack (2026-11-24, run by Claude Code)
```
rebuild + recreate events, gateway
make test-e2e → Test Files 6 passed · Tests 267 passed
  events E2E 3: acquisition webhook (rule HIGH) → VIEWER PATCH 403 → ANALYST "too short" 422
                CLASSIFICATION_JUSTIFICATION_REQUIRED → ANALYST LOW → 200 OVERRIDDEN {algorithm HIGH, final LOW,
                ANALYST, revision 2}, pendingAiScan false → classification.overridden appears in GET
                /v1/events/correlation/{corr} after the webhook
  role matrix + overrideEventClassification × 6 roles
```
