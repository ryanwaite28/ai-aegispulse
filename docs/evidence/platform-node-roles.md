# Platform — Node roles (ADR-0015) — Evidence

| | |
|---|---|
| Date (UTC) | 2026-11-23 |
| Environment | homelab k3s cluster (shared by dev and prod; no AegisPulse workloads deployed yet) |
| Verified by | the operator ran the privileged steps on the node; Claude Code (Opus) verified them read-only and ran the role swap and smoke test with kubectl |
| Resulting status | PROJECT.md §11 Phase 9 "Node roles" item **RUNTIME-VERIFIED** (platform step only; workload placement is verified with the Phase 9 manifests) |

## Data SSD on `optiplex-tower` (`deploy/bootstrap/10-storage-node-disk.sh`)
The operator formatted the 1 TB SSD as whole-disk ext4 by hand and added the `/mnt/data` fstab entry. The script adopted that filesystem as-is (no format), labelled it `k3s-data`, added the bind mount, and added the `k3s-agent` dependency.
```text
/mnt/data                     /dev/sdc               ext4  938G total, 891G avail
/var/lib/rancher/k3s/storage  /dev/sdc[/k3s-storage] ext4
k3s-agent RequiresMountsFor=/var/lib/rancher/k3s/storage /mnt/data   (k3s-agent active)
findmnt --verify: 0 parse errors, 0 errors
```

## Node roles (`deploy/bootstrap/20-node-roles.sh`)
```text
NAME             ROLES           STORAGE   WORKER   DEDICATED   TAINTS
elitedesk-800    control-plane                                  <none>
optiplex         worker                    true                 <none>
optiplex-tower   storage         true               storage     dedicated=storage:NoSchedule
```

## Smoke test (storage-stanza pod + 64Mi local-path PVC, deleted afterwards)
```text
pod/storage-smoke Completed on optiplex-tower; wrote 32 MiB
PV node affinity: optiplex-tower
/mnt/data used: 2.1M → 35M during the test → 2.1M after delete (PV reclaimed)
```

## Issues found and fixed
- `findmnt -S … <target>` is an invalid flag combination, so the mount check now compares `findmnt -no UUID`.
- `add_fstab` appended to an fstab whose last line had no trailing newline and corrupted that line. The script now adds a newline first and runs `findmnt --verify` after every edit. The operator repaired the live fstab (backup kept as `/etc/fstab.bak-*`).
- The script now adopts an existing whole-disk ext4 (relabels only) instead of offering to wipe it.

## Still open (K3S_CONTEXT §8)
- k3s version skew: agents v1.37 against a v1.36 server. Upgrade the server first.
- The API server certificate lacks the Tailscale address, so remote kubectl needs `--tls-server-name` until `tls-san` is added.
