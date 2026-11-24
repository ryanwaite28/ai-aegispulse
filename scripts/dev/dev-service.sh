#!/usr/bin/env bash
# make dev SERVICE=<name> (PROJECT.md §4.5): run one service natively with hot reload against the compose stack.
# The resolved compose definition (with secrets) is piped straight into the helper; nothing is printed or written.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
docker compose --env-file .env -f deploy/compose/docker-compose.yml config --format json | python3 -I scripts/dev/dev_service.py "${1:-}"
