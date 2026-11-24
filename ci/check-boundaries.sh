#!/usr/bin/env bash
# NFR-09 / ADR-0002 / ADR-0013 boundary gate.
#  1. gateway/ and workers/ must not import datastore clients.
#  2. gateway/nest-http must not contain *.service.ts files (providers are *.client.ts / *.mapper.ts only).
#  3. service/ and domain/ layers must not import transport frameworks (TS + Python; Java is covered by ArchUnit).
# Usage: ci/check-boundaries.sh [root]   (root defaults to repo root; tests pass a fixture dir)
set -euo pipefail
root="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
fail=0
report() { echo "BOUNDARY VIOLATION: $1"; fail=1; }

ts_files() { find "$@" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mts' -o -name '*.js' -o -name '*.mjs' \) \
  -not -path '*/node_modules/*' -not -path '*/dist/*' 2>/dev/null || true; }
py_files() { find "$@" -type f -name '*.py' -not -path '*/.venv/*' 2>/dev/null || true; }

datastore_re="from ['\"](pg|pg-pool|kysely|mongodb|mongoose|ioredis|redis|@aws-sdk/client-s3|@aws-sdk/s3-request-presigner|typeorm|@prisma/client|sequelize)['\"/]|require\\(['\"](pg|kysely|mongodb|ioredis|redis|@aws-sdk/client-s3)['\"]\\)"
for dir in "$root/gateway" "$root/workers"; do
  [[ -d "$dir" ]] || continue
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    if grep -nE "$datastore_re" "$f" >/dev/null; then report "${f#"$root"/}: datastore client import in a dispatch-only runtime"; fi
  done < <(ts_files "$dir")
done

if [[ -d "$root/gateway/nest-http" ]]; then
  while IFS= read -r f; do
    [[ -n "$f" ]] && report "${f#"$root"/}: *.service.ts is not allowed in the gateway (use *.client.ts / *.mapper.ts)"
  done < <(find "$root/gateway/nest-http" -name '*.service.ts' -not -path '*/node_modules/*' 2>/dev/null)
fi

transport_ts_re="from ['\"](fastify|@fastify/[^'\"]*|@nestjs/[^'\"]*|express|amqplib|rxjs-rabbitmq|undici)['\"]"
transport_py_re="^\s*(from|import)\s+(fastapi|starlette|aio_pika|pika|uvicorn|httpx)\b"
if [[ -d "$root/services" ]]; then
  while IFS= read -r layer; do
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      if grep -nE "$transport_ts_re" "$f" >/dev/null; then report "${f#"$root"/}: transport framework import in service/domain layer"; fi
    done < <(ts_files "$layer")
    while IFS= read -r f; do
      [[ -n "$f" ]] || continue
      if grep -nE "$transport_py_re" "$f" >/dev/null; then report "${f#"$root"/}: transport framework import in service/domain layer"; fi
    done < <(py_files "$layer")
  done < <(find "$root/services" -type d \( -name service -o -name domain \) -not -path '*/node_modules/*' -not -path '*/.venv/*' -not -path '*/src/main/java/*' 2>/dev/null)
fi

if [[ $fail -eq 0 ]]; then echo "check-boundaries: OK"; fi
exit $fail
