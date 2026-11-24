# Phase 04 (slice 4c) — Secret expiry + orphan sweep — Exit Evidence

| | |
|---|---|
| Commit SHA | base `71a117e` + uncommitted slice 4c working tree |
| Date (UTC) | 2026-11-24 |
| Environment(s) | local; Testcontainers PostgreSQL 18.7 (svc_ingestion, RLS), SeaweedFS 4.54 (compose identity template), Redis 8.10.3, RabbitMQ 4.4.1 |
| Pipeline | pending: commit + push |
| Verified by | Claude Code (Opus) |
| Resulting status | Slice 4c `RUNTIME-VERIFIED` locally (integration + `make trigger` against the compose stack; E2E 192/192 regression) |

## Scope
Spec: [FR-WHK-01-08-webhook-ingestion](../specs/FR-WHK-01-08-webhook-ingestion.md) §2 "Expiry and sweep". Migration `V5__webhook_maintenance` (definer functions only).

## Commands and results
```
services/ingestion: vitest (unit) → 14/14   (+ raw-objects 2: key shape, UTC day prefixes, 1 h rule, foreign keys)
services/ingestion: test:integration → 11/11 (+3 FR-WHK-08):
  expiry: PREVIOUS kept at +71 h, deleted at +72 h, CURRENT kept; user token → FORBIDDEN
  sweep: orphan (>1 h, no delivery row) deleted; referenced, 30-min-old and foreign-shaped objects kept; re-run idempotent
  grant: ingestion identity lists raw/webhooks/; listing "raw/", "raw/files/" and the bucket root → AccessDenied
workers/scheduler-trigger: vitest → 3/3 (job → action, allowlist cross-check against R__seed_service_accounts, unknown job refused)
docker build (node-service.Dockerfile, SERVICE=scheduler-trigger) → largest layer 56 MB; unknown job → exit 2
make lint (0) · make typecheck (0) · make check (0) · make contracts (0) · make test-unit (0)
```

### Compose stack (operator-run, 2026-11-24)
```
curl localhost:8081/readyz → ready, schema up (V5)
make trigger JOB=ingestion-secret-expiry → exit 0
  {"level":"info","service":"scheduler-trigger","job":"ingestion-secret-expiry","action":"ingestion.expirePreviousSecrets",
   "summary":{"processedCount":0,"startedAt":"2026-11-24T13:25:19.224Z","finishedAt":"2026-11-24T13:25:19.298Z"},
   "durationMs":732,"msg":"job succeeded"}
make test-e2e → Test Files 4 passed, Tests 192 passed (regression)
```
- `processedCount 0` is expected: no PREVIOUS secret was past 72 h, and there were no orphans.
- The sweep listed the prefixes of the tenants with sources (created by the E2E runs). Without the new `List` grant, that listing fails with a 500, so the run also shows the grant is active.
- The first attempt returned 404 `route not found`. The ingestion container was still on the pre-4c image; it was rebuilt but not recreated. Recreating the container fixed it, and no code change was needed.

## Pending
- Phase 4 exit: the demo → broker capture, the OpenObserve rejection-metric screenshot, the pipeline.
- Phase 9: the k8s CronJob `aegispulse-cron-secret-expiry` (added to §5.1 by the approved amendment, 2026-11-24).
