# Phase 04 — Webhook Ingestion — Exit Evidence

| | |
|---|---|
| Commit SHA | slices `da3bd14` (4a), `71a117e` (4b), `eb561a7` (4c) + uncommitted exit fixes (metric, demo) |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local compose stack; Testcontainers suites per slice |
| Pipeline | pending: results for `71a117e`, `eb561a7` and the exit commit |
| Verified by | Claude Code (Opus); operator-run stack commands |
| Resulting status | `RUNTIME-VERIFIED` locally (all three §11 exit items captured); exit needs green pipelines |

Slice evidence: [phase-04a](phase-04a.md) · [phase-04b](phase-04b.md) · [phase-04c](phase-04c.md). Spec: [FR-WHK-01-08](../specs/FR-WHK-01-08-webhook-ingestion.md).

## §11 exit items
### 1. Signed webhook → 202 → message on the broker (`make demo-webhook`, operator-run)
```
run 1: created source demo-market-feed (eeebd2c8-…)
       POST /webhooks/demo-market-feed → 202 {"deliveryId":"095dce3b-…","eventId":"01a20dd2-a3b2-7eb9-bc8c-d37f9449b595","duplicate":false}
       latest delivery: outcome=ACCEPTED eventId=01a20dd2-… slot=CURRENT
run 2: rotated the secret of demo-market-feed; the previous one stays valid 72 h
       POST /webhooks/demo-market-feed → 202 {"deliveryId":"a64c09c0-…","eventId":"01a20df7-ced0-7cc6-90b9-287537cd9b26","duplicate":false}
       latest delivery: outcome=ACCEPTED eventId=01a20df7-… slot=CURRENT
       disabled 1 earlier temporary admin(s); temporary tenant admin kept active (tenant's only admin; password never stored)
```
The broker, seen in the RabbitMQ UI (`events.archive.q`, bound to `#` on `aegispulse.ingress`; no consumer until Phase 6):
- 335 messages were queued. "Get messages" returns the head of the queue, which is an envelope from an earlier E2E webhook of the same flow.
- Envelope: exchange `aegispulse.ingress`, routing key `external.market.alert`, `delivery_mode 2`, headers `x-aegis-tenant`, `x-aegis-schema-version 1.0.0`.
- Body: `classification {status INGESTED, sensitivity UNCLASSIFIED, classification_source PRODUCER, publisher_stated_severity MEDIUM}`, `idempotencyKey e2e-whk-…:same-external-id:v1`, `payload.rawStorageKey raw/webhooks/{tenant}/2026/11/24/{uuid}.json` plus `sha256`. The raw body is not on the broker (ADR-0009).

### 2. Adversarial suite report (`make test-e2e`, operator-run 2026-11-24 09:11 local)
```
✓ security/webhooks.spec.ts (3 tests)   wrong secret, truncated signature, missing headers, tampered body → 401
                                         WEBHOOK_SIGNATURE_INVALID; skew ±301 s → 401 WEBHOOK_TIMESTAMP_SKEW; replay → 409;
                                         malformed JSON → 422 only after a valid signature; oversize → 413;
                                         disabled source → 404; accepted + duplicate:true
✓ e2e/role-matrix (181) · e2e/auth (4) · security/cross-tenant (4)
Test Files 4 passed (4) · Tests 192 passed (192)
```

### 3. OpenObserve rejection metric
- **Defect found here and fixed:** `aegispulse_webhook_rejected_total` never recorded. It was created at module load, before the MeterProvider existed, and the OTel metrics API has no proxy provider, so it stayed a no-op.
  - It is now created with the use case.
  - Unknown source keys are labelled `source="unknown"`, which keeps the label bounded.
  - Regression test `ingest-webhook.metrics.test.ts`: it fails on the old code (no points) and passes on the fix (`{source:"unknown",reason:"source"} = 2`).
- **Second defect, found the same way: local OTLP auth.**
  - The local `.env` had the signing-key PEM glued onto `OTEL_EXPORTER_OTLP_HEADERS` by an append without a trailing newline.
  - An in-container probe got `401 Unauthorized` from OpenObserve for both `/v1/metrics` and `/v1/traces`. Only lengths and character classes were inspected; no value was printed.
  - `ensure-local-vars.sh` now repairs this and guards against it.
- After the repair: the in-container probe got `200 {"partialSuccess":null}`, and all 9 runtimes carried the repaired 110-character header.
- **OpenObserve (operator, 2026-11-24, after `make test-e2e`):** metric `aegispulse_webhook_rejected_total`, Counter, "Webhook deliveries rejected, by source key and reason (FR-WHK-03)". Its labels:
  - `reason` has **5 values**: `source`, `signature`, `skew`, `replay`, `schema`. There is no `size`, because an over-1 MiB body gets its 413 from the gateway's route limit before ingestion sees it.
  - `source` has **2 values**: `unknown` (unknown keys and the disabled source) and the run's E2E source key. This shows the cardinality bound.
  - Resource labels: `service_name`, `service_namespace`, `service_version`, `deployment_environment_name`.

## Verification sweep for the exit fixes
```
make lint (0) · make typecheck (0) · make test-unit (0; ingestion 15/15) · ingestion test:integration 11/11
```

## Pending
- Green pipelines for `71a117e`, `eb561a7` and the exit commit.
