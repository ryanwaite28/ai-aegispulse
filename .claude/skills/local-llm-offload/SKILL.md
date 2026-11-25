---
name: local-llm-offload
description: Route low-judgment, high-volume parts of AegisPulse plan execution to the local Ollama models to save Claude usage. Use before reading a large test/build/CI log, a long diff, a long file, or big grep/find output only to locate something; and to draft CHANGELOG entries or test skeletons for pure domain code. Suites run through `make test-*-brief` by default. Not for security-critical code, contracts, migrations, decisions, or evidence.
---

# Local LLM Offload — AegisPulse

Policy: `docs/steering/local-llm.md` (read it once per session if unsure). Config: `.claude/ollama/routing.toml`.
CLI (stdlib Python): `python3 scripts/llm/ollama_offload.py <check|tasks|run|stats>`.

## Decide: offload or not
Offload when **all** of these are true:
1. The input is large (about 150+ lines or 8+ KB) **or** the output is a routine draft (CHANGELOG, test skeleton). Write commit messages yourself: you already know what changed.
2. The job is condensing, locating, extracting or drafting, not deciding.
3. No path involved is security-critical, a contract, or a migration (the CLI refuses most of these anyway).

Otherwise do it yourself. Small files are cheaper to `Read` directly, because a summary would only make you read them again to verify.

## Recipes (run from the repo root)
| Situation | Command |
|---|---|
| Running a suite (the default) | `BRIEF_LOG_DIR="$SCRATCH" make test-unit-brief` (also `test-integration-brief`, `test-e2e-brief`): exit code + log path + local triage, tail -60 fallback |
| Test/build output is long | `make test-unit > "$SCRATCH/unit.log" 2>&1; python3 scripts/llm/ollama_offload.py run summarize-log -f "$SCRATCH/unit.log"` |
| Pipe a command directly | `docker compose logs cases --since 10m 2>&1 \| python3 scripts/llm/ollama_offload.py run summarize-log --stdin` |
| Orient in a big diff before review | `python3 scripts/llm/ollama_offload.py run summarize-diff --diff main` |
| Outline a long file before editing a part | `python3 scripts/llm/ollama_offload.py run summarize-file -f PROJECT.md -q "§11 Phase 9 checklist"` |
| Inventory from grep | `grep -rn "FR-CASE-" --include=*.test.ts . \| python3 scripts/llm/ollama_offload.py run inventory --stdin -q "which FR-CASE ids have tests"` |
| CHANGELOG draft | `python3 scripts/llm/ollama_offload.py run changelog --diff main` |
| Test skeleton (pure domain code only) | `python3 scripts/llm/ollama_offload.py run test-scaffold -f services/cases/.../domain/Policy.java -q FR-CASE-04` |
| Structured fact pull | `python3 scripts/llm/ollama_offload.py run extract -f docs/evidence/phase-08g.md -q "list commands run and their exit codes"` |

`$SCRATCH` is the session scratchpad directory. Keep logs there, not in the repo. Use `-m deep` to escalate one run to the bigger model, and `-o FILE` to write the answer to a file.

## Using the answer
- The first line is the header. **DRAFT** means: review, fix, then use. You own every line that lands in the repo.
- A summary is a lead. Confirm each fact you act on with a narrow `grep -n` or a `Read` with offset and limit. Then re-run the narrowed failing test yourself; that run, not the summary, is the evidence.
- If the answer is vague, wrong, or invents names, don't retry more than once. Do the task yourself and note it, so the task profile can be tuned.

## Fallback
- Exit 3 (Ollama down or model missing): do the task in Claude now. Mention `make llm-setup` once per session and don't wait on it.
- Exit 2 (refused or too large): narrow the input (`tail -n 400`, one package, one function). If it was refused as security-critical, do it with the full model.

## Never
- Pipe `.env`, Infisical, `kubectl get secret`, or token-bearing output into it.
- Use local output as phase evidence, a test result, or a status claim (`PROJECT.md` §11.0).
- Route architecture, ADR, `PROJECT.md`, product or decision-protocol judgments, or security review, to it.
