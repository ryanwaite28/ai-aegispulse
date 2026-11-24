#!/usr/bin/env bash
# E2E + security suites against the running compose stack (PROJECT.md §14). The harness logs in as the bootstrap
# PLATFORM_ADMIN (FR-TEN-09): its password is handed to the test process from the local .env and never printed.
# In CI the same variable comes from a masked CI variable instead. Requires `make up` (+ registry-bootstrap once).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -z "${E2E_PA_PASSWORD:-}" ]]; then
  [[ -f "$root/.env" ]] || { echo "test-e2e: .env missing; run make env" >&2; exit 2; }
  E2E_PA_PASSWORD="$(sed -n 's/^PLATFORM_ADMIN_BOOTSTRAP_PASSWORD=//p' "$root/.env" | tail -n 1)"
  [[ -n "$E2E_PA_PASSWORD" ]] || { echo "test-e2e: PLATFORM_ADMIN_BOOTSTRAP_PASSWORD missing; run scripts/dev/ensure-local-vars.sh" >&2; exit 2; }
fi
export E2E_PA_PASSWORD
cd "$root" && pnpm --filter @aegispulse/system-tests run test:e2e
