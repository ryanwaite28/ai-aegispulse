#!/usr/bin/env bash
# Waits for the local stack: long-running services healthy, one-shot init jobs exited 0 (NFR-11 local parity).
# `docker compose up --wait` treats successful one-shot exits as failures, hence this script.
set -euo pipefail
compose=(docker compose --env-file .env -f deploy/compose/docker-compose.yml)
oneshots=" config-render rabbitmq-init objectstore-init "
deadline=$(( $(date +%s) + ${WAIT_TIMEOUT:-300} ))
while :; do
  pending=(); failed=()
  while IFS='|' read -r svc state health exitcode; do
    if [[ "$oneshots" == *" $svc "* ]]; then
      if [[ "$state" == "exited" ]]; then [[ "$exitcode" == "0" ]] || failed+=("$svc(exit $exitcode)"); else pending+=("$svc"); fi
    else
      [[ "$state" == "running" && ( "$health" == "healthy" || -z "$health" ) ]] || pending+=("$svc:${health:-$state}")
    fi
  done < <("${compose[@]}" ps -a --format json | jq -r '[.Service, .State, (.Health // ""), (.ExitCode | tostring)] | join("|")')
  if (( ${#failed[@]} )); then echo "compose-wait: FAILED ${failed[*]}" >&2; exit 1; fi
  if ! curl -sf -m 3 -o /dev/null http://localhost:5080/healthz; then pending+=("openobserve:http"); fi
  if (( ${#pending[@]} == 0 )); then echo "compose-wait: all services healthy, init jobs completed"; exit 0; fi
  if (( $(date +%s) > deadline )); then echo "compose-wait: timeout waiting for ${pending[*]}" >&2; exit 1; fi
  echo "compose-wait: waiting for ${pending[*]}"
  sleep 5
done
