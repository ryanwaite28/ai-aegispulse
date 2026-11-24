#!/usr/bin/env bash
# Waits for the local stack: long-running services healthy, one-shot init jobs exited 0 (NFR-11 local parity).
# `docker compose up --wait` treats successful one-shot exits as failures, hence this script.
# Application runtimes (Phase 1e) are probed from the host on 127.0.0.1:<port>: WAIT_PROBE=livez (default, `make up`:
# processes are up) or WAIT_PROBE=readyz (`make migrate`: each runtime's own dependencies, schema and topology OK).
set -euo pipefail
compose=(docker compose --env-file .env -f deploy/compose/docker-compose.yml)
oneshots=" config-render rabbitmq-init objectstore-init "
probe="${WAIT_PROBE:-livez}"
# runtime:host-port (§5.4; the console's 8080 is published on 8091 because the gateway owns 8080)
apps=(gateway:8080 ingestion:8081 files:8082 events:8083 registry:8084 cases:8085 risk-scoring:8086
  sensitivity-scanner:8087 doc-extraction:8088 data-intel:8089 orchestrator:8090 console:8091)
deadline=$(( $(date +%s) + ${WAIT_TIMEOUT:-300} ))
# A never-migrated stack (after `make reset`) has no broker topology and no schemas: runtimes retry for ≤ 60 s and
# restart until `make migrate` creates them (NFR-11), so `make up` waits for infrastructure + init jobs only and
# `make migrate` (WAIT_PROBE=readyz) is the readiness gate. Detected by the topology's first exchange.
fresh=0
topology_present() {
  "${compose[@]}" exec -T rabbitmq rabbitmqctl -q -p aegispulse-local list_exchanges name 2>/dev/null | grep -qx 'aegispulse.ingress'
}
while :; do
  pending=(); failed=(); app_pending=()
  while IFS='|' read -r svc state health exitcode; do
    if [[ "$oneshots" == *" $svc "* ]]; then
      if [[ "$state" == "exited" ]]; then [[ "$exitcode" == "0" ]] || failed+=("$svc(exit $exitcode)"); else pending+=("$svc"); fi
    elif [[ " ${apps[*]} " == *" $svc:"* ]]; then
      [[ "$state" == "running" && ( "$health" == "healthy" || -z "$health" ) ]] || app_pending+=("$svc:${health:-$state}")
    else
      [[ "$state" == "running" && ( "$health" == "healthy" || -z "$health" ) ]] || pending+=("$svc:${health:-$state}")
    fi
  done < <("${compose[@]}" ps -a --format json | jq -r '[.Service, .State, (.Health // ""), (.ExitCode | tostring)] | join("|")')
  if (( ${#failed[@]} )); then echo "compose-wait: FAILED ${failed[*]}" >&2; exit 1; fi
  if ! curl -sf -m 3 -o /dev/null http://localhost:5080/healthz; then pending+=("openobserve:http"); fi
  if [[ "$probe" == "livez" ]] && (( ${#pending[@]} == 0 )) && ! topology_present; then fresh=1; fi
  if (( fresh )); then
    echo "compose-wait: infrastructure healthy and init jobs completed; fresh stack (no broker topology yet):"
    echo "compose-wait: runtimes restart until 'make migrate' creates schemas + topology; make migrate then waits for /readyz"
    exit 0
  fi
  pending+=(${app_pending[@]+"${app_pending[@]}"})
  for app in "${apps[@]}"; do
    curl -sf -m 3 -o /dev/null "http://127.0.0.1:${app#*:}/${probe}" || pending+=("${app%%:*}:${probe}")
  done
  if (( ${#pending[@]} == 0 )); then echo "compose-wait: all services healthy, init jobs completed, ${#apps[@]} runtimes pass /${probe}"; exit 0; fi
  if (( $(date +%s) > deadline )); then echo "compose-wait: timeout waiting for ${pending[*]}" >&2; exit 1; fi
  echo "compose-wait: waiting for ${pending[*]}"
  sleep 5
done
