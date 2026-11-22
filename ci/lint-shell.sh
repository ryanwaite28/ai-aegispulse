#!/usr/bin/env bash
# Runs ShellCheck over every tracked shell script (PROJECT.md K3S §3.2: CI logic lives in linted scripts).
set -euo pipefail
cd "$(dirname "$0")/.."
files=()
while IFS= read -r f; do files+=("$f"); done < <(git ls-files -co --exclude-standard '*.sh' '.githooks/*' | sort -u)
shellcheck -x "${files[@]}"
echo "lint-shell: OK (${#files[@]} files)"
