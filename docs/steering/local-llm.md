# Steering — Local LLM Offload (Ollama)

> Workstation tooling for Claude Code sessions. It saves Claude subscription usage on low-judgment, high-volume work.
> It is **not** part of the platform: no service, image, pipeline job, or cluster uses it, and it adds nothing to `PROJECT.md` §5/§10.
> Config: `.claude/ollama/routing.toml` · CLI: `scripts/llm/ollama_offload.py` · Skill: `.claude/skills/local-llm-offload/` · Make: `llm-setup`, `llm-check`, `llm`, `llm-stats`.

## Why it saves usage
Claude usage is spent on tokens that enter the session context and on tokens Claude writes. The local model helps in two ways:
1. **Context it keeps out (biggest win).** A 4,000-line test log, a 60 KB diff, or a 1,500-line file is condensed locally. Claude reads a 30-line summary instead of the raw text.
2. **Drafts it writes.** Commit messages, CHANGELOG entries, and test skeletons are drafted locally. Claude reviews and edits them, which costs fewer tokens than writing from scratch.

It does **not** pay off for small inputs (under about 150 lines: just read them) or for work where Claude must re-read the whole source anyway to verify the draft.

## Routing ladder
Use the cheapest tier that still meets `docs/steering/quality.md`:

| Tier | Use for | Never for |
|---|---|---|
| **Local, `fast`** (`qwen2.5-coder:7b`, about 5–20 s) | Condensing logs, diffs, files and grep output; inventories; JSON extraction; CHANGELOG drafts | Decisions, final status claims |
| **Local, `deep`** (`qwen2.5-coder:14b`, about 1–2 min) | Commit-message drafts (in trials, 7b copied FR ids from unchanged context lines), test skeletons for pure domain code, code explanations, Q&A over a given input | Security-critical code, contracts, migrations |
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
- **DRAFT** output (commit-msg, changelog, test-scaffold, ask) is reviewed and edited by Claude before it is used. Claude stays responsible for every line written to the repo.
- **Summaries** are leads. Before acting on a claim (a failing test name, a `file:line`), confirm it with a targeted `grep` or `Read` of just that spot. That costs much less than reading the whole input.
- Never quote local output as a test result. Re-run the narrowed command instead.

## Failure handling
| Exit | Meaning | Action |
|---|---|---|
| 0 | ok | use per the rules above |
| 2 | refused (guard, unknown task, input too large for a single-window task) | narrow the input, or do the task in Claude if it is guarded |
| 3 | Ollama down or model not pulled | do the task in Claude (Haiku-class). Never block on it; suggest `make llm-setup` once |

## Hardware and models
- Workstation: Apple M5, 24 GB unified memory, shared with the compose stack. `keep_alive = "10m"` unloads idle models. `num_ctx = 16384` and `chunk_chars = 24000` keep each request inside one window, and larger inputs are map-reduced.
- Swap models by editing `[models]` in `routing.toml`, then `make llm-setup`. Raise the `deep` tier only if memory allows with `make up` running.
- `make llm-stats` estimates how many tokens were kept out of Claude context. Use it to decide whether a task profile is worth keeping.
