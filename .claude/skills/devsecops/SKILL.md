---
name: devsecops
description: AegisPulse DevSecOps role. Use for GitLab CI/CD pipeline work, ci/*.sh scripts, image builds (kaniko), security gates (Gitleaks, GitLab SAST/Secret Detection/Dependency/IaC/Container scanning, SonarQube, Trivy, Syft SBOM, cosign, OWASP ZAP), deploy/rollback scripts, and Infisical/GitLab secret handling.
---

# DevSecOps Engineer — AegisPulse

Source of truth: `PROJECT.md` §9 (pipeline, deploy, bootstrap), §3 NFR-08/NFR-17, ADR-0007, ADR-0012, and cluster rules in `docs/K3S_CONTEXT.md`.

## Pipeline rules
- `.gitlab-ci.yml` stays declarative. Logic goes in `ci/{verb}-{thing}.sh` (shellcheck clean, `set -euo pipefail`), runnable locally.
- Stages: `.pre → lint → test → contract → build → scan → sign → deploy → verify → release` (§9.2).
- MR pipelines never deploy. `main` auto-deploys to **dev** (`aegispulse-dev`, `*.rmwhs-dev.space`) and runs dev verification. `deploy:prod` (protected environment, manual) or a `v*` tag promotes the **same digests** to **prod** (`aegispulse`, `*.rmwhs.com`). Nothing is rebuilt (ADR-0014).
- Use per-runtime `rules:changes`. Cache the pnpm store, Gradle, and uv.
- The runner uses tags `default`, `generic` and the kubernetes executor. Never use privileged mode or DinD.

## Build
- kaniko (`gcr.io/kaniko-project/executor:debug`) with `--cache=true`, destination `$CI_REGISTRY_IMAGE/<image>:$CI_COMMIT_SHORT_SHA`, and the digest written to an artifact.
- Multi-stage Dockerfiles. Distroless or slim bases pinned by digest. Non-root UID. `readOnlyRootFilesystem`-compatible.
- **Every layer must be under 95 MB** (Cloudflare 100 MB cap): `ci/check-layer-sizes.sh`.

## Security gates (fail conditions)
| Gate | Tool | Fails on |
|---|---|---|
| Secrets | Gitleaks (pre-commit + CI) + GitLab Secret Detection | any finding outside `tests/fixtures/secrets-synthetic/` |
| SAST | GitLab SAST (Semgrep) + SonarQube | new Critical/High; Sonar gate failure |
| Quality | SonarQube | coverage < 75% overall or < 85% service/domain; new blocker/critical |
| Dependencies | GitLab Dependency Scanning | Critical/High with a fix available |
| IaC | GitLab IaC SAST (KICS) + `trivy config` + kubeconform | High misconfig (root, privileged, no limits, hostPath) |
| Images | Trivy + GitLab Container Scanning | Critical/High fixable |
| SBOM | Syft CycloneDX | missing SBOM attestation |
| Signing | cosign key pair | unsigned or unverifiable digest at deploy |
| DAST | ZAP baseline (console) + active API scan (`/v1/openapi.json`) against **dev only**; passive baseline on prod | any High |

Exceptions (`.trivyignore`, ZAP rules) need an expiry date and a reason, and `ci/check-exceptions.sh` enforces this.

## Deploy (`ci/deploy.sh`, §9.2)
Target env resolved (`dev` or `prod`) → that namespace's scoped SA token (`AEGIS_DEPLOY_SA_TOKEN_DEV` / `_PROD`, the latter scoped to the protected `prod` environment; never the runner SA or cluster-admin) → for prod, check that `deploy/releases/dev/{sha}.json` is marked verified → cosign verify → set image digests in the overlay → apply InfisicalSecret CRs → topology Job → migration Jobs (wait for complete) → `kubectl apply -k` → rollout status → automatic rollback of Deployments on failure → write `deploy/releases/{sha}.json`.

## Secrets
- Runtime: Infisical Operator → `aegispulse-{component}-secrets`, referenced only via `secretKeyRef`. Project AegisPulse (org HomeLab), envs Development/Production; keys in `deploy/infisical/secrets-catalog.yaml`; setup steps are 🛑 MANUAL (MB-03…MB-08) in `docs/runbooks/manual-bootstrap.md`. Stop and direct the operator when one is open. Never request, print, or store a secret value; `svc_admin` stays on the operator's workstation.
- Pipeline: GitLab Protected + Masked variables (§9.2 list).
- Never echo secrets, enable `set -x` around them, or write them to artifacts.
- Rotation runbooks are in `docs/runbooks/key-rotation.md`. Practice the drills.

## Cluster lessons to apply (K3S_CONTEXT §3–§5)
Read config files back before applying. Use `helm upgrade`, not a second `install`, for third-party charts. `kubectl describe` anything Pending. Verify inside the cluster, not just at the API. Fix body-size and timeout limits at every proxy hop. Always use `KUBECONFIG=~/.kube/config` explicitly.

## Evidence
Every gate's report is a pipeline artifact. Link them in `docs/evidence/phase-10.md` and later phases.
