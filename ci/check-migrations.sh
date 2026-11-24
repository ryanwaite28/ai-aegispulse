#!/usr/bin/env bash
# Migration immutability gate (PROJECT.md §12 rule 11, ADR-0005): committed migrations may never be
# modified, renamed, or deleted. Compares HEAD with the merge base of the target branch.
# Usage: ci/check-migrations.sh [base-ref]   (default: $CI_MERGE_REQUEST_DIFF_BASE_SHA, else origin/main, else main)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
base="${1:-${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}}"
if [[ -z "$base" ]]; then
  for candidate in origin/main main; do
    if git rev-parse --verify -q "$candidate" >/dev/null; then base="$candidate"; break; fi
  done
fi
if [[ -z "$base" ]]; then echo "check-migrations: no base ref found; skipping"; exit 0; fi
merge_base="$(git merge-base "$base" HEAD)"
pattern='(^|/)(db/migrations?|src/main/resources/db/migration|mongo-migrations)/'
violations="$(git diff --name-status "$merge_base" HEAD | awk -v p="$pattern" '$1 !~ /^A/ && ($2 ~ p || $3 ~ p) {print}')"
if [[ -n "$violations" ]]; then
  echo "MIGRATION VIOLATION: committed migrations were modified/renamed/deleted (create a new V{n+1}__ file instead):"
  echo "$violations"
  exit 1
fi
echo "check-migrations: OK (base $(git rev-parse --short "$merge_base"))"
