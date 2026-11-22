-- Flyway callback (runs after every migrate): keep the migration history read-only for the service role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON analytics.flyway_schema_history FROM svc_analytics;
GRANT SELECT ON analytics.flyway_schema_history TO svc_analytics;  -- readiness checks the schema version (NFR-11)
