---
name: amend-project
description: Safely amend PROJECT.md (the AegisPulse single source of truth) when implementation needs something it does not define — propagate the change to every affected section, contracts, steering docs, and changelog. Invoke as /amend-project "<what needs to change>".
---

# /amend-project $ARGUMENTS

Use this when implementation needs something `PROJECT.md` doesn't define, or defines inconsistently.

1. **State the gap:** quote the conflicting or missing text with section numbers, and name the FR or NFR that forces the change.
2. **Classify it:** is it a *clarification* (no behavior change), a *scope change* (new or changed FR or NFR), or an *architectural change* (a new pattern, runtime, queue, table, trust boundary, or dependency class)? An architectural change also needs `/new-adr`.
3. **Propose, then confirm:** present the exact diff to the user before editing, unless they've already approved this change.
4. **Propagate consistently.** Check and update every section that could reference it:
   - §1.3 entities · §1.4 rules · §2 FRs (ids are stable, so append new ids and never renumber) · §3 NFRs
   - §4.4 flows · §5.4 workloads/budget · §5.5 queues · §5.7 principals, allowlist, netpol
   - §6.1 tree · §6.2 ServiceAction · §6.4 envelope · §6.7 catalog · §7 DDL · §8 routes/errors
   - §10.4 env vars · §11 phase checklist (every new FR gets a `####` block with specs) · §12 rules · §14 tests · Appendix A
   - `packages/contracts`, `docs/steering/*`, `CLAUDE.md` (only if a rule or command changed), and the affected specs
5. **Bookkeeping:** update "Last updated" in the header table, and add a `CHANGELOG.md` `### Docs` entry describing the amendment.
6. **Consistency check:** grep for the old term or value across the repo and confirm no stale references remain. Confirm every FR in §2 still appears in §11.
