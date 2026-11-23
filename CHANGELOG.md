# Changelog

All notable changes to AegisPulse are documented here.
The format follows [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Rules**
- Every merge request adds at least one line under `[Unreleased]` in the matching category.
- Reference FR/NFR ids and the phase, e.g. `- FR-WHK-02: constant-time HMAC verification with dual-key rotation (Phase 4)`.
- Status changes (e.g., a phase reaching `RUNTIME-VERIFIED`) go under **Status**, with a link to the evidence file.
- Categories: `Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`, `Docs`, `Status`.
- The release job moves `[Unreleased]` into a dated version section when a `vX.Y.Z` tag is pushed.

## [Unreleased]

### Added
- ADR-0015 node roles: `deploy/bootstrap/10-storage-node-disk.sh` (formats and mounts the storage node's data SSD, bind-mounts it over the local-path directory, makes `k3s-agent` require the mount; the wipe step needs typed confirmation) and `deploy/bootstrap/20-node-roles.sh` (idempotent label and taint swap, `CHECK_ONLY=1` audit mode).
- Phase 1a (contracts + data foundations): canonical envelope v1.1 schema + examples; RabbitMQ topology contract (6 exchanges, 58 queues, 71 bindings) + `topology-assert` CLI; 38 event payload schemas + AsyncAPI 3.0; OpenAPI 3.1 public gateway (79 ops) + 8 internal service specs (103 HTTP ops + consumer actions); `make contracts` (validate → deterministic TS/Pydantic codegen → drift gate, `ci/contract.sh`, CI `contract` stage); V1 baseline migrations for 5 schemas + Flyway runner image + `make migrate`; Events Service Mongo migrations; `tests/` system-test workspace (25 migration integration tests).
- Phase 0 scaffold: Node workspace (pnpm 12, TS 6.0.3, ESLint 10, Prettier, Vitest), uv workspace (Ruff, mypy strict, pytest), Gradle 9.9.2 wrapper (Java 25, checksum-pinned), `Makefile` (§9.5 targets; later-phase targets fail loudly).
- Local compose infrastructure: PostgreSQL 18 (schema-per-service roles), MongoDB 8 rs0 (keyFile, scoped users), Redis 8 (per-service ACLs), RabbitMQ 4 (least-privilege users), SeaweedFS 4.54, ClamAV, OpenObserve; `scripts/dev/gen-local-secrets.sh`, `scripts/dev/compose-wait.sh`, `make env|up|down|reset`.
- CI guardrails: `ci/check-boundaries.sh`, `ci/check-migrations.sh`, `ci/check-resource-budget.sh`, `ci/check-layer-sizes.sh`, plus `ci/tests/run.sh` (10 self-tests); lint/test runners; `.gitlab-ci.yml` skeleton (.pre/lint/test); Gitleaks pre-commit hook.
- `scripts/dev/objectstore_compat.py` / `make objectstore-compat` (ADR-0011 S3 checks).
- Model routing policy in `CLAUDE.md`; review agents pinned to models (architecture-reviewer → sonnet, security-reviewer → opus, spec-tracer → haiku).

### Docs
- `PROJECT.md` v1.0: authoritative master document, built from `docs/AEGIS_PULSE.md` and `docs/PROJECT_TEMPLATE_GUIDE.md` and adapted to the homelab k3s and GitLab target in `docs/K3S_CONTEXT.md`. It defines 117 functional requirements across 21 domains, NFR-01–NFR-18, 21 implementation phases, full DDL, API and error contracts, messaging topology, and the event catalog.
- AI governance: `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` (12 role skills and 5 workflow skills), `.claude/agents/` (3 review agents), `.claude/hooks/` (migration, generated-code, and secret-file guards), and the GitLab merge request template.
- Session recorder hook (`.claude/hooks/session_log.py`) logs prompts, responses, tool and file summaries, compaction summaries, and timestamps to `docs/sessions/`.
- Steering documents: `docs/steering/{product,tech,structure,quality}.md`.
- ADR-0001 through ADR-0012, plus spec and evidence templates.

### Changed
- Cluster topology (ADR-0015): the storage node is now `optiplex-tower` (8 vCPU / 30 GiB / 1 TB data SSD); `optiplex` becomes the app-compute worker; NFR-03 and §5.4 budgets are expressed per tier (compute/storage) with unchanged numbers. PROJECT.md §1.5, NFR-03, NFR-12, §4.3, §5.3, §5.4, §9.3, Phase 9, §13.1, and A18 are amended. K3S_CONTEXT, CLAUDE.md, the kubernetes-platform skill (which gains a troubleshooting-access section) and the systems-architect skill are updated.
- PROJECT.md (Phase 1a): uniform internal RPC route `POST /internal/v1/{action}`; `aegispulse.dlx` is a topic exchange; one retry queue per distinct delay; enrichment-timer delay queue; `mig_events` Mongo principal; RLS helpers + history-protection callback; added actions `registry.listServiceAccounts`, `cases.getTransactionEvaluation`; gateway SERVICE-token cases and unauthenticated `issueClientCredentialsToken`; `/v1/openapi.json` route.
- Dependencies: `amqplib` pinned to 2.4.0 (2.4.1 was hours old and tripped pnpm's minimum-release-age policy; the auto-added bypass was removed); pnpm build scripts allowed for `esbuild` only.
- ADR-0011 accepted: SeaweedFS 4.54 (MinIO community image no longer published). Version baselines updated: NestJS 12, TypeScript 6.0.3 (TS 7 deferred, typescript-eslint peer range <6.1), pnpm 12, Spring Boot 4.2.
- ADR-0013: the gateway is now NestJS on `@nestjs/platform-fastify`, renamed `gateway/fastify-http` → `gateway/nest-http` everywhere (PROJECT.md §6.1/§6.3/§12, CLAUDE.md, AGENTS.md, steering, skills, agents, ADR-0001/0002). Internal service adapters stay plain Fastify.
- `docs/PROJECT_TEMPLATE_GUIDE.md`: new "AI Governance & Consistency Constructs" section, plus checklist and quality-bar items.

- ADR-0014: `dev` (`aegispulse-dev`, `*.rmwhs-dev.space`) and `prod` (`aegispulse`, `*.rmwhs.com`) environments on the same cluster and Cloudflare tunnel. `main` auto-deploys to dev, and prod receives the same digests by manual or tag promotion. Active DAST, chaos, and resets are dev only. Applied across PROJECT.md, CLAUDE.md, ADR-0006/0007/0012, skills, and evidence templates.

### Status
- Platform: ADR-0015 node roles applied on the cluster and runtime-verified (data SSD mounted under the local-path directory on `optiplex-tower`, storage taint moved, `optiplex` relabelled worker, PVC smoke test on the SSD) — [evidence](docs/evidence/platform-node-roles.md).
- Phase 1: slice 1a `INTEGRATION-VERIFIED` (contracts + data foundations) — [evidence](docs/evidence/phase-01a.md); slices 1b–1e pending.
- Phase 0: `SOURCE-IMPLEMENTED`, local runtime verified on macOS. First GitLab pipeline and a Linux `make up` run are pending ([evidence](docs/evidence/phase-00.md)). All FRs: `PENDING`.
