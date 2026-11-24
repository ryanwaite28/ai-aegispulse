# Clean-state verification (Runtime Completion Gate item 2) — Phases 0–6

| | |
|---|---|
| Commit SHA | `06c2482` + the compose-wait fix below |
| Date (UTC) | 2026-11-24 |
| Environment | local compose stack, every volume deleted first |
| Verified by | Claude Code (Opus); owner-approved `make reset` |
| Result | Gate item 2 met for Phases 0–6 |

## Sequence and results
```
make reset          → all containers and volumes removed (docker volume ls: 0 aegispulse_* volumes)
make up             → first attempt: timeout (exit 1) — see "Defect found" below; after the fix:
                      "infrastructure healthy and init jobs completed; fresh stack (no broker topology yet)" (~8 s)
make migrate        → Flyway: ingestion, files, registry, cases, analytics · migrate-mongo · topology-assert:
                      6 exchanges, 58 queues, 71 bindings → "all services healthy, init jobs completed,
                      12 runtimes pass /readyz" (24 s)
registry-bootstrap  → bootstrap.done outcome=CREATED (fresh PLATFORM_ADMIN)
make seed           → tenant-acme-capital and tenant-globex-bank, 5 entities each, "Sanctions Watch" ← Globex Clearing
make test-e2e       → Test Files 6 passed · Tests 267 passed
make demo-webhook   → 202 ACCEPTED (eventId 01a20f1a-3e9f-77d6-a763-4e644cd5b65f)
make demo-upload    → q3-filing.pdf VALIDATED (application/pdf) · eicar.txt QUARANTINED (MALWARE:Eicar-Test-Signature)
make trigger        → ingestion-secret-expiry, files-orphan-sweep, files-retention: job succeeded (processedCount 0)
rabbitmqctl         → every *.dlq queue empty
```

## Defect found and fixed: `make up` could not complete on a never-migrated stack
- **Symptom:** with no schemas and no broker topology, the runtimes retry for up to 60 s and then restart until `make migrate` creates them. This is NFR-11 behaviour: "retries … before failing"; readiness gates on schema and topology.
- **Cause:** `make up` waited for every runtime's `/livez`, timed out after 300 s and exited 1, so the gate's own `make reset && make up && make migrate` chain never reached `make migrate`.
- **Fix** (`scripts/dev/compose-wait.sh`): with `WAIT_PROBE=livez`, a stack without the topology's first exchange counts as fresh. `make up` then waits for infrastructure and init jobs only and says `make migrate` comes next. `make migrate` (`WAIT_PROBE=readyz`) remains the full readiness gate.
  - Runtime container states are tracked separately from infrastructure.
  - The empty-array expansion is safe under bash 3.2.
- **Side effect of the reset:** the one historical platform-tenant event that sat in `events.archive.q.dlq` (dead-lettered before the 6a fix) is gone with the broker volume, so it no longer needs the Phase 7 replay tooling.
