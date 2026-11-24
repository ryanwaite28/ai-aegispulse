# Phase 04 (slice 4a) — Webhook sources + secret crypto — Exit Evidence

| | |
|---|---|
| Commit SHA | base `5f4c561` + uncommitted slice 4a working tree |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers PostgreSQL 18.7 (migrate image; pool as `svc_ingestion`, under RLS) |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 4a `RUNTIME-VERIFIED` locally (integration + E2E 183/183) |

## Scope
Spec: [FR-WHK-01-08-webhook-ingestion](../specs/FR-WHK-01-08-webhook-ingestion.md) §2 "Secrets at rest" and "Source management".

## Commands and results
```
services/ingestion: vitest (unit) → 6/6   (crypto 3: round-trip, every tamper path + wrong KEK/version, KEK length;
                                            config 3 incl. "KEK missing → startup config error naming the key")
services/ingestion: test:integration → 4/4 (real PostgreSQL as svc_ingestion):
  FR-WHK-01 secret returned once; stored ciphertext never contains it; decrypts with the KEK; never in lists
  FR-WHK-01 sourceKey globally unique (other tenant, and after soft delete); bare hostnames only; TA role only
  FR-WHK-07 rotation: previous valid 72 h (controlled clock); second rotation replaces PREVIOUS; Idempotency-Key never replays a secret
  FR-WHK-07 trust change → exactly one ops.audit.source_trust_changed outbox row on aegispulse.intelligence; other tenant → 404 / empty list
gateway: vitest → 11/11 · ts-platform unit 58/58 (+uuidv7)
make lint (0) · make typecheck · make check · make contracts (generator fix: shared common.yaml request schemas)
make migrate → ingestion V3 webhook sources: Success
```

### E2E through the gateway (operator-run `make test-e2e`, 2026-11-24)
```
Test Files  3 passed (3)
     Tests  183 passed (183)
  role matrix 175 (29 routes × 6 roles + coverage), incl. the 5 /v1/webhook-sources* routes; auth 4; cross-tenant 4 incl. Phase 4
```
**Defect found and fixed.** The first `make up` crash-looped ingestion (`INGESTION_KEK_BASE64 must be 32 bytes`): the local generator had produced a KEK in the wrong format, and the helper only replaced missing or placeholder lines. Both scripts are fixed. That run also showed the role matrix accepting a 503 as "allowed"; it now requires < 500.

## Pending
- Slices 4b (verification, delivery persistence, outbox → `aegispulse.ingress`, gateway webhook route, adversarial suite) and 4c (expiry + sweep).
