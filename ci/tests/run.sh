#!/usr/bin/env bash
# Self-tests for the CI guardrail scripts. Each case asserts an exit code against a fixture.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; ci="$(cd "$here/.." && pwd)"
pass=0; fail=0
expect() { # expect <name> <expected-exit> <cmd...>
  local name="$1" want="$2"; shift 2
  local out; out="$("$@" 2>&1)"; local rc=$?
  if [[ "$rc" == "$want" ]]; then pass=$((pass+1)); echo "ok   - $name"; else fail=$((fail+1)); echo "FAIL - $name (exit $rc, want $want)"; printf '       %s\n' "${out//$'\n'/$'\n'       }"; fi
}
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# --- check-boundaries ---
mkdir -p "$tmp/clean/gateway/nest-http/src/clients" "$tmp/clean/services/files/src/service"
echo "import { request } from 'undici';" > "$tmp/clean/gateway/nest-http/src/clients/files.client.ts"
echo "import type { FileRow } from '../db/files.repository.js';" > "$tmp/clean/services/files/src/service/files.service.ts"
expect "boundaries: clean tree passes" 0 "$ci/check-boundaries.sh" "$tmp/clean"

mkdir -p "$tmp/bad1/gateway/nest-http/src"; echo "import { Pool } from 'pg';" > "$tmp/bad1/gateway/nest-http/src/x.ts"
expect "boundaries: gateway importing pg fails" 1 "$ci/check-boundaries.sh" "$tmp/bad1"
mkdir -p "$tmp/bad2/workers/scheduler-trigger/src"; echo "import Redis from 'ioredis';" > "$tmp/bad2/workers/scheduler-trigger/src/y.ts"
expect "boundaries: worker importing ioredis fails" 1 "$ci/check-boundaries.sh" "$tmp/bad2"
mkdir -p "$tmp/bad3/gateway/nest-http/src/modules/cases"; touch "$tmp/bad3/gateway/nest-http/src/modules/cases/cases.service.ts"
expect "boundaries: *.service.ts in gateway fails" 1 "$ci/check-boundaries.sh" "$tmp/bad3"
mkdir -p "$tmp/bad4/services/cases-ts/src/domain"; echo "import Fastify from 'fastify';" > "$tmp/bad4/services/cases-ts/src/domain/policy.ts"
expect "boundaries: fastify import in domain fails" 1 "$ci/check-boundaries.sh" "$tmp/bad4"
mkdir -p "$tmp/bad5/services/risk-scoring/src/aegis_risk/service"; echo "from fastapi import APIRouter" > "$tmp/bad5/services/risk-scoring/src/aegis_risk/service/score.py"
expect "boundaries: fastapi import in python service layer fails" 1 "$ci/check-boundaries.sh" "$tmp/bad5"

# --- check-migrations (throwaway repo) ---
repo="$tmp/repo"; mkdir -p "$repo/services/files/db/migrations"; cp "$ci/check-migrations.sh" "$tmp/check-migrations.sh"
(
  cd "$repo" && git init -q -b main && git config user.email t@t && git config user.name t
  echo "CREATE TABLE a();" > services/files/db/migrations/V1__a.sql && git add . && git commit -qm base
  git checkout -qb feature
)
(cd "$repo" && echo "CREATE TABLE b();" > services/files/db/migrations/V2__b.sql && git add . && git commit -qm add)
expect "migrations: adding a new file passes" 0 bash -c "cd '$repo' && '$tmp/check-migrations.sh' main"
(cd "$repo" && echo "-- edited" >> services/files/db/migrations/V1__a.sql && git commit -qam edit)
expect "migrations: editing committed file fails" 1 bash -c "cd '$repo' && '$tmp/check-migrations.sh' main"

# --- resource budget ---
expect "budget: compliant manifests pass" 0 "$ci/check-resource-budget.sh" "$here/fixtures/prod"
expect "budget: missing limits / over budget fail" 1 "$ci/check-resource-budget.sh" "$here/fixtures/dev"

echo; echo "ci self-tests: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
