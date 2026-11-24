#!/usr/bin/env bash
# Idempotent PostgreSQL bootstrap for an EXISTING local volume (PROJECT.md §5.7.2, ADR-0016): creates any missing
# NOLOGIN BYPASSRLS {schema}_platform role with its grants. Fresh volumes get them from 01-roles-schemas.sh; volumes
# created before ADR-0016 get them here, so `make migrate` can apply V2 without `make reset`. Runs as the container's
# superuser over the local socket (no password on the command line).
set -euo pipefail
cd "$(dirname "$0")/../.."
compose=(docker compose --env-file .env -f deploy/compose/docker-compose.yml)
"${compose[@]}" exec -T postgres psql -v ON_ERROR_STOP=1 -U aegis_admin -d aegispulse -q <<'SQL'
DO $$
DECLARE s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['ingestion', 'files', 'registry', 'cases', 'analytics'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = s || '_platform') THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN BYPASSRLS', s || '_platform');
      EXECUTE format('GRANT %I TO %I WITH INHERIT FALSE, SET TRUE', s || '_platform', 'mig_' || s);
      EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', s, s || '_platform');
      RAISE NOTICE 'created %_platform', s;
    END IF;
  END LOOP;
END $$;
SQL
echo "pg-bootstrap: platform roles present"
