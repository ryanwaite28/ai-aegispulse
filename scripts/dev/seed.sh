#!/usr/bin/env bash
# make seed: demo data through the gateway as the bootstrap PLATFORM_ADMIN (PROJECT.md §1.4.7). The password is handed
# from the local .env to the seed process's environment and never printed; in CI/dev it comes from a masked variable.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -z "${SEED_PA_PASSWORD:-}" ]]; then
  SEED_PA_PASSWORD="$(sed -n 's/^PLATFORM_ADMIN_BOOTSTRAP_PASSWORD=//p' "$root/.env" | tail -n 1)"
fi
export SEED_PA_PASSWORD
exec node "$root/scripts/dev/seed.mts"
