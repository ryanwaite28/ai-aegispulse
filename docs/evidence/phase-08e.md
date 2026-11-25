# Phase 08e — ScoreTransactionSaga (FR-TXN-03; FR-TEN-08 propagation)

| | |
|---|---|
| Commit SHA | `e81467d` + uncommitted 8e |
| Date (UTC) | 2026-11-25 |
| Verified by | Claude Code (Opus) |
| Result | RUNTIME-VERIFIED locally |

| Check | Result |
|---|---|
| orchestrator unit | 6 passed (saga 4, config 2) |
| Stack | rebuilt orchestrator with its SERVICE credentials; compose-wait 12 runtimes `/readyz`. Earlier `txn.submitted` backlog processed (4 `transaction.scored`), all DLQs empty |
| `make test-e2e` | Test Files 10 · **324 passed**: saga E2E (scores 65/65/65/70 → `CASE_OPENED`, factors 40/15/10/5); FR-TEN-08 settings propagation ≤ 65 s |

## Outage drill (risk-scoring stopped)
```
submitted 202
orchestrator 04:22:09.922  handler failed; scheduled retry → orchestrator.txn.q.retry.1s
orchestrator 04:22:10.945  handler failed; scheduled retry → orchestrator.txn.q.retry.5s
orchestrator 04:22:15.963  handler failed; scheduled retry → orchestrator.txn.q.retry.30s
orchestrator 04:22:46.033  message dead-lettered
dead-lettered after 36 s: errorCode DEPENDENCY_UNAVAILABLE, errorMessage "TransientError[DEPENDENCY_UNAVAILABLE]: risk-scoring request failed", retryCount 3
while down: ACCEPTED
replay 200 REPLAYED            (risk-scoring restarted first)
after replay: SCORED score 11
```
Afterwards the DLQ copy was purged per `docs/runbooks/dlq.md`.
