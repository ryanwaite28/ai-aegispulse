# Spec — FR-TXN-04 — Risk scoring (heuristic v1)

| | |
|---|---|
| Phase | 08 — slice 8b (`PROJECT.md` §11) |
| Owner runtime(s) | `services/risk-scoring` (Python/FastAPI) |
| Status | INTEGRATION-VERIFIED; runtime: `/readyz` and auth on the stack. The orchestrator call path is verified in 8e (saga) |
| Related | §1.4.4, §7.7 (`feat:*`), FR-TEN-08 (settings supplied by the caller) |

## 1. Requirement (verbatim)
> **FR-TXN-04**: Risk Scoring `score` (`POST /internal/v1/score`) computes features and the score per §1.4.4, returning `{score, band, factors[{name, value, contribution}], modelVersion, featureVersion, computedAt}`. Feature updates (velocity, counterparty history) are idempotent by `eventId` (Redis `SET NX feat:seen:{tenantId}:{eventId}` TTL 48 h) so redelivery does not inflate velocity.

## 2. Behavior
- **Authorization:** a SERVICE token whose `act[]` includes `riskScoring.score` (orchestrator). User and integration tokens get 403.
  - Authentication runs before body validation, so an unauthenticated caller learns nothing about the schema.
- **Request:** the contract `ScoreRequest`, a Pydantic model generated from `risk-scoring.internal.yaml` by `make contracts`. The orchestrator supplies `watchlistHit` (from `checkWatchlists`) and `tenantSettings` (from `getTenantSettings`, cached ≤ 60 s).
- **Amount:** converted to USD with `fx-static-v1`. A currency outside the table gets 422.
- **High-risk countries:** an empty tenant list falls back to `HIGH_RISK_COUNTRIES_DEFAULT`.
- **Features** (`RedisFeatureStore`; the ACL has no scripting and no MULTI):
  1. Read the velocity: `ZCOUNT feat:txn1h:{t}:{account}` over `[occurredAt − 1 h, occurredAt]`. The transaction itself counts.
  2. Read the counterparty's last-seen time: `HGET feat:cp:{t}:{account} {counterparty}`.
  3. Claim the event with `SET NX feat:seen:{t}:{eventId} <snapshot> EX 48h`. A loser (redelivery or concurrent duplicate) returns the stored snapshot, so the score is stable and velocity is not inflated.
  4. Apply idempotent updates: `ZADD` by eventId; trim entries 2 h older than this transaction (by `occurredAt`, so backdated history survives); move `HSET` last-seen forward only; TTLs 2 h and 30 d.
- **Score:** `risk-heuristic-v1.0.0`.
  - Factors: `amount`, `velocity`, `geo`, `watchlist`, `new_counterparty`, and `demo_override` (only with `demoMode` and `metadata.demoScenario = FORCE_CRITICAL`).
  - The score is `min(100, round-half-up(sum))`; bands are LOW < 40, MEDIUM 40–69, HIGH 70–84, CRITICAL ≥ 85.
  - A threshold of 0 means any positive amount scores the full 40.
- **Versions:** `modelVersion risk-heuristic-v1.0.0`, `featureVersion features-v1+fx-static-v1`.

## 3. Platform additions
- `aegis_platform.web`: §8.2 envelopes for FastAPI (`install_http`, `success`, `parse_model`), and request/correlation ids in the log context and response headers.
- `make contracts` also generates Pydantic models for the Python-owned internal APIs, in `aegis_contracts.openapi.{risk_scoring,sensitivity_scanner,data_intel}`.

## 4. Layer placement
| Piece | File |
|---|---|
| Domain | `aegis_risk/domain/heuristic_v1.py`, `aegis_risk/domain/fx.py` |
| Service | `aegis_risk/service/scoring.py` (`FeatureStore` port) |
| Redis adapter | `aegis_risk/adapters/redis/features.py` |
| HTTP adapter | `aegis_risk/adapters/http/score.py` |
| Config | `aegis_risk/config.py` (+ JWT verify settings, `RISK_MODEL`, `HIGH_RISK_COUNTRIES_DEFAULT`) |

## 5. Tests
| Level | Test | Proves |
|---|---|---|
| Unit | `tests/unit/test_heuristic_v1.py` | factor table (each factor, caps, sum cap 100, HIGH at 70), demo override only in demo mode, bands, rounding, zero threshold, 30-day window, FX |
| Unit | `tests/unit/test_score_route.py` | contract response shape; default high-risk list; redelivery stable (velocity 1 after 5 deliveries); 403 user token / missing act; 401 before validation; 422 amount/currency |
| Integration | `tests/integration/test_features_integration.py` (Redis 8, compose ACL `risk_scoring`) | velocity over the hour; redelivery returns the first snapshot; 8 concurrent duplicates agree and count once; 48 h TTL; ACL confines the user to `feat:*` |

FR-TEN-08 propagation (a settings change reaches scoring within 60 s) depends on the caller's settings cache, so it is tested with the saga in 8e.
