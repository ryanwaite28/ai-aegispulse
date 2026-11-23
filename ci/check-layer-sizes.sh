#!/usr/bin/env bash
# NFR-15 / CLAUDE.md: every image layer must stay under 95 MB as PUSHED, because Cloudflare caps request bodies at
# 100 MB and registry pushes upload each layer as one gzip-compressed blob. Measures each layer's compressed size
# (docker save → gzip), not the uncompressed history size, which no Node/JVM base layer could ever satisfy.
# Usage: ci/check-layer-sizes.sh image[:tag] ...
set -euo pipefail
limit=$((95 * 1000 * 1000))
if [[ $# -eq 0 ]]; then echo "check-layer-sizes: no images given; skipping"; exit 0; fi
command -v jq >/dev/null || { echo "check-layer-sizes: jq is required" >&2; exit 2; }
fail=0
for image in "$@"; do
  tmp="$(mktemp -d)"
  docker image save "$image" -o "$tmp/image.tar"
  tar -xf "$tmp/image.tar" -C "$tmp"
  largest=0
  while IFS= read -r layer; do
    size="$(gzip -6 -c "$tmp/$layer" | wc -c | tr -d ' ')"
    (( size > largest )) && largest=$size
    if (( size > limit )); then
      echo "LAYER TOO LARGE: $image: $((size / 1000000)) MB compressed — $layer"; fail=1
    fi
  done < <(jq -r '.[0].Layers[]' "$tmp/manifest.json")
  echo "check-layer-sizes: $image largest layer $((largest / 1000000)) MB compressed"
  rm -rf "$tmp"
done
[[ $fail -eq 0 ]] && echo "check-layer-sizes: OK ($# images)"
exit $fail
