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
- Steering documents: `docs/steering/{product,tech,structure,quality}.md`.
- ADR-0001 through ADR-0012, plus spec and evidence templates.

### Status
- All FRs and phases are `PENDING`. No implementation code exists yet.
