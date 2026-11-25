# Phase 08a — Transaction intake (FR-TXN-01, FR-TXN-06 ingestion read)

| | |
|---|---|
| Commit SHA | `f51fdf7` + uncommitted 8a |
| Date (UTC) | 2026-11-25 |
| Environment | local compose stack with rebuilt ingestion + gateway images; Testcontainers PostgreSQL 18 |
| Verified by | Claude Code (Opus) |
| Result | FR-TXN-01 `RUNTIME-VERIFIED` locally; the FR-TXN-06 gateway composition waits on cases (8c) |

Spec: [FR-TXN-01-06](../specs/FR-TXN-01-06-transaction-intake.md). Owner-approved amendment: `fx-static-v1` as a contract reference file. Clarifications: migration `V6`, and `submitted_by` as the actor reference.

| Check | Result |
|---|---|
| `make contracts` | ✓ reference: fx-static-v1, 20 currencies; contract OK |
| `make migrate` | `ingestion: | Versioned | 6 | transaction submissions | … | Success` → 12 runtimes `/readyz` |
| ingestion unit | 18 passed (incl. `transaction.test.ts`) |
| ingestion integration `transactions.integration.test.ts` | 5/5 (atomic row + event, idempotent repeat, 409, concurrency 5 → 1, RLS isolation, 422/403/TENANT_SUSPENDED) |
| gateway unit | 20 passed |
| `make test-e2e` | Test Files 8 · **302 passed**, including `transactions.e2e.test.ts`: 202 → identical repeat → 409; `txn.submitted` archived with the returned `eventId` on the request's `x-correlation-id`; 422 for `XYZ` and for +25 h; VIEWER 403; role matrix "Phase 8" `submitTransaction` × every role |
| ingestion integration, all files | webhook-sources 4/4, ingest 7/7, transactions 5/5. In one parallel run beside the full compose stack, a Testcontainers start timed out ("ports to be bound", host load), so each file was rerun on its own |
| `make lint`, `make test-unit` | exit 0 |
