# Session Logs

A project hook (`.claude/hooks/session_log.py`, configured in `.claude/settings.json`) records every Claude Code session here automatically:

| File | Contents |
|---|---|
| `INDEX.md` | One row per session: start time, session id, link, first prompt |
| `YYYY-MM-DD_<session8>.md` | Readable trail: session start/end, every prompt, every response, per-turn tool and file summary, compaction summaries |
| `YYYY-MM-DD_<session8>.jsonl` | The same records as machine-readable JSON lines |

The hook never blocks a session. Its own errors go to `.errors.log`, which is gitignored. Common secret patterns are masked before writing, but review logs before committing anyway: Gitleaks scans them in CI.

These logs record *what was discussed*. Decisions still have to land in `PROJECT.md` and the ADRs to take effect.
