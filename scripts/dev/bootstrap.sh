#!/usr/bin/env bash
# `make bootstrap`: verify toolchains, enable pnpm via corepack, install git hooks (PROJECT.md §9.5, §10.1).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
missing=0
need() { if command -v "$1" >/dev/null 2>&1; then printf '  %-10s ok   %s\n' "$1" "$($1 "${2:---version}" 2>&1 | head -1)"; else printf '  %-10s MISSING (%s)\n' "$1" "$3"; missing=1; fi; }
echo "Toolchain check:"
need node --version "Node 24 LTS (brew install node@24)"
need docker --version "Docker Desktop/Engine"
need java --version "Java 25 (brew install openjdk@25)"
need uv --version "brew install uv"
need gitleaks version "brew install gitleaks"
need shellcheck --version "brew install shellcheck"
need jq --version "brew install jq"
node_major=$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)
[[ "$node_major" == "24" ]] || { echo "  node: need major 24 (found $node_major). The Makefile prepends Homebrew node@24 if installed."; missing=1; }
java_major=$(java -version 2>&1 | head -1 | sed -E 's/.*version "([0-9]+).*/\1/' || echo 0)
[[ "$java_major" == "25" ]] || { echo "  java: need major 25 (found $java_major). The Makefile uses Homebrew openjdk@25 if installed."; missing=1; }
mkdir -p "$root/.tools/bin"
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable --install-directory "$root/.tools/bin" pnpm
echo "pnpm: $("$root/.tools/bin/pnpm" --version) (corepack shim in .tools/bin)"
git -C "$root" config core.hooksPath .githooks
echo "git hooks: core.hooksPath=.githooks (gitleaks pre-commit)"
uv python install 3.13 >/dev/null 2>&1 && echo "python 3.13: ok (uv-managed)"
exit $missing
