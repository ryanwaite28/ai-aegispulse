# AegisPulse

**Distributed Risk, Regulatory & Market Intelligence Platform.** A portfolio-grade, multi-tenant, event-driven microservices system in TypeScript, Java, and Python. It runs RabbitMQ, PostgreSQL, MongoDB, Redis, and S3-compatible storage on homelab Kubernetes, with a full DevSecOps pipeline.

> Status: **planning baseline (v1.0 of the master document)**. No implementation exists yet. See the status ledger in [PROJECT.md §11.0](PROJECT.md#110-completion-gate-evidence--status-ledger).

| Document | Purpose |
|---|---|
| [PROJECT.md](PROJECT.md) | **Single source of truth**: requirements, architecture, data model, APIs, DevOps, plan |
| [CLAUDE.md](CLAUDE.md) · [AGENTS.md](AGENTS.md) | Rules for AI coding assistants |
| [CHANGELOG.md](CHANGELOG.md) | Change and status history |
| [docs/steering/](docs/steering/) | Product, tech (pinned versions), structure, quality bar |
| [docs/adr/](docs/adr/) | Architecture decision records |
| [docs/specs/](docs/specs/) · [docs/evidence/](docs/evidence/) | Per-FR specs and phase-exit evidence |
| [docs/AEGIS_PULSE.md](docs/AEGIS_PULSE.md) | Original concept brief |
| [docs/K3S_CONTEXT.md](docs/K3S_CONTEXT.md) | Target cluster and deployment standard |

Quick start (once Phase 0 lands): `make bootstrap && make env && make up && make migrate && make seed`.
