# Steering — Quality Bar & Definition of Done

> Derived from `PROJECT.md` §3 (NFRs), §11.0 (completion gate), §12 (rules), §14 (testing).

## Definition of Done: single change (MR)
- [ ] Traces to FR/NFR ids. Ids appear in the MR title or description and in test names.
- [ ] Contracts changed first and regenerated. `make contracts` leaves no diff.
- [ ] Layering respected. `ci/check-boundaries.sh` and the architecture tests pass.
- [ ] Tests: unit for every new or changed service/domain function, and integration with real dependencies for every repository/consumer/route change.
- [ ] Error paths covered: validation, authz (role × tenant), duplicate/idempotent retry, dependency failure → retry/DLQ.
- [ ] Observability: logs carry the mandatory fields, there are spans for new I/O, and metrics exist where §3 NFR-07 names them.
- [ ] Security: input limits, no secrets or PII in logs, least privilege preserved.
- [ ] Migrations: new file only, expand/contract, and the down-level code still works.
- [ ] Docs: spec updated, `PROJECT.md` §11 checklist updated honestly, `CHANGELOG.md` entry added.

## Error classification (consumers)
| Class | Examples | Action |
|---|---|---|
| `TransientError` | timeout, 5xx, circuit open, connection reset, Mongo `WriteConflict`, PG serialization failure | retry tiers 1 s → 5 s → 30 s, then DLQ |
| `PermanentError` | 4xx from a dependency (other than 408/429), business rule violation that will never succeed, missing referenced resource after retries | DLQ immediately |
| `PoisonMessageError` | envelope/schema invalid, undeserializable body, unknown major `schemaVersion` | DLQ immediately with `x-aegis-error-code` |
| Duplicate | already processed (dedup hit, unique violation on idempotency key) | ack (success) |

## Code review checklist (human or agent)
1. Is any business decision made in a handler, consumer, CronJob, or the gateway?
2. Does any non-owner touch a datastore, or does any service reach into another service's data?
3. Is every write idempotent and every consumer redelivery-safe?
4. Are state changes and their events atomic (outbox)?
5. Is tenant isolation enforced in the service layer **and** by RLS or the repository guard?
6. Could this log or emit a secret, raw body, or PII?
7. Are timeouts, retries, and breakers set for every new outbound call?
8. Do the tests prove the FR acceptance with real dependencies?
9. Does the status claimed match the evidence?

## Verification vocabulary
`PENDING` → `SCAFFOLDED` → `SOURCE-IMPLEMENTED` → `MIGRATION-ADDED` → `UNIT-VERIFIED` → `INTEGRATION-VERIFIED` → `RUNTIME-VERIFIED`. Only the last one, with an evidence file, counts as complete.
