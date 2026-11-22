#!/usr/bin/env bash
# pytest across the workspace; exit code 5 (no tests collected) is accepted until Phase 1 adds suites.
set -euo pipefail
cd "$(dirname "$0")/.."
uv sync --frozen --all-groups
set +e; uv run pytest -q; rc=$?; set -e
if [[ $rc -eq 5 ]]; then echo "test-python: no Python test suites yet (Phase 1)"; exit 0; fi
exit $rc
