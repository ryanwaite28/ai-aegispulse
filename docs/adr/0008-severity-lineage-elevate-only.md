# ADR-0008 — Severity lineage and elevate-only resolution

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §1.4.1–§1.4.3, §6.4, FR-CLS-*
- **Related:** FR-INTEL-03

## Context
Producers assert severity (`publisher_stated_severity`), but they're not trusted by default. Rules and AI infer severity at different speeds and with different confidence. Analysts need final authority, with accountability.

## Decision
- Keep three signals plus status: `publisher_stated_severity` (never mutated), `algorithm_severity` (rules, raised by AI when confidence ≥ 0.60), and `final_severity` (authoritative).
- `final = max(algorithm, publisher if source.trust_level = TRUSTED)`. Automated stages may only raise severity. Lowering requires an analyst override with a justification of at least 20 characters, which is audited.
- Every stage appends to `classificationHistory` with its rule or classifier version and confidence. Patches are revision-guarded.
- If Stage 2 is unavailable, the event keeps the Stage 1 result and `pendingAiScan=true` (it never blocks).

## Consequences
- Severities drift upward until analysts correct them. The data-intel disagreement and override metrics make that visible.
- Source trust level is a security-relevant setting, so changes to it are audited.

## Verification
Property tests on the resolver (no automated path lowers severity), golden classification fixtures, and lineage shown in Phase 12 evidence.
