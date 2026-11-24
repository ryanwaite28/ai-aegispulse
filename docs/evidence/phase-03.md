# Phase 03 — Entities & Watchlists — Exit Evidence

| | |
|---|---|
| Commit SHA | base `0df3c40` + uncommitted Phase 3 working tree |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local (Testcontainers PostgreSQL 18.7 with pg_trgm, RabbitMQ 4.4.1, Redis 8.10.3 with the compose ACL); compose stack for E2E |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | `RUNTIME-VERIFIED` locally (E2E + API seed); exit needs the commit + green pipeline |

## Scope
Spec: [FR-ENT-01-05-entities-watchlists](../specs/FR-ENT-01-05-entities-watchlists.md). Migrations `V7__entities`, `V8__watchlists` (renumbered after Phase 2).

## Commands and results
```
./gradlew :registry:test → 46/46   (+EntityNamesTest 16 fixtures, AccessPolicyTest with the Phase 3 rows)
./gradlew :registry:integrationTest → 36/36   (+EntityIT 3, ResolutionIT 1, WatchlistIT 2)
make test-e2e → Test Files 3 passed, Tests 152 passed   (role matrix 24 routes × 6 roles; cross-tenant suite + Phase 3)
make lint (exit 0) · ci/lint-java.sh OK · make typecheck · make check · make contracts OK · make test-unit green
make migrate → registry V7 entities, V8 watchlists: Success
```

### Resolution fixtures (FR-ENT-03, `ResolutionIT`)
| Mention | Result |
|---|---|
| `ACMH` | ACME Holdings, `TICKER_EXACT` |
| `Acme Capital`, `ACME CAPITAL!` | ACME Holdings, `ALIAS_EXACT` |
| `Acme Holdings LLC` | ACME Holdings, `NAME_NORMALIZED` (suffix stripped) |
| `Globex Clearing` | Globex Clearing S.A., `NAME_NORMALIZED` |
| `Umbrella Pharma` | Umbrella Pharma AG, `NAME_NORMALIZED` |
| `Initech Securitiess` (0.857), `Initech Securities X` (0.905) | Initech Securities, `TRIGRAM` |
| `Globex Clearings` (0.833), `Initech Securites` (0.800), `Umbrella Pharmaceuticals`, `Wayne Enterprises` | unmatched (below 0.85 or unknown) |
| `Archived Corp`; ticker `ARCH` (archived) | unmatched (archived entities stop matching) |

- The same input gives identical output (determinism).
- Latency, 50 mentions × 40 warm calls: **p50 10 ms, p95 11 ms** (target ≤ 50 ms).
- Similarities were measured with the local pg_trgm. The first fixture draft assumed two near-misses would match, but they score below the 0.85 threshold, so they are now asserted as unmatched.

### Defects found and fixed during the phase
- Normalization turned `S.A.` into `s a`, which escaped suffix stripping. Dots and apostrophes are now deleted (fixture `Globex Clearing S.A.` → `globex clearing`).
- Adapters referenced repository record types (ArchUnit `ADAPTERS_CALL_SERVICES_NOT_REPOSITORIES`). `WatchlistEntry` and `WatchlistMembership` moved to the domain.

### Seed via the API (`make seed`, operator-run twice, 2026-11-24)
```
seed: tenant-acme-capital (8a92269a-91aa-4d80-b6fd-093a350304fe) entities=5 watchlist="Sanctions Watch" (714837e6-…) ← Globex Clearing
seed: tenant-globex-bank (fa09e325-e298-4cf9-8965-b0614b2bef95) entities=5 watchlist="Sanctions Watch" (6dcef1dc-…) ← Globex Clearing
seed: done (re-runnable)            (second run: identical ids, no changes)
```
Read-only database check after both runs:
```
tenant-acme-capital | entities 5 | watchlists 1 | entries 1 | demo_mode t
tenant-globex-bank  | entities 5 | watchlists 1 | entries 1 | demo_mode f
```
The first `make seed` attempt failed with exit 127. A PATH entry containing a space broke the Makefile's `SHELL := env PATH=…`; that is fixed (CHANGELOG).

## Pending (Phase 3 exit)
- Commit + green pipeline.
