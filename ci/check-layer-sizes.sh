#!/usr/bin/env bash
# NFR-15: every image layer must be < 95 MB (Cloudflare 100 MB request cap on registry pushes).
# Usage: ci/check-layer-sizes.sh <image> [<image>...]   (no args: nothing to check yet)
set -euo pipefail
limit=$((95 * 1000 * 1000))
if [[ $# -eq 0 ]]; then echo "check-layer-sizes: no images given (images are built from Phase 1); skipping"; exit 0; fi
fail=0
for image in "$@"; do
  while IFS=$'\t' read -r size created_by; do
    if (( size > limit )); then
      echo "LAYER TOO LARGE: $image: $((size / 1000000)) MB — ${created_by:0:100}"; fail=1
    fi
  done < <(docker image history --no-trunc --human=false --format '{{.Size}}\t{{.CreatedBy}}' "$image")
done
[[ $fail -eq 0 ]] && echo "check-layer-sizes: OK ($# images)"
exit $fail
