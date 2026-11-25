---
name: project-manager
description: AegisPulse project-manager role. Use at the start and end of every work session, phase or slice. It decides what to do next, how to split a phase into slices, when work is done, when to commit and push automatically, how to handle failing tests or discovered bugs, when a stop for the owner is justified, and how to report status. It makes execution of the PROJECT.md §11 plan deterministic.
---

# Project Manager — AegisPulse

Run the PROJECT.md §11 plan from start to finish with as little owner input as possible. The owner wants autonomy: stop only for real blockers.

## What to work on next (deterministic order)
1. Unfinished work in the current slice: failing tests, unchecked items you started, missing evidence.
2. Open items of the current phase in §11, in checklist order. Respect dependencies: contracts → migrations → domain → service → adapters → gateway → tests → evidence.
3. Carry-overs explicitly assigned to this phase in the ledger or phase notes (e.g. "moved to Phase 8").
4. The next phase in §11 order. Never skip a phase, and never start one whose prerequisite gate item is open unless the plan says it can run in parallel.

**Splitting a phase:** vertical slices (`8a`, `8b`, …) that each deliver an FR group end-to-end and can be verified alone. Prefer slices that unblock later slices (shared kits, contracts, the owner service of a dependency) first.

## Definition of done (slice)
- [ ] Contracts first (`make contracts`, no hand edits in `generated/`); a spec in `docs/specs/` (`write-spec` format).
- [ ] Code follows the layering rules (`architecture-reviewer` heuristics); new migrations only.
- [ ] Tests named with FR ids: unit; integration against real dependencies (Testcontainers); E2E or runtime where the FR is user-visible.
- [ ] On the compose stack: every changed runtime image rebuilt (`docker compose build` + `up -d --force-recreate`), then `make migrate` → `/readyz`, then `make test-e2e`, plus demos where the phase defines one.
- [ ] `make lint`, `make typecheck`, `make test-unit` exit 0, and integration suites for every touched package. Check every package's summary line: `make test-integration` stops at the first failing pnpm package.
- [ ] Evidence file `docs/evidence/phase-NN{x}.md`, §11 checklist and ledger updated honestly, CHANGELOG `[Unreleased]` entry.
- [ ] Security-relevant or architectural slices: run the `security-reviewer` / `architecture-reviewer` agents before calling the phase done, and fix their blockers and majors.

## Commit and push (owner rule, 2026-11-25)
When a phase or spec slice reaches the definition of done **and all tests pass**:
1. Commit with a descriptive message and the attribution trailer.
2. Push to **both** remotes: `git push origin feature/project` (GitLab pipelines) and `git push github feature/project` (upstream).
3. Continue with the next slice. Do not ask.

Never commit with failing or skipped-because-broken tests, secrets, `.env*` files, or unverified claims. If tests fail, fix them first (see below). A partial slice is not committed unless the owner asks.

## When tests fail or a bug is found
Decide with PROJECT.md, in this order:
1. **Regression from my change:** fix it now; it is part of the slice.
2. **Pre-existing defect inside the plan's scope** (e.g. a stale test, a harness race, a config bug):
   - Fix it in the same slice when it is small and clearly within an existing FR or NFR.
   - Log it under CHANGELOG `### Fixed` and in the evidence file's "Defects found and fixed".
3. **Defect that needs new behavior or scope:** treat it as a spec gap → `decision-protocol` → amendment or a carry-over item in the right phase's checklist.
4. **Flaky infrastructure** (container start timeouts, host load):
   - Rerun the affected file alone, record both runs honestly, and look for a root cause before blaming flakiness.
   - Never weaken an assertion or a security control to pass (§12 rule 18).
5. **Owner-only fix** (credentials, 🛑 MANUAL, prod access): stop per `decision-protocol`.

## When to stop for the owner (only these)
- 🛑 MANUAL steps that are not DONE (§12 rule 19), with the runbook's exact steps.
- A permission denial for an action the plan needs (e.g. a classifier block on `.env` reads). Hand the exact command to the owner; never work around it.
- A product or scope decision the `decision-protocol` cannot settle (materially different user value, no rule applies).
- Destructive or prod-affecting actions (data resets outside local, prod deploys, history rewrites).

## Status report (end of each slice; short)
- What shipped (FRs, files of note) and the commit hash.
- Verification actually run, with numbers (unit, integration, E2E, demo).
- Decisions made autonomously, each one line, and where they are recorded.
- What is next. Owner action only if one of the stop conditions applies.
