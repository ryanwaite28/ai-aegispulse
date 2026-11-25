# Steering — Local LLM Offload (Ollama)

> Workstation tooling for Claude Code sessions. It saves Claude subscription usage on low-judgment, high-volume work.
> It is **not** part of the platform: no service, image, pipeline job, or cluster uses it, and it adds nothing to `PROJECT.md` §5/§10.
> Config: `.claude/ollama/routing.toml` · CLI: `scripts/llm/ollama_offload.py` · Skill: `.claude/skills/local-llm-offload/` · Make: `llm-setup`, `llm-check`, `llm`, `llm-stats`.

## Why it saves usage
Claude usage is spent on tokens that enter the session context and on tokens Claude writes. The local model helps in two ways:
1. **Context it keeps out (biggest win).** A 4,000-line test log, a 60 KB diff, or a 1,500-line file is condensed locally. Claude reads a 30-line summary instead of the raw text.
2. **Drafts it writes.** Commit messages, CHANGELOG entries, and test skeletons are drafted locally. Claude reviews and edits them, which costs fewer tokens than writing from scratch.

The cheap path is the default: `make test-unit-brief`, `test-integration-brief` and `test-e2e-brief` (script `scripts/llm/brief.sh`) run the suite, keep the full log in `BRIEF_LOG_DIR`, and print the exit code plus a local triage, falling back to `tail -60` when Ollama is unavailable. The project-manager definition of done points at them, so sessions save without having to remember the skill.

Commit messages are not offloaded (dropped 2026-11-25): Claude already knows what it changed, the 7b model invented FR ids in trials, and the 14b model took about 54 s per draft.

It does **not** pay off for small inputs (under about 150 lines: just read them) or for work where Claude must re-read the whole source anyway to verify the draft.

## Routing ladder
Use the cheapest tier that still meets `docs/steering/quality.md`:

| Tier | Use for | Never for |
|---|---|---|
| **Local, `fast`** (`qwen2.5-coder:7b`, about 5–20 s) | Condensing logs, diffs, files and grep output; inventories; JSON extraction; CHANGELOG drafts | Decisions, final status claims |
| **Local, `deep`** (`qwen2.5-coder:14b`, about 1–2 min) | Test skeletons for pure domain code, code explanations, Q&A over a given input | Security-critical code, contracts, migrations |
| Haiku | Same class of work when Ollama is unavailable (exit 3), or when the result must be exact on the first try | |
| Sonnet / Opus | Per the CLAUDE.md model-routing table | |

## Never route to the local model
- **Security-critical code** (CLAUDE.md: Opus only): auth, guards, JWT/JWKS, webhook HMAC, SSRF, RLS, redaction, audit chain, network policy, CI. Code-writing tasks (`code = true`) refuse the `[guard].security_paths`.
- **Decisions** reserved for the skills: architecture, ADRs, `PROJECT.md` amendments, product or decision-protocol calls, phase status.
- **Evidence and status.** Evidence files, §11 checklist marks, and ledger states come from commands Claude ran itself. A local summary of a log is a pointer to where to look, not evidence.
- **Contracts and migrations** (`packages/contracts/**`, `**/db/migration*/**`).
- **Secret material.** `[guard].deny_paths` are never read. Credential-shaped strings are redacted on the way in and on the way out. Never pipe `.env`, Infisical output, or `kubectl get secret` output into it.

## Verification duty
- Every answer starts with a header line: `[ollama <model> · task=… · in→out chars · secs · DRAFT|local summary]`.
- **DRAFT** output (changelog, test-scaffold, ask) is reviewed and edited by Claude before it is used. Claude stays responsible for every line written to the repo.
- **Summaries** are leads. Before acting on a claim (a failing test name, a `file:line`), confirm it with a targeted `grep` or `Read` of just that spot. That costs much less than reading the whole input.
- Never quote local output as a test result. Re-run the narrowed command instead.

## Failure handling
| Exit | Meaning | Action |
|---|---|---|
| 0 | ok | use per the rules above |
| 2 | refused (guard, unknown task, input too large for a single-window task) | narrow the input, or do the task in Claude if it is guarded |
| 3 | Ollama down or model not pulled | do the task in Claude (Haiku-class). Never block on it; suggest `make llm-setup` once |

