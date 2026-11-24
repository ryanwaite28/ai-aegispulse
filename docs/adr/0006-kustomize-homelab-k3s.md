# ADR-0006 — Homelab k3s with Kustomize plain manifests; AWS as reference only

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §4.2, §4.3, §5, §9
- **Related:** NFR-03, NFR-17, NFR-18

## Context
The template assumes AWS Lambda. The real target is the existing two-node homelab k3s cluster (`docs/K3S_CONTEXT.md`), whose standard prefers plain manifests over Helm for owned apps and requires GitLab CI.

## Decision
- Deploy to homelab k3s: namespace `aegispulse` (prod) and, per ADR-0014, `aegispulse-dev` (dev). Use a Kustomize `base` plus overlays `dev`, `prod`, and `k3d-local`. No Helm for owned workloads. Third-party add-ons (the Infisical Operator, Uptime Kuma) use their official charts.
- Stateful stores run as project-owned StatefulSets pinned to the storage node (`optiplex` at the time of writing; **amended by [ADR-0015](0015-node-roles-storage-on-optiplex-tower.md): now `optiplex-tower`**). We don't use Bitnami charts or operators in v1.
- Document AWS production (EKS, RDS, Atlas, Amazon MQ, ElastiCache, S3) as a reference architecture only.

## Consequences
- There is no HA, and single points of failure are accepted and documented.
- Capacity is the binding constraint, so the resource budget check is part of CI.
- Moving PVCs later requires backup and restore because `local-path` storage is bound to a node.

## Verification
`kustomize build | kubeconform`, the resource budget check, and Phase 9 runtime evidence with storage pods on `optiplex`.
