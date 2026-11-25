# Local Ollama Inference Context for VS Code

## 1. Endpoint & Transport
- **Inference Host:** `optiplex-tower` over Tailscale VPN (`tailscale0`)
- **Ollama Native API URL:** `http://100.80.6.92:11434`
- **OpenAI-Compatible API URL:** `http://100.80.6.92:11434/v1` (use dummy API key `ollama` if a client requires a non-empty key)
- **Model Storage Path:** `/mnt/data/ai-models/ollama` (`/dev/sdc`)
- **Compute Profile:** CPU-only inference (`30.2 GiB` total RAM, `~23 GiB` available alongside `k3s` workloads)

## 2. Installed Models & Routing Matrix
Always match model names **exact to `ollama list`**, including tags:

| Model Tag | Size | Role in VS Code | Recommended `num_ctx` | Notes |
| :--- | :--- | :--- | :--- | :--- |
| `qwen2.5-coder:1.5b` | 986 MB | Tab autocomplete / Fill-in-the-Middle (FIM) & quick inline edits | `2048`–`4096` | Fastest cold load and token speed on CPU; no reasoning-token lag. |
| `nomic-embed-text:latest` | 274 MB | Local codebase indexing & semantic retrieval (`@codebase` / RAG) | `2048`–`8192` | Small footprint for repo embeddings; keep `OLLAMA_MAX_LOADED_MODELS=2` if paired with a chat model. |
| `qwen3:8b` | 5.2 GB | General chat, shell/YAML/k3s manifests, & tool calling | `4096`–`8192` | Enables thinking mode by default, adding reasoning tokens before final output. |
| `deepseek-coder-v2:16b` | 8.9 GB | Mid-weight code generation, refactoring & multi-language edits | `4096`–`8192` | MoE architecture keeps per-token compute lighter than dense 16B+ models. |
| `gpt-oss:20b` | 13 GB | Tricky debugging, root-cause analysis & structured reasoning | `4096`–`8192` | MoE reasoning model; use for hard bugs rather than quick completions. |
| `devstral:24b` | 14 GB | Multi-file software engineering & repo issue workflows | `8192`–`16384` | Dense 24B model; higher quality on repo diffs but slower per token on CPU. |
| `qwen3-coder:30b` | 18 GB | Heavy agentic coding & complex multi-file changes | `8192`–`16384` | MoE (~3.3B active params); strong agent coding speed once loaded, but watch RAM headroom. |

## 3. CPU & Memory Guardrails (Protect `k3s` & Avoid OOM)
1. **Bound `num_ctx`:** Do not leave context windows unbounded or cranked to 32K–128K on CPU. KV-cache RAM grows with context size and can squeeze `k3s` pods when large models (`13–18 GB`) are active.
2. **Avoid parallel heavy models:** Keep `OLLAMA_MAX_LOADED_MODELS=1` on `optiplex-tower` for normal coding so switching models unloads the prior model; only set `2` if actively running `nomic-embed-text:latest` alongside a chat model.
3. **Expect cold-start latency:** First request after `OLLAMA_KEEP_ALIVE=2m` expires (or after a model swap) includes model load time from disk into RAM. Keep prompts focused and break large refactors into smaller steps.

## 4. VS Code Extension Setup Patterns

### Pattern A: Continue (`~/.continue/config.yaml`)
Use role-based routing so autocomplete stays fast while chat/agent and embeddings use dedicated models:

```yaml
name: Optiplex Ollama Setup
version: 1.0.0
schema: v1

models:
  - name: Qwen3 Coder 30B (Agent)
    provider: ollama
    apiBase: http://100.80.6.92:11434
    model: qwen3-coder:30b
    roles:
      - chat
      - edit
      - apply
    defaultCompletionOptions:
      numCtx: 8192

  - name: Qwen3 8B (General / Tools)
    provider: ollama
    apiBase: http://100.80.6.92:11434
    model: qwen3:8b
    roles:
      - chat
      - edit
    defaultCompletionOptions:
      numCtx: 8192

  - name: GPT-OSS 20B (Debugging)
    provider: ollama
    apiBase: http://100.80.6.92:11434
    model: gpt-oss:20b
    roles:
      - chat
    defaultCompletionOptions:
      numCtx: 8192

  - name: Qwen2.5 Coder 1.5B (Autocomplete)
    provider: ollama
    apiBase: http://100.80.6.92:11434
    model: qwen2.5-coder:1.5b
    roles:
      - autocomplete
    defaultCompletionOptions:
      numCtx: 2048

  - name: Nomic Embed (Codebase RAG)
    provider: ollama
    apiBase: http://100.80.6.92:11434
    model: nomic-embed-text:latest
    roles:
      - embed

## 5. Use by Claude Code sessions (offload CLI)
Claude Code sessions can use this server for the same bounded condensing tasks as the local Ollama (`docs/steering/local-llm.md`, "Homelab server"): export `OLLAMA_REMOTE_HOST=http://<tailscale-ip>:11434` in the shell (the address is never committed to `routing.toml`) and pass `--remote` to `scripts/llm/ollama_offload.py check|run`.
- Routed models are only `qwen3:8b` (`fast`) and `deepseek-coder-v2:16b` (`deep`), with `num_ctx` 8192. `gpt-oss:20b`, `devstral:24b` and `qwen3-coder:30b` are never used for offload: `optiplex-tower` is the k3s storage node (ADR-0015) and its RAM is shared with the dev and prod data stores.
- Measured on 2026-11-25 (one 9.8 KB log, `summarize-log`): 240 s cold (model load from `/dev/sdc`), 24 s warm, against about 10 s on the workstation. It is overflow capacity for batches or for when the workstation's memory is tight, not a speedup.
