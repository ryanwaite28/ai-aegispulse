# ADR-0005 — Flyway SQL migrations and schema-per-service PostgreSQL

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §5.6, §5.7.2, §7, §9.2
- **Related:** NFR-11, NFR-13

## Context
Five services in three languages use PostgreSQL. Per-language migration tools (Prisma, Alembic, Flyway) would split the discipline and the tooling.

## Decision
- One database `aegispulse` with one schema per owning service (`ingestion`, `files`, `registry`, `cases`, `analytics`). Each schema gets an owner role (`mig_*`) and a DML role (`svc_*`).
- **All PostgreSQL migrations are plain SQL Flyway files** (`V{n}__{desc}.sql`). They run as Kubernetes Jobs before rollout and with `make migrate` locally. Apps never auto-migrate in the homelab.
- Forward-only and expand/contract. Existing files are immutable (enforced by a Claude hook and CI).
- Readiness checks require the expected Flyway version.
- MongoDB indexes and validators use `migrate-mongo` with the same rules.

## Consequences
- Kysely (Node) and SQLAlchemy Core (Python) never manage schema. Their types are written to match the SQL.
- Splitting into per-service databases later is mechanical because nothing crosses schemas.

## Verification
The migration integration test checks grants (cross-schema denial, no `UPDATE` on `audit_log`), and `ci/check-migrations.sh` blocks edits to existing files.
