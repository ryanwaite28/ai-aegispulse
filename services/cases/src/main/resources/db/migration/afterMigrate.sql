-- Flyway callback (runs after every migrate): keep the migration history read-only for the service role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON cases.flyway_schema_history FROM svc_cases;
GRANT SELECT ON cases.flyway_schema_history TO svc_cases;  -- readiness checks the schema version (NFR-11)
