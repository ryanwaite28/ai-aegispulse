# ADR-0012 — Runtime secrets via Infisical Operator; pipeline secrets via GitLab variables

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §3 NFR-08, §5.3, §9.2, §9.3, §10.4
- **Related:** source §6.2; K3S_CONTEXT §3.4, §5

## Context
The source specifies Infisical, which is already self-hosted on the cluster. The cluster guide separates pipeline secrets (GitLab variables) from runtime secrets (Kubernetes Secrets).

## Decision
- Runtime: an Infisical project `aegispulse` (envs `local`, `dev`, `prod`, one operator machine identity per cluster environment; ADR-0014). The Infisical Kubernetes Operator syncs per-component Secrets, and Deployments reference them with `secretKeyRef` only. The CI deployer cannot read Secrets.
- Pipeline: GitLab Protected + Masked variables (deploy token, cosign key, Sonar token, DAST credentials).
- Local: `infisical export --env=local` writes `.env`, which is gitignored and blocked from AI edits by a hook.
- Dual-key rotation is supported for JWT signing keys and webhook secrets. Webhook secrets are envelope-encrypted with a KEK from Infisical.
- Services fail fast at startup on missing or malformed secrets.

## Consequences
- The cluster must have the Infisical Operator installed and verified (Phase 9 bootstrap).
- Secret rotation runbooks are required.

## Verification
Phase 9: delete a key in the test namespace and confirm CrashLoop with a clear message; run a rotation drill.
