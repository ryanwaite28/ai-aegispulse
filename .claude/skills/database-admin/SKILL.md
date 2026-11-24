---
name: database-admin
description: AegisPulse database-administration role. Use when writing or reviewing PostgreSQL DDL/Flyway migrations, indexes, RLS policies, roles and grants, MongoDB collections/validators/indexes (migrate-mongo), Redis keyspace/ACLs, query performance, retention/TTL, backups, and restore drills.
---

# Database Administrator — AegisPulse

Source of truth: `PROJECT.md` §5.6, §5.7.2–§5.7.3, §7 (DDL, Mongo, Redis, object keys), NFR-02, NFR-06, NFR-12, NFR-13, ADR-0005.

## PostgreSQL rules
- One DB, `aegispulse`, with one schema per owner (`ingestion`, `files`, `registry`, `cases`, `analytics`). Migrations run as `mig_{schema}` and the app runs as `svc_{schema}`. No cross-schema grants and no cross-schema FKs.
- Flyway files `V{n}__{snake_desc}.sql` are **immutable once merged**. Fix forward with a new version.
- **Expand/contract:** add nullable or defaulted columns → backfill in batches (≤ 5,000 rows per txn) → add constraints `NOT VALID` then `VALIDATE CONSTRAINT` → drop old columns in a later release. Build indexes on large tables with `CREATE INDEX CONCURRENTLY`, in their own migration and outside a transaction (`-- flyway:executeInTransaction=false`).
- Table template: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `tenant_id UUID NOT NULL` (tenant tables), `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`, `updated_at` + trigger for mutable tables, `CHECK` constraints for enums, money as `NUMERIC(22,4)`, and inline comments on non-obvious columns.
- Index every FK, every `WHERE` or `ORDER BY` column used by repositories, and a unique index for every idempotency key. Use partial indexes for status-filtered scans (`WHERE status = 'PENDING'`).
- **RLS on every tenant table:** `ENABLE` + `FORCE ROW LEVEL SECURITY`, policy on `current_setting('app.tenant_id', true)::uuid`. Services `SET LOCAL app.tenant_id` per transaction. The bypass flag is used only by audited platform jobs.
- `cases.audit_log`: append-only (trigger plus no `UPDATE/DELETE/TRUNCATE` grants), with a per-tenant hash chain serialized by `pg_advisory_xact_lock`.
- Outbox: partial index on `PENDING`, `SKIP LOCKED` claiming, purge `SENT` after 7 days.
- Every migration MR states: lock impact, row-count estimate, backfill plan, and the rollback-compatibility note (the N-1 app still works).

## MongoDB rules (`aegispulse_events`, owner: events)
- Collections have `$jsonSchema` validators generated from contracts, with `validationLevel: strict`.
- Indexes are defined only in `services/events/src/db/mongo-migrations/`, never via runtime `createIndex`.
- Unique `{tenantId, eventId}`. TTL on `expireAt`. A partial index for `pendingAiScan`. See §7.6 for the full list.
- Run as a single-member replica set (`rs0`) so multi-document transactions work for the outbox and restricted moves.
- Every query includes `tenantId` (the repository wrapper rejects queries without it). Check `explain()` for new query shapes and avoid `COLLSCAN` on archive collections.

## Redis rules
- Every key has a TTL (`volatile-ttl` eviction). Key patterns and owners are listed in §7.7, and ACL users are restricted to their own prefixes.
- Redis is never the durable guard. A Postgres unique constraint backs every dedup and idempotency decision.

## Backup & restore (NFR-12)
- Nightly `pg_dump -Fc` (role `backup_reader`) and `mongodump --archive --gzip` go to the backups bucket (versioned), with a weekly off-node copy.
- Restore drill per release candidate into `aegispulse-restore-test`: row counts, `verifyAuditChain`, Mongo document counts, and the index list. Record it in `docs/evidence/`.
- Targets: RPO 24 h, RTO 2 h (prod). Dev keeps weekly dumps (2 retained) and is resettable (`make env-reset ENV=dev`). Each environment has its own datastores, and nothing is shared across namespaces (ADR-0014).

## Homelab placement
The data StatefulSets carry the `dedicated: storage` nodeSelector **and** the toleration **before their first deploy**. A `local-path` PVC binds to a node permanently, and moving it means backup → delete → restore.

## Review checklist
Constraint names are clear · FKs indexed · idempotency unique index present · RLS policy added · grants least-privilege · no edits to old files · backfill batched · `CONCURRENTLY` where needed · Mongo index migration included · TTL/retention honored.
