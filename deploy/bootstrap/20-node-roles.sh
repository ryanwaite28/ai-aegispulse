#!/usr/bin/env bash
# Applies the cluster node roles from ADR-0015 / PROJECT.md §9.3 step 3 (idempotent).
#   storage node : node-role.kubernetes.io/storage=true, dedicated=storage, taint dedicated=storage:NoSchedule
#   app worker   : node-role.kubernetes.io/worker=true, no taint (AegisPulse stateless pods prefer it)
# Run from an operator workstation with cluster-admin kubeconfig, AFTER 10-storage-node-disk.sh has
# succeeded on the storage node. CHECK_ONLY=1 prints the current state and changes nothing.
set -euo pipefail

STORAGE_NODE="${STORAGE_NODE:-optiplex-tower}"
WORKER_NODE="${WORKER_NODE:-optiplex}"
KUBECTL="${KUBECTL:-kubectl}"

show() {
  "$KUBECTL" get nodes -L node-role.kubernetes.io/storage,node-role.kubernetes.io/worker,dedicated
  "$KUBECTL" get nodes -o custom-columns='NAME:.metadata.name,TAINTS:.spec.taints[*].key'
}

if [[ "${CHECK_ONLY:-0}" == "1" ]]; then show; exit 0; fi

# A PV already bound to the worker node would be stranded by the role swap; refuse rather than guess.
stranded="$("$KUBECTL" get pv -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.nodeAffinity.required.nodeSelectorTerms[0].matchExpressions[0].values[0]}{"\n"}{end}' | awk -v n="$WORKER_NODE" '$2==n {print $1}')"
[[ -z "$stranded" ]] || { echo "error: PVs bound to ${WORKER_NODE}: ${stranded}" >&2; exit 1; }

# Storage role first, so there is never a moment with no tainted storage node.
"$KUBECTL" label node "$STORAGE_NODE" node-role.kubernetes.io/storage=true dedicated=storage --overwrite
"$KUBECTL" taint node "$STORAGE_NODE" dedicated=storage:NoSchedule --overwrite

"$KUBECTL" taint node "$WORKER_NODE" dedicated=storage:NoSchedule- 2>/dev/null || true
"$KUBECTL" label node "$WORKER_NODE" node-role.kubernetes.io/storage- dedicated- 2>/dev/null || true
"$KUBECTL" label node "$WORKER_NODE" node-role.kubernetes.io/worker=true --overwrite

show
