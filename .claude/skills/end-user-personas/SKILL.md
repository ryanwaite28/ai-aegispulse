---
name: end-user-personas
description: AegisPulse end-user personas: who benefits from the platform and what each needs to get done. Use when deciding behavior, defaults, statuses, errors, views, API shapes or E2E acceptance, so the choice serves a real job instead of guesswork. Maps each persona to its §1.4.6 role.
---

# End-User Personas — AegisPulse

The users of AegisPulse work in a **regulated financial institution** (bank, broker or asset manager) or serve one. Each persona below is tied to its `§1.4.6` role. Use the persona's **job** and **failure that hurts** to choose between options.

## Priya — Risk & compliance analyst (`ANALYST`, the primary user)
- **Job:** triage the queue of risk cases each morning. Understand *why* each case exists (score factors, watchlist hits, correlated filings or news, severity lineage). Gather evidence and record a defensible disposition (TRUE_POSITIVE / FALSE_POSITIVE / NEEDS_REVIEW with rationale).
- **Needs:**
  - one queue across transaction and document risk, with no duplicates;
  - clear statuses;
  - explainable scores;
  - timelines of what happened;
  - fast filters by entity, severity and status;
  - classification overrides, with justification, when the model is wrong.
- **Failure that hurts:** a missed or duplicated case; an unexplainable score; evidence that changed after she relied on it; seeing another tenant's data.
- **Acceptance lens:** "Could I explain this case to my supervisor from what the platform shows me?"

## Marcus — Compliance team lead / tenant administrator (`TENANT_ADMIN`)
- **Job:** onboard and offboard users and integrations; configure webhook sources, connectors, watchlists and tenant thresholds (`highValueThresholdUsd`, `highRiskCountries`); see operational health; replay their tenant's history.
- **Needs:** safe self-service (rotations with grace windows, one-time secret display); settings that take effect predictably (≤ 60 s); visibility into dead letters and failures in his tenant.
- **Failure that hurts:** removing the last admin; leaked or unrotatable secrets; settings that silently don't apply.

## Elena — Compliance auditor / examiner liaison (`COMPLIANCE_AUDITOR`)
- **Job:** prove to an examiner who did what, when and why. Pull the audit trail for a case, verify the chain is intact, and read the restricted tier when required.
- **Needs:** an immutable, hash-chained log with actors, before/after, and the model and rule versions in effect; `verify` with `firstBrokenSeq`; restricted data visible only to her.
- **Failure that hurts:** any gap, reorder or edit in the audit trail; decisions without recorded versions.

## Dev — Integration engineer at the client (`INTEGRATION` service account)
- **Job:** push transactions and files from core systems and poll their status.
- **Needs:** idempotent submits (retries safe; same key + same body → same response; different body → 409); `202` + ids; stable error codes; size and rate limits documented; presigned uploads that just work.
- **Failure that hurts:** duplicates on retry; ambiguous errors; breaking contract changes.

## Sam — Platform operator / SRE (`PLATFORM_ADMIN`)
- **Job:** run the platform for all tenants: provision or suspend tenants, watch alerts, triage the DLQ, replay safely, recover from outages.
- **Needs:** metrics, alerts and runbooks; DLQ tooling with replay and discard; readiness that means something; nothing lost during dependency outages.
- **Failure that hurts:** silent message loss; alerts without a runbook; recovery that needs database surgery.

## Viewer — Executive or stakeholder (`VIEWER`)
- **Job:** read-only dashboards and case status.
- **Needs:** accurate summaries; never RESTRICTED data.

## Rita — Portfolio reviewer (outside the product; matters for §1.6)
- **Job:** in about 30 minutes, decide whether the engineering is principal-level.
- **Needs:**
  - runnable demos (`make demo-*`);
  - honest evidence files;
  - clean boundaries she can check (ArchUnit, contracts first);
  - resilience she can watch (retries, DLQ, replay);
  - security that is actually enforced (RLS, HMAC, masking).
- **Failure that hurts:** claims without evidence; hand-waved shortcuts; inconsistency between PROJECT.md and the code.

## Using personas
Name the persona and job in the spec when a choice depends on them, e.g. "Priya needs to see why: return factors with contributions". When personas conflict, apply the `product-manager` value hierarchy: trust > isolation > the analyst loop > operability > integration ergonomics > polish.
