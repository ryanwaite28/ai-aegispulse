#!/usr/bin/env bash
# Builds every application image through compose (same Dockerfiles and args as `make up`) and enforces the
# compressed 95 MB layer cap (NFR-15).
set -euo pipefail
cd "$(dirname "$0")/../.."
compose=(docker compose --env-file .env -f deploy/compose/docker-compose.yml)
GIT_SHA="$(git rev-parse --short HEAD)"
export GIT_SHA
"${compose[@]}" build
images=()
while IFS= read -r image; do images+=("$image"); done < <("${compose[@]}" config --images | grep "^aegispulse-" | sort -u)
ci/check-layer-sizes.sh "${images[@]}"
