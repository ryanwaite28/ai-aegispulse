# ADR-0015 — Node roles: data stores on `optiplex-tower`, app compute on `optiplex`

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Ryan M. Waite
- **PROJECT.md sections affected:** §1.5, §3 (NFR-03, NFR-12), §4.3, §5.3, §5.4, §9.3, §11 (Phase 9), §13.1, Appendix A18
- **Related:** ADR-0006 (Kustomize on homelab k3s; amended by this ADR), ADR-0011 (object store), ADR-0014 (dev/prod capacity watch)

## Context
Until now the cluster had two nodes. `elitedesk-800` (4 vCPU / 24 GiB) is the control plane and also runs GitLab, the CI runner, ingress, monitoring, Infisical, RabbitMQ, and OpenObserve. `optiplex` (4 vCPU / 15 GiB, ~100 GB OS disk) is tainted `dedicated=storage` for data stores. No AegisPulse data store had been deployed yet, so **no PV is bound to `optiplex`** (verified 2026-11-22: all nine cluster PVs are on `elitedesk-800`).

A third node joined: **`optiplex-tower`** (8 vCPU / ~30 GiB, Ubuntu 26.04.1, k3s agent). It has a 256 GB OS disk and a **dedicated 1 TB SATA SSD for application data**. It also has an unrelated legacy NTFS disk, which is out of scope and never used.

Forces:
- `local-path` PVs are RWO and bound to one node forever (K3S_CONTEXT §3.6). Data must live where the disk is, and only `optiplex-tower` has a large disk set aside for it.
- PostgreSQL, MongoDB (WiredTiger cache), and SeaweedFS turn spare RAM into page cache. The node with the most RAM serves them best.
- ADR-0014's capacity watch: prod plus awake dev comes to about 2.7 vCPU of requests on `elitedesk-800`, which already carries GitLab and CI. App compute is the cluster's tightest resource.
- Data stores and app pods should not compete for memory or disk I/O on one node. A memory-hungry app pod must never push a database out.

## Decision
We will:
1. **Make `optiplex-tower` the storage node.** It gets the labels `node-role.kubernetes.io/storage=true` and `dedicated=storage`, and the taint `dedicated=storage:NoSchedule`.
   - The 1 TB SSD is formatted ext4 with the label `k3s-data` and mounted at `/mnt/data`.
   - `/mnt/data/k3s-storage` is bind-mounted over the default local-path directory, `/var/lib/rancher/k3s/storage`. Every local-path PV on that node therefore lands on the SSD, without changing the k3s-managed `local-path-config`, which k3s re-applies on restart.
   - `k3s-agent` gets `RequiresMountsFor=` on both paths. If the SSD is missing, the node goes NotReady instead of writing database files to the OS disk.
   - This is scripted in `deploy/bootstrap/10-storage-node-disk.sh`.
2. **Re-role `optiplex` as an app-compute worker.** Remove its storage taint and labels, and add `node-role.kubernetes.io/worker=true`. This is scripted in `deploy/bootstrap/20-node-roles.sh`, which refuses to run if any PV is bound to `optiplex`.
3. **Leave the manifests' storage selector unchanged.** Data-store StatefulSets keep `nodeSelector: {dedicated: storage}` and the matching toleration. Only the node carrying the label changes, so `ci/check-resource-budget.sh` and `deploy/k8s` need no edits.
4. **Steer stateless workloads to the worker.** AegisPulse stateless workloads (Deployments, CronJobs, Jobs) carry a *preferred* node affinity (weight 100) for `node-role.kubernetes.io/worker=true`.
   - They fill `optiplex` first and spill onto `elitedesk-800` only when it is full.
   - The ClamAV Deployment, whose 2 Gi signature PVC binds where it first lands, carries a *required* affinity for the worker, so its PVC binding is deterministic.
5. **Use tiers, not hostnames, in the §5.4 / NFR-03 budgets.** The compute tier is `elitedesk-800` + `optiplex` (8 vCPU), and the storage tier is `optiplex-tower`. The budget numbers do not change; Phase 9 measurements may revise them with evidence.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| A (chosen): tower = dedicated storage; optiplex = app worker | Data sits where the disk and RAM are. Hard isolation between DB I/O and memory and app pods. App compute grows by 4 vCPU and gets off the control-plane node. No manifest changes, because the selector is the same label. | About 6 vCPU on the tower stay idle for AegisPulse. Accepted: the cluster can later move shared stateful services such as RabbitMQ and OpenObserve there (K3S_CONTEXT §8). |
| B: tower = storage **and** general compute (no taint) | Uses all 8 vCPU | App pods compete with databases for page cache and disk I/O, and an OOM on that node can take a database with it. This loses the isolation the manifests already encode. |
| C: keep `optiplex` as storage and use the tower for compute | Nothing to relabel | Data on a ~100 GB OS disk while the 1 TB SSD sits unused. The databases get the smaller-RAM node. |
| D: Longhorn or another replicated storage system across nodes | Volumes are no longer node-bound | Needs replicas on several disks of similar size (only one large data disk exists). Adds a resource-hungry storage control plane. The ADR-0006 constraints ruled out in-cluster operators for v1. |

## Consequences
- Positive:
  - Data stores get 1 TB of SSD and ~30 GiB of node RAM.
  - App pods leave the control-plane/GitLab node first, which relieves the ADR-0014 capacity watch.
  - A data-disk failure takes the node NotReady loudly, rather than causing silent data divergence on the OS disk.
- Negative / accepted risks:
  - There is still no HA. The storage node is a single point of failure for every AegisPulse data store (NFR-12 off-node backups cover it).
  - About 6 vCPU of the tower stay unused by AegisPulse.
  - The worker node is new, so dev and prod stateless pods can now land on two nodes. Operators must read `-o wide` output per node.
- Follow-up work (with phase):
  - Run `10-storage-node-disk.sh` on the tower and `20-node-roles.sh` from the workstation. This is a one-time platform step, recorded in Phase 9 evidence.
  - Phase 9 manifests: the preferred worker affinity on stateless workloads, the required affinity on ClamAV, and a pod-placement assertion in the evidence (data stores on `optiplex-tower`, nothing stateless there).
  - Cluster (outside AegisPulse): the k3s version skew. The agents run v1.37 against a v1.36 server, which is outside the Kubernetes skew policy; upgrade the server first. There is also the API server certificate missing the Tailscale address. Both are tracked in K3S_CONTEXT §8.

## Verification
- `CHECK_ONLY=1 deploy/bootstrap/20-node-roles.sh` shows the storage labels and taint on `optiplex-tower` only.
- On the tower, `findmnt /mnt/data` and `findmnt /var/lib/rancher/k3s/storage` both resolve to the `k3s-data` filesystem.
- Phase 9 exit evidence: `kubectl get pods -o wide` in both namespaces shows postgres, mongo, redis, and objectstore on `optiplex-tower`, and stateless pods on `optiplex` (spilling to `elitedesk-800` only under pressure). Each storage PV's node affinity is `optiplex-tower`, and its path is on the SSD.
