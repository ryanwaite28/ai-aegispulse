# Infisical — secrets for dev and prod (ADR-0012)

## Context (identifiers only; no credentials ever go in this repo)
| Item | Value |
|---|---|
| Instance | `https://infisical.rmwhs.com`, self-hosted in the cluster's `infisical` namespace (running; verified 2026-11-23) |
| Organization | **HomeLab** (`5eae7a07-7aaa-4bfd-b6cd-3cf6c63d5070`) |
| Project | **AegisPulse** (`16d178ac-eebb-4295-9243-b52b04ff3286`) |
| Environments | **Development** (slug `dev`) → namespace `aegispulse-dev` · **Production** (slug `prod`) → namespace `aegispulse` (confirmed MB-04) |
| Admin identity | `svc_admin` (`21fca586-8772-4aff-b9d2-cc9b9c6d2c8a`), org-level machine identity. **Workstation bootstrap and rotation only.** Never deployed to the cluster, never a CI variable |
| Operator identities | `aegispulse-operator-dev`, `aegispulse-operator-prod` (to create, MB-08): one per environment, read-only to that environment only |
| Kubernetes Operator | Installed 2026-11-23 (MB-05): Helm chart `infisical-helm-charts/secrets-operator` **0.11.18**, release `infisical-operator` in namespace `infisical-operator`, image `infisical/kubernetes-operator:v0.11.18` |
| Local development | **Not in Infisical.** `make env` generates a throwaway `.env` (`scripts/dev/gen-local-secrets.sh`). Local never shares a value with dev or prod (NFR-06) |

## Layout inside each environment
Every runtime and data store has a folder. The authoritative list of keys, generators and consumers is [`deploy/infisical/secrets-catalog.yaml`](../../deploy/infisical/secrets-catalog.yaml). Phase 9 turns it into one `InfisicalSecret` CR per component, giving `aegispulse-{component}-secrets`.

- Data-store folders (`/postgres`, `/mongo`, `/redis`, `/rabbitmq`, `/objectstore`) **own** the generated passwords.
- Runtime folders (`/files`, `/registry`, …) hold their own secrets plus **connection URLs composed with Infisical secret references** to the owning data-store folder. Each password then exists exactly once and rotates in one place. Phase 9 confirms the exact reference syntax against the running version.
- External values (`/observability` OTLP token, `/sensitivity-scanner` LLM key, `/orchestrator` ntfy token) are entered by their owner, never generated.

## MB-03 — Infisical CLI + `svc_admin` login (workstation)
1. Install the CLI: `brew install infisical/get-cli/infisical`.
2. In the Infisical UI → Organization → Access Control → Identities → `svc_admin` → **Universal Auth**, create a client secret. Give it a short TTL (for example 30 days) and, if possible, a trusted-IP restriction to the tailnet.
3. In **your own terminal**, never in an AI prompt:
   ```bash
   export INFISICAL_DOMAIN=https://infisical.rmwhs.com/api   # CLI 0.45.x reads INFISICAL_DOMAIN
   export INFISICAL_TOKEN="$(infisical login --method=universal-auth \
     --client-id=<svc_admin client id> --client-secret=<client secret> --plain --silent)"
   ```
   The token lives only in that shell, so commands run there act as `svc_admin`.
- **Report back:** "MB-03 done" and `infisical --version`.
- **Verify** (read-only, run by the operator): `infisical secrets folders get --projectId 16d178ac-eebb-4295-9243-b52b04ff3286 --env dev --path /` succeeds.

