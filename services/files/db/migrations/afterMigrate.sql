-- Flyway callback (runs after every migrate): keep the migration history read-only for the service role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON files.flyway_schema_history FROM svc_files;
GRANT SELECT ON files.flyway_schema_history TO svc_files;  -- readiness checks the schema version (NFR-11)
