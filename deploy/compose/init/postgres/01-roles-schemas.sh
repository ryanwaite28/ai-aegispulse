#!/bin/bash
# One schema per owning service, an owner role (mig_*), a DML role (svc_*) and a NOLOGIN BYPASSRLS role ({schema}_platform)
# that only owns migration-defined SECURITY DEFINER functions for cross-tenant operations (PROJECT.md §5.7.2, §7.0,
# ADR-0005, ADR-0016). Creating a BYPASSRLS role needs the superuser, which is why it lives here, not in migrations.
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO PUBLIC;   -- extension functions only
SQL
for schema in ingestion files registry cases analytics; do
  upper=$(echo "$schema" | tr '[:lower:]' '[:upper:]')
  mig_pw_var="PG_MIG_PASSWORD_${upper}"; svc_pw_var="PG_SVC_PASSWORD_${upper}"
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
       -v schema="$schema" -v mig="mig_${schema}" -v svc="svc_${schema}" -v platform="${schema}_platform" \
       -v migpw="${!mig_pw_var}" -v svcpw="${!svc_pw_var}" <<'SQL'
CREATE ROLE :"mig" LOGIN PASSWORD :'migpw';
CREATE ROLE :"svc" LOGIN PASSWORD :'svcpw';
CREATE ROLE :"platform" NOLOGIN BYPASSRLS;
CREATE SCHEMA :"schema" AUTHORIZATION :"mig";
-- mig may only SET ROLE into platform (needed to assign function ownership); it does not inherit anything from it.
GRANT :"platform" TO :"mig" WITH INHERIT FALSE, SET TRUE;
GRANT USAGE, CREATE ON SCHEMA :"schema" TO :"platform";
GRANT CONNECT ON DATABASE aegispulse TO :"mig", :"svc";
GRANT USAGE ON SCHEMA :"schema" TO :"svc";
ALTER DEFAULT PRIVILEGES FOR ROLE :"mig" IN SCHEMA :"schema" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"svc";
ALTER DEFAULT PRIVILEGES FOR ROLE :"mig" IN SCHEMA :"schema" GRANT USAGE, SELECT ON SEQUENCES TO :"svc";
ALTER DEFAULT PRIVILEGES FOR ROLE :"mig" IN SCHEMA :"schema" GRANT EXECUTE ON FUNCTIONS TO :"svc";
ALTER ROLE :"svc" SET search_path = :"schema", public;
ALTER ROLE :"mig" SET search_path = :"schema", public;
SQL
done
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -v pw="$PG_BACKUP_PASSWORD" <<'SQL'
CREATE ROLE backup_reader LOGIN PASSWORD :'pw';
GRANT pg_read_all_data TO backup_reader;
SQL
echo "postgres init: schemas + roles created"
