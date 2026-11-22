# ADR-0004 — Transactional outbox for event publication

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §6.6, §7.0
- **Related:** NFR-02, FR-WHK-05, FR-CASE-03

## Context
Dual writes (commit to the DB, then publish) lose or duplicate events when a crash lands between the two steps.

## Decision
- Services with PostgreSQL insert into `{schema}.outbox_events` inside the business transaction. An in-process relay (`FOR UPDATE SKIP LOCKED`, 250 ms poll) publishes with publisher confirms, then marks the row `SENT`.
- The Events Service uses a Mongo `outbox` collection inside multi-document transactions. This is why Mongo runs as a single-member replica set.
- Producers with no transactional store (doc-extraction) avoid direct publishing: they report results through the Files Service API, which writes its own outbox. Where publishing can't be avoided, they use deterministic UUIDv5 event ids with confirms.
- Consumers dedupe on `eventId`, because the relay is at-least-once.

## Consequences
- Publish latency is up to one poll interval (≤ 250 ms p50).
- The `aegispulse_outbox_lag_seconds` metric and alert are required.

## Verification
An integration test kills the relay between publish and the `SENT` update and asserts that consumers see exactly one effective event.
