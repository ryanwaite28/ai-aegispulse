# Flyway runner for every PostgreSQL schema (ADR-0005). Used by `make migrate` locally and as the pre-rollout Job in dev/prod.
FROM flyway/flyway:11.20.3-alpine
USER root
RUN apk add --no-cache bash
COPY services/ingestion/db/migrations/ /flyway/sql/ingestion/
COPY services/files/db/migrations/ /flyway/sql/files/
COPY services/registry/src/main/resources/db/migration/ /flyway/sql/registry/
COPY services/cases/src/main/resources/db/migration/ /flyway/sql/cases/
COPY services/data-intel/db/migrations/ /flyway/sql/analytics/
COPY deploy/docker/migrate.sh /usr/local/bin/aegis-migrate
RUN chmod 0555 /usr/local/bin/aegis-migrate && chown -R 1000:1000 /flyway/sql
USER 1000
ENTRYPOINT ["/usr/local/bin/aegis-migrate"]