## Homelab server (optional, `--remote`)
`docs/OLLAMA_HOMELAB_SERVER.md` describes a second Ollama on `optiplex-tower` (CPU-only, Tailscale). The offload CLI can use it with `--remote` (`check` and `run`); the `[remote]` profile in `routing.toml` gives it its own tiers and limits, and the address comes from `OLLAMA_REMOTE_HOST` (never committed).

| | Workstation (default) | Homelab (`--remote`) |
|---|---|---|
| `fast` / `deep` | `qwen2.5-coder:7b` / `:14b` | `qwen3:8b` (thinking off) / `deepseek-coder-v2:16b` |
| `num_ctx` / `chunk_chars` | 16384 / 24000 | 8192 / 14000 |
| Measured, one 9.8 KB log | about 10 s | 240 s cold, 24 s warm (2026-11-25) |

When to use it: a batch of condensing calls (the model stays warm for the server's 2 min keep-alive), or the workstation is short on memory (compose stack up plus a large model). Not for a single quick call: the cold load costs minutes. Exit 3 (no env var, server down, model missing) falls back to Claude like any unavailable server.

Why it is bounded: `optiplex-tower` is the k3s storage node (ADR-0015) that hosts the dev and prod data stores, and the 23 GiB of free RAM is shared with them. So only the two small models above are routed, context stays at or below 8192, and `gpt-oss:20b`, `devstral:24b` and `qwen3-coder:30b` (13 to 18 GB) are never used for offload. The same guards apply as locally: secret paths are never read and credential shapes are redacted in both directions. Everything sent stays on the owner's tailnet.

The server doc's other models and the VS Code (Continue) setup are for interactive use in the editor, not for this CLI.

## Candidate models (installed, not routed)
Installed on the workstation alongside the two routed tiers. Facts are from `ollama show`; **none has been benchmarked for these tasks**, so none is routed. Quality, speed and memory behaviour with the compose stack up are unknown until measured.

| Model | Params / quant | Disk | Capabilities | Note |
|---|---|---|---|---|
| `mimo-v2.6:latest` | 9.4B · nvfp4 | 8.7 GB | thinking, vision, tools | The only one that plausibly fits beside `make up` (similar size to `deep`). First candidate for a `fast`/`deep` swap. |
| `qwen3.8:latest` | 27.8B · nvfp4 | 18 GB | thinking, vision, tools | About 75% of the 24 GB unified memory: run only with the compose stack down. |
| `flint:latest` | 39.8B · int4 | 22 GB | thinking, tools | About 90% of the 24 GB: do not load while the stack is up. |

Rules:
- **Thinking is off by default** (`[server].think = false` in `routing.toml`, sent on every request). These models otherwise spend hidden reasoning tokens on routine condensing. Enable it only for a deliberate one-off experiment.
- **Try, don't switch.** Use `-m <tag>` for a single run. Promote a model into `[models]` (and `make llm-setup`) only after comparing it with the current tier on the same real log and diff (accuracy of failure names and `file:line`, seconds, and `vm_stat` / the compose stack staying healthy).
- **Never load `qwen3.8` or `flint` with the stack up.** Memory pressure can stall the stack and the session. A model loaded for a trial unloads after `keep_alive` (10 min idle).
- None of them changes the "never route" list above: security-critical code, contracts, migrations, decisions and evidence stay out.

## Hardware and models
- Workstation: Apple M5, 24 GB unified memory, shared with the compose stack. `keep_alive = "10m"` unloads idle models. `num_ctx = 16384` and `chunk_chars = 24000` keep each request inside one window, and larger inputs are map-reduced.
- Swap models by editing `[models]` in `routing.toml`, then `make llm-setup`. `make llm-setup` pulls only the models named in `[models]`; candidate models are installed by hand with `ollama pull`. Raise the `deep` tier only if memory allows with `make up` running.
- `make llm-stats` estimates how many tokens were kept out of Claude context. It credits only tasks marked `replaces_read` (logs, files, diffs, inventories, extraction, explanations), where Claude would otherwise have read the input; drafts are listed but not credited. The estimate is still a proxy: to measure the real effect, compare `/cost` across two similar slices, one with offload and one without.
