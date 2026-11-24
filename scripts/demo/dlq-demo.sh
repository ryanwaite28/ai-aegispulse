#!/usr/bin/env bash
# make demo-dlq: Phase 7 exit demo (FR-MSG-01..03). Stops ClamAV so files validation fails TRANSIENT, shows the
# 1 s → 5 s → 30 s retries and the dead-letter registry entry, restarts ClamAV, replays through the admin API and
# waits for VALIDATED. The platform admin password is handed from the local .env to the demo process and never printed.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
if [[ -z "${SEED_PA_PASSWORD:-}" ]]; then
  SEED_PA_PASSWORD="$(sed -n 's/^PLATFORM_ADMIN_BOOTSTRAP_PASSWORD=//p' "$root/.env" | tail -n 1)"
fi
export SEED_PA_PASSWORD
cd "$root"
# Whatever happens, leave ClamAV running.
trap 'docker compose --env-file .env -f deploy/compose/docker-compose.yml up -d clamav >/dev/null 2>&1 || true' EXIT
exec node "$root/scripts/demo/dlq-demo.mts"
