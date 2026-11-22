# AGENTS.md — AegisPulse

Instructions for any AI coding agent (Codex, Cursor, Copilot, Gemini, Claude) working in this repository.

1. **Source of truth:** `PROJECT.md`. Rules in §12 are binding. If this file or any other guidance disagrees with `PROJECT.md`, `PROJECT.md` wins.
2. **Session primer:** read `CLAUDE.md`. It holds the commands, file conventions, and the DO NOT list, and it applies to every agent, not only Claude.
3. **Steering:** `docs/steering/product.md` covers the why, `tech.md` the pinned versions, `structure.md` where code goes, and `quality.md` the definition of done.
4. **Decisions:** ADRs live in `docs/adr/`. Don't re-litigate an accepted ADR without writing a superseding one.
5. **Role guidance:** `.claude/skills/*/SKILL.md` files are plain Markdown checklists, usable by any agent. Pick the role that matches the task (architecture, engineering, DevSecOps, database, security, messaging, ML, data, SRE, platform, QA, frontend).

## Non-negotiables (summary of PROJECT.md §12)
- One external entrypoint: `gateway/fastify-http/`. It holds transport code only.
- Business logic lives only in `services/<bounded-context>/` service and domain layers. Handlers and consumers parse input, call one service action, and map the result.
- Gateways, workers, and adapters never open DB, cache, or object-store clients.
- Contracts come first (`packages/contracts`). Never hand-edit generated code.
- Canonical envelope, outbox publishing, no binaries on the broker, and idempotent consumers.
- Migrations are forward-only new files. Never edit existing ones.
- No secrets in code. Strict typing in all three languages.
- Integration tests use real dependencies (Testcontainers).
- Never claim verification you didn't run. Status follows `PROJECT.md` §11.0.

## Definition of Done for a change
- [ ] FR ids referenced in the commit/MR and in test names
- [ ] Spec in `docs/specs/` created or updated
- [ ] Contracts updated and regenerated (if wire shape changed)
- [ ] Unit and integration tests added and passing locally (paste the commands you ran)
- [ ] `PROJECT.md` §11 checklist/ledger updated honestly
- [ ] `CHANGELOG.md` `[Unreleased]` entry
- [ ] ADR + `PROJECT.md` amendment for any architectural change
