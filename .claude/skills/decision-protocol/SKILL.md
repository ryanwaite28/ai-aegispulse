---
name: decision-protocol
description: AegisPulse deterministic decision procedure for any ambiguity met while executing the plan, such as an unspecified behavior, a conflicting source, a missing value, a test or bug outcome, or "should I ask the owner?". Resolves the choice from authoritative sources in a fixed order and records it, so sessions keep going without prompting unless there is a genuine blocker.
---

# Decision Protocol — AegisPulse

Use this whenever you are about to guess, or to ask the owner. Follow the steps in order and stop at the first one that settles the question.

## 1. Look it up (authority order)
1. `PROJECT.md`. It wins over everything (§12: when any doc disagrees, PROJECT.md wins). Check the FR text in §2, the deterministic rules in §1.4, NFRs in §3, the design in §4–§8, the plan in §11 and the rules in §12.
2. Accepted ADRs in `docs/adr/`.
3. `packages/contracts`, the wire truth (OpenAPI, AsyncAPI, schemas, topology, reference data).
4. `docs/steering/*`, `CLAUDE.md`, the role skills.
5. Existing specs in `docs/specs/` and established code patterns (do what the codebase already does).
6. The product layer: `product-manager` value hierarchy + `end-user-personas` jobs.
7. The conventional, least-surprising, safest default for this stack (deny by default, idempotent, elevate-only, fail closed).

## 2. Classify the outcome
- **Answered by 1–5:** just do it.
- **Clarification:** a behavior PROJECT.md implies but does not spell out. Examples: a migration number already taken, a field type that cannot hold the real value, an unspecified status mapping.
  - Do it, update PROJECT.md in the same change (bump "Last updated"), and add CHANGELOG `### Docs`.
  - Note it in the spec or evidence as `Clarification: …`.
- **Small amendment:** additive and consistent with existing patterns. Examples: an optional contract field, a reference file next to the topology, an env var following the `*_URL` pattern.
  - Apply `/amend-project`, contracts first, and record it. No owner question unless step 3 applies.
- **Architectural:** a new runtime, queue, exchange, table family, trust boundary or dependency class, or a breaking contract change.
  - Needs an ADR plus an amendment (`/new-adr`).
  - Proceed autonomously only if exactly one option satisfies PROJECT.md, the ADRs and the value hierarchy; otherwise ask (step 3).

## 3. Ask the owner only if one of these holds
- Two or more options remain that differ **materially in user value or in risk**, and neither the value hierarchy nor the personas break the tie.
- The decision is irreversible or outward-facing: prod, data deletion, external publishing, security posture.
- 🛑 MANUAL steps, missing credentials, or a permission denial (never work around them).

When asking, use one question with a recommended option first, the trade-offs in one line each, and what you will do meanwhile. Keep working on everything else that does not depend on the answer.

## 4. Record (always)
Write each decision where the next session will find it:
- **The change itself:** PROJECT.md (if it changes the plan), the spec (`Product decision:` / `Clarification:`), the evidence (what was verified), the CHANGELOG.
- **Memory**, only for owner preferences or non-obvious gotchas.

## 5. Test and bug outcomes
Use the `project-manager` procedure. Never weaken a security control or an assertion to get green (§12 rule 18). Never claim verification you did not run (§12 rule 16).
