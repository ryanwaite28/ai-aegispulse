# ADR-0002 — Single gateway and no datastore access outside owning services

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §4.1, §5.7, §6.1, §12
- **Related:** NFR-09, FR-WHK-02, FR-SSE-01

## Context
The template guide requires Service Layer Supremacy and forbids gateways and workers from opening DB connections. The source concept places HMAC/Redis nonce checks and saga coordination in "Node edge consumers".

## Decision
- `gateway/fastify-http` is the only external entrypoint. It handles auth context, shape validation, and mapping, and calls typed clients. It holds **no** PostgreSQL, Mongo, Redis, or object-store clients. Subscribing to RabbitMQ for SSE projections is allowed because the broker is a transport, not a datastore.
- Webhook verification (HMAC, skew, Redis nonce) lives in `services/ingestion`. The gateway forwards the raw bytes.
- Cross-service sagas live in `services/orchestrator` (a service with a service layer and no datastore).
- `workers/scheduler-trigger` CronJobs each call exactly one internal service action.
- Each datastore schema, collection, keyspace, and bucket prefix has a single owner (§5.7). Cross-service data access goes through APIs only.

## Consequences
- Webhook processing adds one internal hop (gateway → ingestion), roughly 1–3 ms in-cluster, which is acceptable.
- The boundaries are machine-checkable: `ci/check-boundaries.sh`, dependency-cruiser, ArchUnit, import-linter, and NetworkPolicies.

## Verification
The boundary CI check and the NetworkPolicy test (`tests/security/netpol.sh`) show the gateway pod can't reach Postgres, Mongo, or Redis.
