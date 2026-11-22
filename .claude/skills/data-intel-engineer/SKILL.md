---
name: data-intel-engineer
description: AegisPulse data-intelligence/analytics role. Use when working on services/data-intel fact ingestion, analytics schema, rollups, drift metrics (PSI, confidence drop, publisher-vs-algorithm disagreement), precision feedback from dispositions, Parquet exports, intel read APIs, or OpenObserve/console analytics views.
---

# Data Intelligence Engineer — AegisPulse

Source of truth: `PROJECT.md` §2.18 (FR-INTEL), §4.4.6, §7.5 (analytics DDL), §5.5 (`intel.facts.q`).

## Data flow
`intel.facts.q` (many routing keys) → `record_fact(envelope)` dispatches by `eventType` → one fact table insert keyed by `event_id` (the idempotency key). Facts are immutable, and corrections arrive as new facts (for example `classification.overridden`).

## Fact mapping
| eventType | Table |
|---|---|
| `risk.evaluation.recorded` | `fact_risk_scores` |
| `classification.finalized`, `classification.overridden` | `fact_classifications` (overridden → `overridden = true`) |
| `doc.extraction.completed`, `doc.extraction.review_required` | `fact_extractions` |
| `file.status.changed` | `fact_file_status` |
| `case.*` (incl. `case.disposition.recorded`) | `fact_case_events` |

## Rollups (SQL-first)
- Write rollups as CTE-based `INSERT … ON CONFLICT (pk) DO UPDATE` statements so reruns are idempotent. Scope `today` runs every 15 min, and `yesterday` runs nightly at 02:00 UTC.
- Use time-bounded scans on indexed `(tenant_id, occurred_at)`. Never scan an unbounded range.
- Percentiles via `percentile_cont` in SQL.

## Metrics definitions (keep them exactly like this)
- **PSI:** 10 fixed bins over score 0–100, current 7-day window vs. a 28-day baseline, per tenant and model version. ε = 1e-4 for empty bins. > 0.2 MEDIUM, > 0.3 HIGH.
- **Extraction confidence drop:** (baseline mean − current mean) / baseline mean, 1-day vs. 7-day baseline per extractor version. > 10% → MEDIUM.
- **Disagreement rate:** among events where both `publisher_stated_severity` and `algorithm_severity` are present, the share where they differ, per source per day. > 35% → MEDIUM.
- **Precision:** TP / (TP + FP) over the rolling 30 days, by model, rule, policy version, and case type. `NEEDS_REVIEW` is excluded until resolved.

## Outputs
- Breaches go in `drift_metrics` (unique per window), with outbox `intel.drift.detected` and `notification.requested` (N-07).
- Daily Parquet export (polars/pyarrow) to `analytics/{table}/dt=YYYY-MM-DD/part-0.parquet`, idempotent overwrite.
- Read APIs `/v1/intel/*` are tenant-scoped. `PLATFORM_ADMIN` can see cross-tenant data.

## Tests
Deterministic seeded facts → exact rollup values. Synthetic distribution shift → expected PSI band. Rerunning a rollup doesn't change results. Redelivered facts → one row.
