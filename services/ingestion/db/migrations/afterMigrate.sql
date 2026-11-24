-- Flyway callback (runs after every migrate): keep the migration history read-only for the service role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ingestion.flyway_schema_history FROM svc_ingestion;
GRANT SELECT ON ingestion.flyway_schema_history TO svc_ingestion;  -- readiness checks the schema version (NFR-11)
