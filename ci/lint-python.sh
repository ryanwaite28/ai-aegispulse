#!/usr/bin/env bash
# Ruff (lint + format check) + mypy --strict over all Python in the repo (NFR-14).
set -euo pipefail
cd "$(dirname "$0")/.."
uv sync --frozen --all-groups
files=()
while IFS= read -r f; do files+=("$f"); done < <(git ls-files -co --exclude-standard '*.py' | grep -v '/generated/' | sort -u)
uv run ruff check "${files[@]}"
uv run ruff format --check "${files[@]}"
uv run mypy "${files[@]}"
uv run lint-imports
echo "lint-python: OK (${#files[@]} files)"
