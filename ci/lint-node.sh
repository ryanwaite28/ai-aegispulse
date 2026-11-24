#!/usr/bin/env bash
# ESLint + Prettier + workspace typecheck (NFR-14).
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile --prefer-offline
pnpm run lint
pnpm run typecheck
echo "lint-node: OK"
