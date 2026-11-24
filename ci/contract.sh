#!/usr/bin/env bash
# Contract gate (PROJECT.md §12 rule 13, NFR-13): validate every contract, regenerate types, and fail if generated code
# is stale (someone changed a contract without running `make contracts`, or hand-edited packages/contracts/generated/).
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm --filter @aegispulse/contracts run validate
pnpm --filter @aegispulse/contracts run generate
if [[ -n "$(git status --porcelain -- packages/contracts/generated)" ]]; then
  echo "CONTRACT DRIFT: packages/contracts/generated is out of date — run \`make contracts\` and commit the result:" >&2
  git status --porcelain -- packages/contracts/generated | head -20 >&2
  [[ "${CI:-}" == "true" ]] && exit 1
fi
echo "contract: OK"
