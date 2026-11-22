# ADR-0014 — Dev and prod environments on one cluster, separated by domain

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Ryan M. Waite
- **PROJECT.md sections affected:** §1.5, §3 (NFR-03, NFR-05, NFR-06, NFR-18), §4.3, §5.1, §5.3, §5.4, §5.6, §5.7, §5.9, §8.1, §9.1–§9.3, §9.5–§9.7, §10.4, §11 (gate, Phase 9, 18, 19, 20), §12, §13, §14, Appendix A17
- **Related:** ADR-0006 (homelab k3s), ADR-0007 (supply chain), ADR-0010 (JWT), ADR-0012 (secrets)

## Context
v1.0 had one cluster environment (`homelab`), so every main-branch commit deployed straight to the public portfolio deployment, and active DAST and chaos tests ran against it. A second domain, **`rmwhs-dev.space`**, already routes through the **same Cloudflare tunnel** to the same k3s cluster as `rmwhs.com`. That makes a separate dev environment possible at almost no cost.

## Decision
- Three environments: `local` (Compose), **`dev`** (namespace `aegispulse-dev`, hosts `aegispulse[-api|-objects].rmwhs-dev.space`), and **`prod`** (namespace `aegispulse`, hosts `aegispulse[-api|-objects].rmwhs.com`).
- **Share nothing above the platform layer.** Each environment has its own namespace, its own datastore StatefulSets, its own Infisical environment, RabbitMQ vhost (`aegispulse-dev` / `aegispulse-prod`), buckets, JWT signing keys and audience, webhook KEK, OpenObserve streams, ntfy topic, and CI deployer ServiceAccount. NetworkPolicies have no rules between the two namespaces. The only shared pieces are cluster-level platform services (ingress-nginx, the RabbitMQ broker process, Infisical, OpenObserve, GitLab).
- **Promotion flow.** Every `main` commit auto-deploys to dev, then dev verification runs (full smoke, active ZAP, NetworkPolicy and cross-environment isolation). A **manual, protected** `deploy:prod` (or a `v*` tag) promotes the **same digests** to prod, followed by a prod smoke test. Migrations reach prod only after running in dev.
- **Dev gets the risky work.** Active DAST, chaos, load, soak, and data resets run in dev only, never in prod.
- **Capacity.** Dev uses halved requests with prod-identical limits, its own ResourceQuota, and can be scaled to zero (nightly `env:sleep:dev`, any dev deploy wakes it).
- **Hostnames** stay one label under each domain (Cloudflare Universal SSL covers first-level subdomains). The cluster's subdomain-only rule applies to both domains.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| Two namespaces, two domains, same cluster (chosen) | real promotion gate; safe target for DAST and chaos; reuses the existing tunnel and cluster; near-zero cost | shared node capacity; broker and ingress are shared platform components |
| Single environment (v1.0) | simplest, cheapest on capacity | untested changes go straight to the public deployment; DAST and chaos run against prod |
| Ephemeral per-MR environments | strongest isolation per change | far beyond single-node capacity; slow |
| Dev sharing prod datastores (separate schemas) | saves about 1 GiB | breaks NFR-06 isolation; a dev bug could corrupt prod data |

## Consequences
- More pipeline stages and twice the bootstrap work (namespaces, SAs, Infisical environments, vhosts, Cloudflare hostnames).
- CPU requests on elitedesk-800 rise to about 2.7 vCPU while dev is awake. Phase 9 measures node allocation and puts dev to sleep by default if needed.
- `RUNTIME-VERIFIED` now means compose + dev verification + a prod smoke test after promotion.

## Verification
CI overlay check (no cross-environment hostnames, namespaces, vhosts, or buckets); cross-environment isolation test (dev pod can't reach prod; dev JWT rejected by prod); pipeline evidence that prod deploys only dev-verified digests; Phase 9 node-allocation snapshot.
