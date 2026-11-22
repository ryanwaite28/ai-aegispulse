---
name: implement-fr
description: Implement one AegisPulse functional requirement (or FR group) end-to-end following PROJECT.md — contracts, migration, domain, repository, service, adapters, gateway, tests, checklist and changelog updates. Invoke as /implement-fr FR-XXX-NN.
---

# /implement-fr $ARGUMENTS

Implement **$ARGUMENTS** exactly as `PROJECT.md` defines it. Don't expand scope.

## 1. Load context (read, don't skim)
- The FR bullet(s) in `PROJECT.md` §2 and its `####` block in §11 (phase, checklist items).
- The spec in `docs/specs/` for this FR. If it's missing, run `/write-spec $ARGUMENTS` first and stop for review if anything is ambiguous.
- The relevant sections: §1.4 (rules), §5.5/§5.7 (queues and principals), §6.2 (actions), §6.4/§6.7 (envelope and events), §7 (DDL), §8 (routes and errors).
- The role skills that apply: always `principal-engineer`, plus `database-admin` (migrations), `messaging-engineer` (events and consumers), `cybersecurity` (auth, input, files, webhooks), `ml-ai-engineer` (Python models), and `frontend-engineer` (console).
- Phase dependencies: confirm that earlier phases this FR relies on are at least `INTEGRATION-VERIFIED`. Otherwise flag it.

## 2. Plan
Write a short plan listing every file to create or modify, grouped by layer (contract → migration → domain → repository → service → adapters → gateway → tests). Check each file against `docs/steering/structure.md`. If any file or pattern isn't covered by `PROJECT.md`, stop and use `/amend-project`.

## 3. Implement in order
1. Contracts (`packages/contracts`), then `make contracts`.
2. Migration as a **new** `V{n}__*.sql` (or a Mongo migration).
3. Domain: pure code with table and property tests.
4. Repository with Testcontainers integration tests.
5. Service / use case: authz, tenant, idempotency, transaction, outbox. Unit tests with fakes.
6. Adapters (internal route / consumer): parse → one action → map. Add consumer redelivery, retry, and DLQ tests.
7. Gateway NestJS controller + typed client (public FRs), plus error mapping tests.
8. E2E acceptance test named with the FR id.

## 4. Verify (run, don't assume)
`make lint typecheck test-unit test-integration` (scoped to the affected runtimes), plus `make test-e2e` when the compose stack applies. Record the exact commands and results.

## 5. Update records honestly
- Tick only the `PROJECT.md` §11 checklist items that are actually satisfied, and set the FR status in the spec to the verified level (§11.0 vocabulary).
- Add a `CHANGELOG.md` `[Unreleased]` entry: `- $ARGUMENTS: <what> (Phase N)`.
- Record any new dependency in `docs/steering/tech.md`.

## 6. Self-review before finishing
Run the `architecture-reviewer` and `security-reviewer` agents on the diff, and `spec-tracer` for $ARGUMENTS. Fix what they find, or report it.

## Report back
Files changed, tests added (names), commands run with results, the status reached, and anything left unverified or blocked.
