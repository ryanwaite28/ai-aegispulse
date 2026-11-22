#!/usr/bin/env bash
# Runs Flyway for each schema as its owner role mig_{schema} (ADR-0005). Fails fast on the first error.
# Env: PG_HOST, PG_PORT, PG_DATABASE, PG_MIG_PASSWORD_{SCHEMA}; optional MIGRATE_SCHEMAS (space-separated), FLYWAY_COMMAND (default migrate).
set -euo pipefail
schemas="${MIGRATE_SCHEMAS:-ingestion files registry cases analytics}"
cmd="${FLYWAY_COMMAND:-migrate}"
for schema in $schemas; do
  upper=$(echo "$schema" | tr '[:lower:]' '[:upper:]')
  pw_var="PG_MIG_PASSWORD_${upper}"
  if [[ -z "${!pw_var:-}" ]]; then echo "aegis-migrate: ${pw_var} is not set" >&2; exit 2; fi
  echo "aegis-migrate: ${cmd} schema=${schema}"
  flyway -url="jdbc:postgresql://${PG_HOST}:${PG_PORT:-5432}/${PG_DATABASE}" -user="mig_${schema}" -password="${!pw_var}" \
    -schemas="${schema}" -defaultSchema="${schema}" -createSchemas=false -locations="filesystem:/flyway/sql/${schema}" \
    -validateMigrationNaming=true -validateOnMigrate=true -outOfOrder=false -cleanDisabled=true -connectRetries=30 \
    -outputType=json -outputFile=/dev/null "${cmd}" >/dev/null
  flyway -url="jdbc:postgresql://${PG_HOST}:${PG_PORT:-5432}/${PG_DATABASE}" -user="mig_${schema}" -password="${!pw_var}" \
    -schemas="${schema}" -defaultSchema="${schema}" -locations="filesystem:/flyway/sql/${schema}" info \
    | grep -E '^\| (Versioned|Repeatable)' | sed "s/^/  ${schema}: /" || true
done
echo "aegis-migrate: done"