## MB-04 — Environment slugs and `svc_admin` scope
1. In Project Settings → Environments, read the **slug** of Development and of Production.
2. Least privilege for `svc_admin`: it is an org-level identity. Prefer org role **No Access**/**Member**, and add it to project AegisPulse with role **Admin**, so it can manage this project's secrets and identities without org-wide powers. If the org role must stay higher for other projects, record that here as an accepted risk.
- **Report back:** both slugs (for example `dev`, `prod`), and svc_admin's org role and project role (names only).

## Accepted risk: `svc_admin` keeps org-level Admin (homelab simplification, MB-04)
For simplicity in a single-operator homelab, `svc_admin` keeps its **org-level Admin** role. That gives it full control of every project in the HomeLab org, not only AegisPulse. Mitigations:
- it is used only from the operator's workstation, never in the cluster or CI;
- its client secrets are short-lived and are revoked after an accidental exposure.

**In a production/enterprise environment** this would be replaced by least-privilege controls:
- no org-admin machine identity for routine work; a project-scoped identity holding **Admin on AegisPulse only**, and separate identities for seeding vs. rotation if duties are split;
- client secrets with short TTL, max-use limits and trusted-IP (tailnet/VPN) restrictions;
- break-glass org admin held by humans behind SSO + MFA, with Infisical audit logs exported to the SIEM and access reviews.

## MB-05 — Install the Infisical Kubernetes Operator (cluster-admin)
The operator is cluster-wide (CRDs plus a controller), so it needs cluster-admin. The agent does not hold that.
```bash
helm repo add infisical-helm-charts https://dl.cloudsmith.io/public/infisical/helm-charts/helm/charts/
helm repo update
helm search repo infisical-helm-charts/secrets-operator --versions | head -3   # pick the newest version >= 1 week old
helm upgrade --install infisical-operator infisical-helm-charts/secrets-operator \
  --namespace infisical-operator --create-namespace --version <pinned version>
```
- **Report back:** "MB-05 done" and the chart version. Record it in `docs/steering/tech.md`.
- **Verify** (agent, read-only): `kubectl get crd | grep secrets.infisical.com` lists `infisicalsecrets`, and `kubectl -n infisical-operator get deploy` is Available.

## MB-06 — Seed folders and generated secrets (operator runs `scripts/infisical/seed.py`)
The seeder reads `deploy/infisical/secrets-catalog.yaml`, creates folders, and **generates only missing keys**. It never overwrites, never prints a value, and never passes a value on a command line (values go through a 0600 temp file that is deleted immediately).
- `reference` keys (connection URLs) are deferred to Phase 9, which defines the in-cluster hostnames.
- `external` keys are listed for their owners to enter.

In the MB-03 shell (`INFISICAL_TOKEN` and `INFISICAL_DOMAIN` exported):
```bash
uv run python -I scripts/infisical/seed.py --env dev --dry-run    # review: names and counts only
uv run python -I scripts/infisical/seed.py --env dev
uv run python -I scripts/infisical/seed.py --env prod --dry-run
uv run python -I scripts/infisical/seed.py --env prod             # asks you to type 'prod'
```
- **Report back:** the final summary line of each run, for example `seed[dev]: 0 present, generated 62, deferred 41 (values never printed)`. Also report any error text, which names folders and keys only.
- **Verify:** re-running the dry run reports `would generate 0`.

## MB-08 — Operator identities (after MB-05 and MB-07)
For each environment `E` in {dev, prod}, with namespace `N` = `aegispulse-dev` or `aegispulse`:
1. Create the identity `aegispulse-operator-E` (Organization → Identities), org role **No Access**. Add it to project AegisPulse with a custom role **read secrets in environment E only** (no write, no other environment).
2. Auth method, **recommended: Kubernetes Auth.** There is no static credential to store: the operator presents its ServiceAccount token, and Infisical validates it through the cluster's TokenReview API. Settings:
   - Kubernetes host `https://kubernetes.default.svc`;
   - allowed service accounts `N:infisical-operator`;
   - a token-reviewer ServiceAccount with `system:auth-delegator` (manifest provided by the agent in Phase 9).

   **Fallback: Universal Auth.** Its client secret is created by the admin straight into a Kubernetes Secret in `N`, never through the agent.
- **Report back:** the identity names, the auth method chosen, and the identity IDs (IDs are not secrets).
- **Verify** (agent, Phase 9): an `InfisicalSecret` in `aegispulse-dev` syncs `aegispulse-gateway-secrets` and reports `Ready`. A dev identity cannot read a prod secret (negative test, NFR-06).

## Rotation (Phase 9 runbook expands this)
- Generated passwords are rotated by re-running the seeder with `--rotate <folder>/<key>`, then restarting consumers. The operator resyncs Secrets.
- JWT signing keys use dual-key rotation (FR-AUTH-05: current + previous).
- The webhook KEK is versioned (`INGESTION_KEK_VERSION`).
