# ADR-0017 — Registry reconciles SERVICE account secret verifiers at startup

- **Status:** Accepted
- **Date:** 2026-11-23
- **Deciders:** Ryan M. Waite
- **PROJECT.md sections affected:** §2.1 (FR-TEN-07), §5.7.4, §7.1, §7.7, §10.4, §11 Phase 2
- **Related FR/NFR:** FR-TEN-07, FR-AUTH-04, NFR-06, NFR-08

## Context
Internal calls use SERVICE client-credentials tokens (ADR-0010). Each runtime holds its own `SERVICE_CLIENT_SECRET` in its Infisical folder (ADR-0012), and the registry must verify that secret to issue a token. PROJECT.md said only "migration seed + Infisical secret", and a migration can't hold per-environment secret hashes. That leaves no defined path from a runtime's secret to the registry's verifier.

## Decision
- `R__seed_service_accounts.sql` seeds one `SERVICE` account per runtime in §5.7.4. Each gets `client_id = svc-{runtime}` and `allowed_actions` equal to that runtime's `act[]` row. Changing an allowlist means changing that file in a reviewed MR.
- The registry receives `SERVICE_CLIENT_SECRET_{RUNTIME}` for each seeded account.
  - In dev/prod these keys in Infisical `/registry` are **secret references** to each runtime folder's `SERVICE_CLIENT_SECRET`, so each value exists exactly once.
  - Locally, `scripts/dev/ensure-local-vars.sh` generates them.
- At startup the registry **reconciles**, idempotently, under an advisory lock so replicas don't race:
  - If the presented secret matches a currently valid Argon2id verifier, nothing changes.
  - Otherwise it inserts a new verifier, and the previous one stays valid for 24 h (the same grace as FR-TEN-06 rotation). A missing variable logs a warning and leaves that account without a valid secret. Plaintext is never stored or logged.
- `issueClientCredentialsToken` verifies against the stored verifiers only.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A. Startup reconciliation from references (chosen) | One source of truth per secret; rotating a runtime secret is "change it in its folder, restart the registry and the runtime"; no manual steps per environment | The registry pod holds every runtime's client secret, so its compromise allows impersonating any runtime |
| B. One-shot `sync-service-accounts` Job | The long-running pod holds no other runtime secrets | Another step on every deploy and rotation; the Job still sees all the secrets |
| C. Operator registers each secret through an admin API | No new env vars | 11 manual registrations per environment; a new privileged route |

## Consequences
- Positive: SERVICE tokens work in every environment without manual steps; rotation stays in Infisical.
- Negative / accepted risks: the registry is the authorization server, so it is already the most sensitive runtime (it holds the signing key, which allows minting any token). Holding client secrets adds little beyond that. Mitigations: the variables are read once at startup and only hashed; NetworkPolicy and least-privilege principals still apply.
- Follow-up work:
  - Phase 9 renders the `/registry` references (catalog `reference` keys).
  - The key-rotation runbook covers runtime secret rotation.

## Verification
Registry integration tests in Phase 2b:
- a seeded account gets a token with `aud=aegispulse-internal` and the exact `act[]`;
- a restart with a changed secret keeps the old one valid during the grace period, then rejects it (clock-controlled);
- a wrong secret is rate limited per clientId;
- no plaintext appears in the DB or the logs.
