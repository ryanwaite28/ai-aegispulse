#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm install --frozen-lockfile --prefer-offline
pnpm run test
echo "test-node: OK"
