# Phase 00 — Project Scaffold & Toolchain — Exit Evidence

| | |
|---|---|
| Commit SHA | `029e2e8` base + uncommitted Phase 0 working tree (the commit is pending owner review) |
| Date (UTC) | 2026-11-22 16:22 |
| Environment(s) | local (macOS arm64, Docker 29.4.3, 10 CPU / 7.8 GiB to Docker) |
| Pipeline | **pending**: first GitLab pipeline runs after the owner commits and pushes |
| Verified by | Claude Code (Opus), session `adaa8ab5`; awaiting human review |
| Resulting status | SOURCE-IMPLEMENTED, local runtime verified; CI and Linux pending |

## Runtime Completion Gate (PROJECT.md §11.0), Phase 0 applicability
- [ ] 1. Source merged: **no**, the working tree is uncommitted. Contracts: n/a until Phase 1.
- [x] 2. Clean-state startup: `make reset && make env && make up`, all services healthy, init jobs exit 0 (below). `make down && make up` restart on existing volumes: healthy in 22 s.
- [x] 3. Real dependencies: the compose stack ran real PostgreSQL 18, MongoDB 8 rs0, Redis 8, RabbitMQ 4, SeaweedFS, ClamAV, and OpenObserve.
- [ ] 4. Async (outbox/redelivery/DLQ): n/a in Phase 0, starts in Phase 1 kits.
- [x] 5. Security checks: isolation probes (below), Gitleaks scan of all committable files (no leaks), guardrail self-tests.
- [ ] 6. Observability: OpenObserve is running and healthy; no application telemetry exists until Phase 1.
- [ ] 7. UI: n/a.
- [ ] 8. Dev/prod promotion: n/a until Phase 9.

## Commands & output

### make bootstrap (summary)
```text
node v24.22.3 · docker 29.4.3 · java openjdk 25.0.5.1 · uv 0.13.9 · gitleaks 8.30.1 · shellcheck 0.11.0 · jq 1.7.1
pnpm: 12.21.0 (corepack shim in .tools/bin)
git hooks: core.hooksPath=.githooks (gitleaks pre-commit)
python 3.13: ok (uv-managed 3.13.18)
pnpm install / uv sync: lockfiles created (pnpm-lock.yaml, uv.lock)
```

### make lint
```text
lint-shell: OK (21 files)
lint-node: OK
All checks passed!
lint-python: OK (4 files)
BUILD SUCCESSFUL in 1s
lint-java: OK
check-boundaries: OK
check-migrations: OK (base 2fffc8a)
ok   - boundaries: clean tree passes
ok   - boundaries: gateway importing pg fails
ok   - boundaries: worker importing ioredis fails
ok   - boundaries: *.service.ts in gateway fails
ok   - boundaries: fastify import in domain fails
ok   - boundaries: fastapi import in python service layer fails
ok   - migrations: adding a new file passes
ok   - migrations: editing committed file fails
ok   - budget: compliant manifests pass
ok   - budget: missing limits / over budget fail
ci self-tests: 10 passed, 0 failed
```

### make test (empty suites until Phase 1)
```text
test-node: OK
test-python: no Python test suites yet (Phase 1)
BUILD SUCCESSFUL in 1s
test-java: OK
```

### make up → docker compose ps
```text
SERVICE            IMAGE                               STATUS
clamav             clamav/clamav:1.5.5-debian13-slim   Up About a minute (healthy)
config-render      alpine:3.24.4                       Exited (0) About a minute ago
mongo              mongo:8.0.38                        Up About a minute (healthy)
objectstore        chrislusf/seaweedfs:4.54            Up About a minute (healthy)
objectstore-init   python:3.13-alpine                  Exited (0) About a minute ago
openobserve        openobserve/openobserve:v1.1.2      Up About a minute
postgres           postgres:18.7-alpine                Up About a minute (healthy)
rabbitmq           rabbitmq:4.4.1-management-alpine    Up About a minute (healthy)
rabbitmq-init      curlimages/curl:8.23.0              Exited (0) About a minute ago
redis              redis:8.10.3-alpine                 Up About a minute (healthy)
```

### Isolation probes (run inside containers with their own env; no secret values printed)
```text
postgres: mig_files create in own schema OK · svc_files DML own schema OK
          svc_files DDL → permission denied for schema files
          svc_ingestion select files.* → permission denied for schema files
mongo:    svc_events write aegispulse_events OK · svc_events write other db → not authorized
          svc_events replSetGetStatus → not authorized (least privilege) · replica set rs0 members=1 PRIMARY
redis:    files SET file:status:* OK · files SET whk:nonce:* → NOPERM · default user → NOAUTH (disabled)
rabbitmq: vhost aegispulse-local; svc_* configure ^$ (gateway: ^gateway\.sse\..*$ only), read own queues;
          gateway write limited to its SSE queues (cannot publish to domain exchanges)
clamav:   PING → PONG
```

### make objectstore-compat (ADR-0011, project identities on the local stack)
```text
[PASS] 2a presigned PUT (matching Content-Type) — HTTP 200
[PASS] 2b presigned PUT rejects mismatched Content-Type — HTTP 403
[PASS] 3 HEAD size — 18
[PASS] 4 presigned GET — HTTP 200
[PASS] 5 multipart upload — 5242884 bytes
[PASS] 6 server-side copy + delete
[PASS] 7 bucket versioning — status=Enabled versions=4
[PASS] 8a scoped principal writes allowed prefix
[PASS] 8b scoped principal denied outside prefix — AccessDenied

10/10 checks passed
```

### Gitleaks (all committable files, .gitignore respected)
```text
scanned ~727774 bytes (727.77 KB) in 169ms
no leaks found
```

## Issues found and fixed during Phase 0
- `clamav/clamav:1.5.5` is amd64-only, so it was switched to `1.5.5-debian13-slim` (multi-arch).
- The OpenObserve root password policy needs mixed case, a digit and a symbol. Added a `<generated:strong>` secret format.
- `docker compose up --wait` treats successful one-shot exits as failures. Added `scripts/dev/compose-wait.sh`.
- OpenObserve's image is distroless (no shell), so health is probed from the host.
- GNU make 3.81 ignored the exported PATH for direct commands, so recipes now run through `env PATH=…`.
- RabbitMQ gateway permissions were too broad (publish) and too narrow (bind). Fixed per FR-SSE-01.
- Installing `node@24` via Homebrew upgraded `simdjson` and broke the existing `node@22`. Repaired with `brew upgrade node@22`, and the other dependents (postgresql@18) were verified working.

## Known gaps / follow-ups
- First green GitLab pipeline (URL + SHA) after the owner commits and pushes.
- `make up` on Linux (CI or homelab).
- Spotless / Error Prone / ArchUnit, and a `check-layer-sizes` test, move to Phase 1.

## Update 2026-11-24 (review)
- `ci/check-layer-sizes.sh` is now self-tested in `ci/tests/run.sh`: `make check` → `ci self-tests: 12 passed, 0 failed`, including "layer sizes: small layer passes" and "layer sizes: 96 MB incompressible layer fails".
- Spotless / Error Prone / NullAway / ArchUnit arrived with the first Java project in Phase 1 (`build.gradle.kts`, `ci/lint-java.sh` `spotlessCheck`, `AegisArchitectureRulesTest`).
- Still open: `make up` on Linux and the first green GitLab pipeline.
