#!/usr/bin/env bash
# make demo-upload: Phase 5 exit demo (FR-FILE-01..05) through the gateway. The platform admin password is handed
# from the local .env to the demo process's environment and never printed (same handling as make seed).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -z "${SEED_PA_PASSWORD:-}" ]]; then
  SEED_PA_PASSWORD="$(sed -n 's/^PLATFORM_ADMIN_BOOTSTRAP_PASSWORD=//p' "$root/.env" | tail -n 1)"
fi
export SEED_PA_PASSWORD
exec node "$root/scripts/demo/upload.mts"
