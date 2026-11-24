# Phase 04 (slice 4b) — Webhook verification, persistence, outbox — Exit Evidence

| | |
|---|---|
| Commit SHA | base `da3bd14` + uncommitted slice 4b working tree |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers PostgreSQL 18.7, Redis 8.10.3 (compose ACL), RabbitMQ 4.4.1, SeaweedFS 4.54 |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 4b `RUNTIME-VERIFIED` locally (integration + E2E 192/192 incl. the adversarial suite) |

## Scope
Spec: [FR-WHK-01-08-webhook-ingestion](../specs/FR-WHK-01-08-webhook-ingestion.md) §2 "Ingest". Migration `V4__webhook_deliveries`.

## Commands and results
```
services/ingestion: vitest (unit) → 12/12  (signature 4: canonical string, CURRENT/PREVIOUS, multi-signature parsing,
                                             malformed → invalid, every pair via timingSafeEqual (spy), ±300 s skew;
                                             envelope-builder 2: Ajv against the contract envelope + event schemas)
services/ingestion: test:integration → 8/8 (real PostgreSQL as svc_ingestion, Redis ACL user, RabbitMQ, SeaweedFS):
  FR-WHK-05 accepted → raw object stored, delivery row, exactly one event on a queue bound to external.# across 3 relay restarts
  FR-WHK-05 same idempotency key → 202 duplicate:true, DUPLICATE row, no second event
  FR-WHK-03 rejections: unknown/disabled source, suspended tenant, bad signature, skew, replay, schema, size
  FR-WHK-07 the previous secret verifies for 72 h after a rotation, then stops
gateway: vitest → 14/14 (+ raw bytes forwarded byte-exact with the gateway token; 1 MiB only on /webhooks; strict JSON elsewhere)
ts-platform: vitest → 59/59 (+ STATUS_BY_CODE equals PROJECT.md §8.4)
make contracts OK · make lint (0) · make typecheck (0) · make test-unit (0) · tests/ tsc clean
```

### Defect found and fixed
The kit's `toErrorResponse` only knew the shared codes, so `WEBHOOK_SOURCE_NOT_FOUND` came back as 409 instead of 404. `STATUS_BY_CODE` now holds all 50 §8.4 codes, and a test parses §8.4 to keep them equal.

### E2E through the gateway (operator-run, 2026-11-24, after `make migrate` + image rebuild + `make up`)
```
 ✓ security/webhooks.spec.ts (3 tests)       accepted + duplicate; every attack → its code; disabled source → 404
 ✓ e2e/auth.e2e.test.ts (4 tests)
 ✓ security/cross-tenant.spec.ts (4 tests)
 ✓ e2e/role-matrix.e2e.test.ts (181 tests)   (30 routes × 6 roles + coverage, incl. listWebhookDeliveries)
 Test Files  4 passed (4)
      Tests  192 passed (192)
```
The attacks covered: wrong secret, truncated signature, missing headers, body tampered after signing, skew ±301 s, replayed delivery id, malformed JSON (422 only after a valid signature, 401 otherwise), oversize (413).

## Pending (at the time of this slice)
> Superseded: every item below was completed later in the phase; see [phase-04.md](phase-04.md) for what remains.

- Phase 4 exit: `scripts/demo/webhook-sign.mts` → 202 → message seen on the broker; an OpenObserve screenshot of `aegispulse_webhook_rejected_total`.
- Slice 4c (expiry + orphan sweep).
