#!/usr/bin/env bash
# NFR-03 / NFR-15: every container declares requests+limits, and namespace request totals stay within budget.
# Usage: ci/check-resource-budget.sh [overlay-dir...]   (default: deploy/k8s/overlays/{dev,prod} if present)
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
overlays=("$@")
if [[ ${#overlays[@]} -eq 0 ]]; then
  for env in dev prod; do [[ -d "$root/deploy/k8s/overlays/$env" ]] && overlays+=("$root/deploy/k8s/overlays/$env"); done
fi
if [[ ${#overlays[@]} -eq 0 ]]; then echo "check-resource-budget: no overlays yet (Phase 9); skipping"; exit 0; fi
fail=0
for overlay in "${overlays[@]}"; do
  env="$(basename "$overlay")"
  if [[ -f "$overlay/kustomization.yaml" ]]; then rendered="$(kubectl kustomize "$overlay")"; else rendered="$(cat "$overlay"/*.yaml)"; fi
  printf '%s' "$rendered" | uv run -q --no-project --with pyyaml==6.0.4 python "$root/ci/lib/resource_budget.py" --env "$env" || fail=1
done
exit $fail
