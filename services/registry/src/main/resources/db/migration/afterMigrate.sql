-- Flyway callback (runs after every migrate): keep the migration history read-only for the service role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON registry.flyway_schema_history FROM svc_registry;
GRANT SELECT ON registry.flyway_schema_history TO svc_registry;  -- readiness checks the schema version (NFR-11)
