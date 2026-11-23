---
name: kubernetes-platform
description: AegisPulse Kubernetes/platform role for the homelab k3s cluster. Use when writing or reviewing deploy/k8s Kustomize manifests (Deployments, StatefulSets, CronJobs, Jobs, Services, Ingresses, NetworkPolicies, quotas), storage-node placement, ingress-nginx/Cloudflare settings, Infisical Operator CRs, bootstrap scripts, k3d local parity, or the AWS reference architecture.
---

# Kubernetes Platform Engineer — AegisPulse

Source of truth: `PROJECT.md` §4.3, §5 (all), §9.2–§9.4, ADR-0006, and **`docs/K3S_CONTEXT.md` (cluster hard requirements are binding)**.

## Cluster hard requirements (never violate)
- Namespaces `aegispulse` (prod) and `aegispulse-dev` (dev) only (ADR-0014). Ingress `ingressClassName: nginx-external`, subdomains `aegispulse`, `aegispulse-api`, and `aegispulse-objects` under `rmwhs.com` (prod) or `rmwhs-dev.space` (dev), one label deep, no apex, `nginx.ingress.kubernetes.io/ssl-redirect: "false"`, and no cert-manager annotations (TLS terminates at Cloudflare).
- Images come from `$CI_REGISTRY_IMAGE` and are referenced by **digest** in overlays. Never use `:latest`.
- `resources.requests` **and** `limits` for CPU and memory on every container, init container, Job, and CronJob.
- No `privileged`, no hostPath, no hostNetwork. Pod security: `runAsNonRoot`, `readOnlyRootFilesystem`, drop ALL capabilities, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `automountServiceAccountToken: false`.
- Node roles (ADR-0015): `optiplex-tower` = storage (taint `dedicated=storage:NoSchedule`, 1 TB SSD behind the local-path directory); `optiplex` = app-compute worker (`node-role.kubernetes.io/worker=true`); `elitedesk-800` = control plane + GitLab/CI + shared platform, spill-over only.
- Stateful stores (postgres, mongo, redis, objectstore) carry **both** the `nodeSelector: {dedicated: storage}` and the toleration `dedicated=storage:NoSchedule`, **set before the first apply**. Stateless workloads carry neither and carry a *preferred* (weight 100) node affinity for `node-role.kubernetes.io/worker=true`. A non-storage workload that owns a PVC (ClamAV) uses a *required* worker affinity so the PVC binds deterministically.
- `local-path` storage is RWO, `WaitForFirstConsumer`, and node-bound forever. Request PVCs only where data must persist.
- CI deploys with `aegispulse-ci-deployer` (namespace Role). Never with cluster-admin or the runner SA. That Role can't read Secrets.

## Layout
```
deploy/k8s/base/
  namespace/ (namespace, ResourceQuota, LimitRange, default-deny netpol)
  {component}/ (deployment|statefulset, service, configmap, netpol, serviceaccount, infisicalsecret, pdb?)
  cronjobs/ · jobs/ (topology, migrate-*, seed) · ingress/
deploy/k8s/overlays/prod/      # ns aegispulse, *.rmwhs.com, full requests, gateway ×2, digests
deploy/k8s/overlays/dev/       # ns aegispulse-dev, *.rmwhs-dev.space, halved requests (same limits), dev quota
deploy/k8s/overlays/k3d-local/ # local parity (no storage taint, smaller PVCs)
deploy/bootstrap/              # one-time idempotent platform scripts (§9.3): 10-storage-node-disk.sh (runs on the node), 20-node-roles.sh, …
```
Use labels and annotations from §5.2. Names follow §5.1.

## Ingress specifics
- API: `limit-rps: "20"`, `limit-burst-multiplier: "3"`, `proxy-body-size: "2m"`. SSE paths: `proxy-buffering: "off"`, `proxy-read-timeout: "3600"`.
- Objects: `proxy-body-size: "100m"`, `proxy-request-buffering: "off"` (the Cloudflare cap is 100 MB per request).
- Before relying on DNS, verify in-cluster with `kubectl exec … curl -H "Host: aegispulse-api.rmwhs.com" http://ingress-nginx-controller…/livez`.

## NetworkPolicies (§5.7.5)
Identical policy sets per namespace with no rules between `aegispulse-dev` and `aegispulse`. Default-deny ingress and egress. Allow DNS. Allow ingress-nginx → gateway, console, and objectstore. Allow callers → services per the §5.7.4 matrix. Allow owners → datastores. Allow messaging services → `rabbitmq` namespace :5672. Allow all → `openobserve` OTLP. Allow ingestion and files → 0.0.0.0/0:443 (SSRF guard in code). Allow orchestrator → ntfy. k3s enforces NetworkPolicy through its embedded controller, so verify with `tests/security/netpol.sh`.

## Jobs & ordering
Topology Job → migration Jobs (Flyway per schema, migrate-mongo) → Deployments. Job names include the short SHA, and `ttlSecondsAfterFinished: 86400`. `backoffLimit: 1` for migrations, so they fail loudly.

## Validation before any apply
`kustomize build deploy/k8s/overlays/{dev,prod} | kubeconform -strict -summary` → cross-env reference check (no prod hosts, namespace, vhost, or buckets in dev, and the reverse) → `trivy config` → `ci/check-resource-budget.sh` → **read the rendered YAML back** (cluster lesson §3.1). Use `kubectl diff -k` before `apply`.

## Troubleshooting access (awareness only, never record credentials)
- `kubectl` from the operator workstation uses `KUBECONFIG=~/.kube/config` over the Tailscale tailnet. If it fails with `x509 … not <tailnet address>`, pass `--tls-server-name=<an address the cert lists>`. Never use `--insecure-skip-tls-verify`. The permanent fix (`tls-san`) is tracked in K3S_CONTEXT §8.
- SSH: the operator's `~/.ssh/config` has per-node aliases, with `--vpn` variants over Tailscale (for example `elitedesk--vpn`, `optiplex-tower--vpn`). Use the alias names. Never copy hostnames, IPs, users, or keys into the repo, docs, comments, or session notes.
- `sudo` on the nodes prompts for a password. Run read-only diagnostics yourself (`lsblk`, `findmnt`, `df`, `systemctl status`, `kubectl describe`). Hand privileged or destructive commands to the operator, preferably as an idempotent `deploy/bootstrap/*.sh` script copied to the node and run with `ssh -t <alias> sudo bash <script>`.
- Prefer the Kubernetes API. Go to the host only for disks, mounts, the k3s service, and the kernel. Node-level checks: `CHECK_ONLY=1 deploy/bootstrap/20-node-roles.sh`, and `findmnt /mnt/data /var/lib/rancher/k3s/storage` on the storage node.
- Never point chaos, reset, or load tooling at prod (namespace `aegispulse`) while troubleshooting.

## Reference production
Keep the `PROJECT.md` §5.8 mapping current when platform decisions change. `infra/terraform/aws-reference/` is documentation-grade and never applied by CI.
