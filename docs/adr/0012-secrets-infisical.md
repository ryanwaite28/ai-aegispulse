# ADR-0012 — Runtime secrets via Infisical Operator; pipeline secrets via GitLab variables

- **Status:** Accepted (amended 2026-11-23: real Infisical layout, no `local` environment, identity model, manual bootstrap)
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

## Amendment (2026-11-23)
- **Actual layout.** Instance `infisical.rmwhs.com` (in-cluster, namespace `infisical`), org **HomeLab**, project **AegisPulse** (`16d178ac-eebb-4295-9243-b52b04ff3286`). The environments are **Development** and **Production**, mapped to namespaces `aegispulse-dev` and `aegispulse`. Folders and keys are listed in `deploy/infisical/secrets-catalog.yaml`.
- **No `local` environment.** Local `.env` files are always generated (`make env`) and never exported from Infisical, so laptops never hold dev or prod secrets (NFR-06). This supersedes "Local: `infisical export --env=local`".
- **Identities.** `svc_admin` (an org-level machine identity) is used only from an operator's workstation for bootstrap, seeding and rotation (Universal Auth, short-lived client secret). It is never placed in the cluster or CI. Each cluster environment gets its own operator identity (`aegispulse-operator-dev`/`-prod`), read-only to that environment, authenticated with **Kubernetes Auth** (no static credential; ServiceAccount token verified via TokenReview). Universal Auth is the fallback.
- **Generated vs external.** Data-store folders own generated passwords. Runtime folders compose connection strings by Infisical secret references, so each password exists once. External tokens (OpenObserve, LLM, ntfy) are entered by their owners.
- **Manual bootstrap.** Infisical setup steps are 🛑 MANUAL (MB-03 to MB-06, MB-08 in `docs/runbooks/manual-bootstrap.md`). The agent prepares scripts and manifests and stops; the operator runs them and reports back names only.
- **Observed state (2026-11-23).** The Infisical server is running. The Kubernetes Operator is installed (chart `secrets-operator` 0.11.18, MB-05). The environment slugs are `dev`/`prod` (MB-04).
- **Accepted homelab risk.** `svc_admin` keeps org-level Admin for simplicity. An enterprise setup would use a project-scoped admin identity, short-TTL, IP-restricted client secrets, SSO+MFA break-glass and audit export (details in `docs/runbooks/infisical.md`).

## Consequences
- The cluster must have the Infisical Operator installed and verified (Phase 9 bootstrap).
- Secret rotation runbooks are required.

## Verification
Phase 9: delete a key in the test namespace and confirm CrashLoop with a clear message; run a rotation drill.
