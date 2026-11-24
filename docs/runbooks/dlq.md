# Runbook — Dead letters (FR-MSG-02/03/04)

**When to use:**
- the ntfy alert N-04 "{count} dead letters on {queue} in {window}" arrives (`aegispulse-dlq-spike` or `aegispulse-dlq-depth`);
- `make check-dlq-alert` exits 1;
- someone reports work that "never finished" (a file stuck in `UPLOADED`, an event missing from the archive).

**Who:** a `PLATFORM_ADMIN` (all tenants) or a tenant's `TENANT_ADMIN` (own tenant only).

## How a message becomes a dead letter
`TRANSIENT` failures retry through `{queue}.retry.1s → 5s → 30s` (about 36 s in total). `PERMANENT` and `POISON` failures skip the retries. Either way the message is then republished to `aegispulse.dlx` with these headers:

| Header | Meaning |
|---|---|
| `x-aegis-error-code` | Stable error code (e.g. `DEPENDENCY_UNAVAILABLE`, `NOT_FOUND`, `ENVELOPE_INVALID`) |
| `x-aegis-original-queue` | The queue that gave up |
| `x-aegis-error-message` | Log-safe description: class, code and message, never payload content |
| `x-aegis-error-stack-hash` | 16 hex. The same hash means the same failure site, across messages and builds |
| `x-retry-count` | Retries spent (3 once the transient budget is exhausted) |

Each copy lands twice:
- in `{queue}.dlq`, retained for broker-level inspection;
- in `events.deadletter.q`, which the events registry records in Mongo `dead_letters` as one **OPEN** record per failing message.

## Triage
1. **What is failing?** List the newest records and group them in your head by queue, `errorCode` and `stackHash`.
   ```bash
   curl -s -H "authorization: Bearer $TOKEN" "$API/v1/ops/dead-letters?limit=50" | jq '.data[] | {id, queue, errorCode, errorMessage, retryCount, lastFailedAt}'
   # narrow: ?queue=files.validation.q  ?errorCode=DEPENDENCY_UNAVAILABLE  ?from=2026-11-24T00:00:00Z&to=…
   # PLATFORM_ADMIN: add -H "x-aegis-tenant: <tenantId>" to see one tenant only
   ```
2. **Look at one record.** `GET /v1/ops/dead-letters/{id}` shows the original `envelope` (or `rawBody` for unreadable poison), the `headers`, `stackHash` and `occurrences`.
   - Card numbers, SSNs, secrets and PII-named fields are masked in every view (`redactions[]` lists them). Replay still re-delivers the original message.
   - `replayable: false` marks a suspect record whose queue header disagreed with its routing key. Investigate the producer and discard it.
   - Resolved records expire 30 days after resolution.
3. **Classify the cause by `errorCode`:**
   - `DEPENDENCY_UNAVAILABLE`, timeouts, or `INTERNAL_ERROR` after 3 retries: an outage or a bug in the consumer.
     - Check that service's `/readyz` and logs: OpenObserve → traces/logs by `service.name`, filter on the `stackHash` or `eventId`.
     - Fix the dependency first, for example restart the scanner (`docker compose … up -d clamav` locally) or wait for the outage to end.
   - `NOT_FOUND` or other domain codes (PERMANENT): the message refers to something that does not exist, or breaks a rule.
     - Decide whether it ever can succeed (for example, an upstream fix creates the missing row). If it cannot, discard it.
   - `ENVELOPE_INVALID` (POISON): the producer sent an invalid envelope.
     - Fix the producer. A replay of the same bytes will fail again, so discard it with a reason that names the fix.

## Resolve
- **Replay** once the cause is fixed. This republishes the stored message into its original queue with `x-retry-count = 0`. It travels via the queue's shortest retry queue, so it arrives after about 1 s (5 s for `doc.extraction.q`).
  ```bash
  curl -s -X POST -H "authorization: Bearer $TOKEN" -H "idempotency-key: $(uuidgen)" "$API/v1/ops/dead-letters/{id}/replay"
  ```
  - Consumers are idempotent (NFR-02), so a message that partly succeeded before failing is not applied twice.
  - Replaying an already-replayed record by the same person returns it unchanged. Anything else is 409 `DEAD_LETTER_ALREADY_RESOLVED`.
  - 503 `DEPENDENCY_UNAVAILABLE` means the broker did not confirm. The record stays OPEN; retry the call.
- **Discard** when the message must never be processed:
  ```bash
  curl -s -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
    -d '{"reason":"producer bug fixed in <MR>; event superseded"}' "$API/v1/ops/dead-letters/{id}/discard"
  ```
- Both actions are audited (`ops.audit.dead_letter_resolved` → cases audit chain) with the acting user and the reason.
- Verify the effect. For files: `GET /v1/files/{fileId}` leaves `UPLOADED`. For events: the event appears in `GET /v1/events?correlationId=…`.

## Clear the broker copies (the depth alert)
The registry is the system of record. The `{queue}.dlq` copies are for broker-level inspection only and keep `aegispulse-dlq-depth` firing until they are purged.
1. Once every record for that queue is `REPLAYED` or `DISCARDED`, check that nothing is OPEN: `GET /v1/ops/dead-letters?queue=<queue>` and look at the `status` values.
2. Purge the DLQ:
   - local: `docker compose --env-file .env -f deploy/compose/docker-compose.yml exec -T rabbitmq rabbitmqctl -p aegispulse-local purge_queue <queue>.dlq`
   - dev/prod: the RabbitMQ management UI → Queues → `<queue>.dlq` → Purge, in vhost `aegispulse-dev` / `aegispulse-prod`
3. Run `make check-dlq-alert` locally (or wait for the next cluster alert evaluation) and confirm both alerts are `ok`.

## If the registry itself is failing
- `events.deadletter.q` has no DLQ. On a failure (e.g. Mongo down) the events consumer keeps each delivery and retries in process: 5 s, doubling to 60 s.
  - After 20 min it requeues the delivery. The quorum queue's `x-delivery-limit: 10` drops a message only after about 10 such cycles, roughly 3 h of outage.
  - While the outage lasts, the queue backs up behind the held deliveries. That is expected.
- Check the events `/readyz` and the logs for `raw handler failed; retrying in process` / `delivery requeued`.
- An outage longer than about 3 h needs action before the delivery limit is reached. The `{queue}.dlq` copies are the fallback record, so do not purge them.
- To backfill registry records lost to the limit, move each `{queue}.dlq`'s messages back through `aegispulse.dlx` with the original routing key. Use the RabbitMQ management UI "Move messages" (shovel) to `aegispulse.dlx`. The registry dedupes repeats of OPEN records.
- Once Mongo is back, the backlog drains on its own. No data is lost, because the `{queue}.dlq` copies remain.

## Never
- Do not purge `{queue}.dlq` while matching registry records are still OPEN. The copy is the second line of evidence.
- Do not replay `ENVELOPE_INVALID` poison without fixing the producer. It comes straight back.
- Do not run synthetic dead-letter bursts against prod. The alert test with 11 dead letters in 5 min runs in dev only (Phase 18).
