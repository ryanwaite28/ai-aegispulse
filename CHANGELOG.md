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

### Docs
- `PROJECT.md` v1.0: authoritative master document, built from `docs/AEGIS_PULSE.md` and `docs/PROJECT_TEMPLATE_GUIDE.md` and adapted to the homelab k3s and GitLab target in `docs/K3S_CONTEXT.md`. It defines 117 functional requirements across 21 domains, NFR-01–NFR-18, 21 implementation phases, full DDL, API and error contracts, messaging topology, and the event catalog.
- AI governance: `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` (12 role skills and 5 workflow skills), `.claude/agents/` (3 review agents), `.claude/hooks/` (migration, generated-code, and secret-file guards), and the GitLab merge request template.
- Session recorder hook (`.claude/hooks/session_log.py`) logs prompts, responses, tool and file summaries, compaction summaries, and timestamps to `docs/sessions/`.
- Steering documents: `docs/steering/{product,tech,structure,quality}.md`.
- ADR-0001 through ADR-0012, plus spec and evidence templates.

### Changed
- ADR-0013: the gateway is now NestJS on `@nestjs/platform-fastify`, renamed `gateway/fastify-http` → `gateway/nest-http` everywhere (PROJECT.md §6.1/§6.3/§12, CLAUDE.md, AGENTS.md, steering, skills, agents, ADR-0001/0002). Internal service adapters stay plain Fastify.
- `docs/PROJECT_TEMPLATE_GUIDE.md`: new "AI Governance & Consistency Constructs" section, plus checklist and quality-bar items.

- ADR-0014: `dev` (`aegispulse-dev`, `*.rmwhs-dev.space`) and `prod` (`aegispulse`, `*.rmwhs.com`) environments on the same cluster and Cloudflare tunnel. `main` auto-deploys to dev, and prod receives the same digests by manual or tag promotion. Active DAST, chaos, and resets are dev only. Applied across PROJECT.md, CLAUDE.md, ADR-0006/0007/0012, skills, and evidence templates.

### Status
- All FRs and phases are `PENDING`. No implementation code exists yet.
