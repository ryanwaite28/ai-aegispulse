# Spec — FR-TXN-01 / FR-TXN-06 — Transaction intake & status

| | |
|---|---|
| Phase | 08 — Transactions, Scoring & Risk Cases, slice 8a (`PROJECT.md` §11) |
| Owner runtime(s) | `services/ingestion` (+ gateway `TransactionsController`) |
| Status | RUNTIME-VERIFIED locally for FR-TXN-01; FR-TXN-06 ingestion read done, the gateway composition with cases lands in slice 8c |
| Related NFRs | NFR-02 (idempotency), NFR-06 (tenant isolation, RLS) |
| Related ADRs | ADR-0004 (outbox), ADR-0016 (RLS) |

## 1. Requirement (verbatim from PROJECT.md §2)
> - **FR-TXN-01**: `INTEGRATION`/`ANALYST` submits `POST /v1/transactions`: `idempotencyKey` (required, ≤ 128), `accountId` (≤ 64), `counterpartyId` (≤ 64), `counterpartyName` (≤ 200), `amount` (decimal string, > 0, ≤ 18 digits, 2–4 decimals), `currency` (ISO 4217 in FX table), `country` (ISO alpha-2), `channel` (`WIRE|ACH|CARD|CRYPTO|INTERNAL`), `occurredAt` (≤ 24 h future skew rejected), `metadata` (object ≤ 4 KiB). Persists `transaction_submissions` + outbox `txn.submitted` atomically; returns `202 {transactionId, eventId}`. Same idempotency key + same body hash → original response; same key + different body → `409 IDEMPOTENCY_KEY_REUSED`.
> - **FR-TXN-06**: `GET /v1/transactions/{id}` returns submission, processing status (`ACCEPTED`, `SCORED`, `CASE_OPENED`, `FAILED`), latest evaluation, and linked case id (composed by the gateway from Ingestion + Cases typed clients).

## 2. Behavior
**`ingestion.submitTransaction`:**
1. **Authorize:** the contract roles are INTEGRATION, ANALYST, TENANT_ADMIN, and PLATFORM_ADMIN with `X-Aegis-Tenant`, via the kit's `tenantAccess`.
2. **Tenant status:** the tenant must be `ACTIVE`, through the registry settings cache with TTL ≤ 60 s. Otherwise the call fails with `403 TENANT_SUSPENDED` (FR-TEN-02).
3. **Shape:** checked at the route against the contract `SubmitTransactionInput` (strict). The amount pattern is `^(?=.*[1-9])[0-9]{1,18}\.[0-9]{2,4}$`.
4. **Rules** (domain `intakeViolations`):
   - the currency must be in `fx-static-v1`;
   - `occurredAt` may be at most 24 h in the future;
   - metadata may be at most 4 KiB serialized.
   Any violation → `422 VALIDATION_ERROR` with field details.
5. **One tenant transaction (RLS):**
   - A row already present for `(tenant, idempotencyKey)` is a repeat.
   - Otherwise, insert with `ON CONFLICT DO NOTHING`. A lost race re-reads the winner.
   - On a fresh insert, enqueue `txn.submitted` (aegispulse.ingress, sensitivity CONFIDENTIAL, `idempotencyKey txn.submitted:{id}`). The correlation id is the request's `corr-…` or `corr-{eventId}`.
6. **Repeats:**
   - Same `request_sha256`, the canonical JSON of the body with sorted keys → `202` with the original `{transactionId, eventId}` and no new row or event.
   - Different body → `409 IDEMPOTENCY_KEY_REUSED`.
   - The body's `idempotencyKey` is authoritative. The `Idempotency-Key` header is forwarded but not required.

**`ingestion.getTransaction`:** the submission in the caller's tenant; otherwise `404 NOT_FOUND`, per the contract. The amount comes back as stored `NUMERIC(22,4)` text, e.g. `"1250.5000"`. Status, evaluation and case come from cases in 8c.

## 3. Data & migrations
- `services/ingestion/db/migrations/V6__transaction_submissions.sql` creates the table as §7.2, with indexes and RLS (`tenant_isolation`).
- `submitted_by` is the actor reference text (`user:{uuid}` | `integration:{clientId}`), an amendment: integration tokens carry the client id, not a UUID.
- `packages/contracts/reference/fx-static-v1.json`, an amendment: the static FX table as a contract reference file.

## 4. Contracts
- Internal actions: `ingestion.submitTransaction`, `ingestion.getTransaction`.
- Public routes: `POST /v1/transactions` (202), `GET /v1/transactions/{id}` (8c).
- Event: `txn.submitted` (`packages/contracts/events/txn.submitted.v1.schema.json`) → `orchestrator.txn.q`, plus the archive.

## 5. Layer placement
| Piece | File |
|---|---|
| Domain (pure) | `services/ingestion/src/domain/transaction.ts` |
| Service | `services/ingestion/src/service/transaction.service.ts`; event builder `src/service/events.ts` `txnSubmitted` |
| Repository | `services/ingestion/src/db/transactions.repository.ts` |
| FX table reader | `services/ingestion/src/storage/fx-table.ts` |
| Internal route adapter | `services/ingestion/src/adapters/http/transactions.routes.ts` |
| Gateway | `gateway/nest-http/src/modules/transactions/transactions.controller.ts` (`IngestionClient.call` now forwards `X-Aegis-Tenant`) |

## 6. Security & observability
- RLS on every query. Tenant isolation is tested: the same key in two tenants gives two rows, and reading another tenant's id is 404.
- The payload carries transaction fields only, sensitivity CONFIDENTIAL. The log line `transaction.submitted` has ids, channel and actor, never the amount or names.

## 7. Test plan
| Level | Test | Proves |
|---|---|---|
| Unit | `src/domain/transaction.test.ts` | FX, skew, metadata rules; canonical hash (key order, value change) |
| Integration | `tests/integration/transactions.integration.test.ts` (5) | atomic row + schema-valid event; repeat → original; 409; 5 concurrent → 1 row/1 event; tenant isolation; 422/403/TENANT_SUSPENDED |
| Gateway unit | `files.test.ts` "transaction intake over the gateway" | forwarding, 202 |
| E2E | `tests/e2e/transactions.e2e.test.ts`, role matrix "Phase 8" | 202 → repeat → 409; 422s; txn.submitted archived on the request's correlation id |
