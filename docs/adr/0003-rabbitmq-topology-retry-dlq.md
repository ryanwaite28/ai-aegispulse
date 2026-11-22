# ADR-0003 — RabbitMQ topology, retry tiers, and dead-letter registry

- **Status:** Accepted
- **Date:** 2026-11-22
- **PROJECT.md sections affected:** §5.5, §6.5, §6.7
- **Related:** FR-MSG-01..04, NFR-02, NFR-10

## Context
The platform needs at-least-once delivery with bounded retries, inspectable failures, and an archive that captures every routed event. The broker is shared across the cluster (`rabbitmq` namespace).

## Decision
- Dedicated vhost `aegispulse`. Four topic exchanges (`ingress`, `enrichment`, `domain`, `intelligence`) plus direct `aegispulse.retry` and `aegispulse.dlx`.
- **Quorum queues** for all consumer queues, with `x-delivery-limit` as a backstop.
- Retry by **republishing** to TTL queues `{queue}.retry.{1s|5s|30s}` that dead-letter back to the source queue through the default exchange, with `x-retry-count` in the headers. Three retries at most, then DLQ.
- `{queue}.dlq` per consumer queue, plus `events.deadletter.q` bound `#` on the DLX, which records every dead letter in Mongo for the admin API and replay.
- Topology is declared once in `packages/contracts/topology/aegispulse.topology.json` and asserted by a Job using a privileged topology user. Runtime users can't declare resources.
- Node consumers use `rxjs-rabbitmq` through `ts-platform/amqp`, with typed generics generated from the topology file.

## Options considered
| Option | Pros | Cons |
|---|---|---|
| TTL retry queues + DLX (chosen) | broker-native, observable, no plugin | more queues |
| Delayed-message plugin | fewer queues | plugin dependency on a shared broker |
| `nack` requeue loops | trivial | hot loops, no backoff |

## Consequences
- Queue count is about 4× consumer queues, which is acceptable. Retry queues hold no consumers.
- Ordering is not guaranteed, so consumers rely on versions and revisions instead.

## Verification
Kit integration tests for retry timing and DLQ headers, and the chaos suite in Phase 18.
