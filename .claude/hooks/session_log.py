#!/usr/bin/env python3
"""AegisPulse session recorder (Claude Code hook).

Usage (from .claude/settings.json):  session_log.py <EventName>
Reads the hook JSON payload on stdin and appends to:
  docs/sessions/<YYYY-MM-DD>_<session8>.md      human-readable trail
  docs/sessions/<YYYY-MM-DD>_<session8>.jsonl   raw machine-readable records
  docs/sessions/INDEX.md                        one line per session

Events handled: SessionStart, UserPromptSubmit, Stop, PreCompact, PostCompact, SessionEnd.
Never blocks Claude: any internal error is written to docs/sessions/.errors.log and exit 0.
Secrets: values matching common secret patterns are masked before writing (PROJECT.md §12 rule 6).
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import subprocess
import sys
import traceback
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("CLAUDE_PROJECT_DIR") or os.getcwd())
LOG_DIR = ROOT / "docs" / "sessions"
MAX_TEXT = 20_000  # per block, keeps logs readable

SECRET_PATTERNS = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"gh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"glpat-[A-Za-z0-9_-]{20,}"),
    re.compile(r"sk-ant-[A-Za-z0-9_-]{20,}"),
    re.compile(r"(?i)((?:api[_-]?key|secret|password|token)\s*[:=]\s*)['\"]?[^\s'\"]{12,}"),
]


def mask(text: str) -> str:
    for pat in SECRET_PATTERNS:
        text = pat.sub(lambda m: (m.group(1) if m.groups() else "") + "[REDACTED]", text)
    return text


def clip(text: str) -> str:
    text = mask(text or "")
    return text if len(text) <= MAX_TEXT else text[:MAX_TEXT] + f"\n…[truncated {len(text) - MAX_TEXT} chars]"


def now_iso() -> str:
    return dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def git(*args: str) -> str:
    try:
        return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        return ""


def session_paths(session_id: str) -> tuple[Path, Path]:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    short = (session_id or "unknown")[:8]
    existing = sorted(LOG_DIR.glob(f"*_{short}.md"))
    stem = existing[0].stem if existing else f"{dt.date.today().isoformat()}_{short}"
    return LOG_DIR / f"{stem}.md", LOG_DIR / f"{stem}.jsonl"


def append(path: Path, text: str) -> None:
    with path.open("a", encoding="utf-8") as fh:
        fh.write(text)


def record(jsonl: Path, event: str, data: dict[str, Any]) -> None:
    append(jsonl, json.dumps({"ts": now_iso(), "event": event, **data}, ensure_ascii=False) + "\n")


def is_human_prompt(entry: dict[str, Any]) -> bool:
    if entry.get("type") != "user" or entry.get("isSidechain"):
        return False
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    if isinstance(content, list):
        return any(isinstance(c, dict) and c.get("type") == "text" for c in content) and not any(
            isinstance(c, dict) and c.get("type") == "tool_result" for c in content
        )
    return False


def last_turn(transcript_path: str) -> dict[str, list[str]]:
    """Assistant text, tools used, and files touched since the last human prompt."""
    out: dict[str, list[str]] = {"text": [], "tools": [], "files": []}
    p = Path(transcript_path or "")
    if not p.is_file():
        return out
    entries = []
    with p.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    start = 0
    for i, e in enumerate(entries):
        if is_human_prompt(e):
            start = i
    for e in entries[start:]:
        if e.get("type") != "assistant" or e.get("isSidechain"):
            continue
        for c in (e.get("message") or {}).get("content") or []:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "text" and c.get("text", "").strip():
                out["text"].append(c["text"].strip())
            elif c.get("type") == "tool_use":
                name = c.get("name", "?")
                inp = c.get("input") or {}
                out["tools"].append(name)
                fp = inp.get("file_path") or inp.get("notebook_path")
                if fp and name in {"Write", "Edit", "MultiEdit", "NotebookEdit"}:
                    out["files"].append(os.path.relpath(fp, ROOT) if fp.startswith(str(ROOT)) else fp)
    return out


def update_index(md: Path, session_id: str, title: str) -> None:
    idx = LOG_DIR / "INDEX.md"
    if not idx.exists():
        idx.write_text(
            "# Session Log Index\n\n"
            "One row per Claude Code session. Written automatically by `.claude/hooks/session_log.py`.\n\n"
            "| Started (UTC) | Session | Log | First prompt |\n|---|---|---|---|\n",
            encoding="utf-8",
        )
    if md.name in idx.read_text(encoding="utf-8"):
        return
    append(idx, f"| {now_iso()} | `{session_id[:8]}` | [{md.name}]({md.name}) | {title} |\n")


def main() -> None:
    event = sys.argv[1] if len(sys.argv) > 1 else "Unknown"
    raw = sys.stdin.read()
    payload = json.loads(raw) if raw.strip() else {}
    sid = payload.get("session_id", "unknown")
    md, jsonl = session_paths(sid)
    ts = now_iso()

    if not md.exists():
        append(
            md,
            f"# Session `{sid}`\n\n- **Project:** AegisPulse\n- **Started:** {ts}\n"
            f"- **Branch / SHA:** {git('rev-parse', '--abbrev-ref', 'HEAD') or 'n/a'} / "
            f"{git('rev-parse', '--short', 'HEAD') or 'no commits'}\n"
            f"- **Transcript:** `{payload.get('transcript_path', '')}`\n\n---\n",
        )

    if event == "SessionStart":
        src = payload.get("source", "")
        append(md, f"\n### 🟢 Session start — {ts} ({src})\n")
        record(jsonl, event, {"source": src, "sha": git("rev-parse", "HEAD")})

    elif event == "UserPromptSubmit":
        prompt = clip(payload.get("prompt", ""))
        append(md, f"\n## 🧑 Prompt — {ts}\n\n{prompt}\n")
        record(jsonl, event, {"prompt": prompt})
        first_line = re.sub(r"\s+", " ", prompt).strip()[:100].replace("|", "\\|")
        update_index(md, sid, first_line)

    elif event == "Stop":
        if payload.get("stop_hook_active"):
            return
        turn = last_turn(payload.get("transcript_path", ""))
        text = payload.get("last_assistant_message") or "\n\n".join(turn["text"])
        text = clip(text)
        tools: dict[str, int] = {}
        for t in turn["tools"]:
            tools[t] = tools.get(t, 0) + 1
        files = sorted(set(turn["files"]))
        summary = ", ".join(f"{k} x{v}" for k, v in sorted(tools.items())) or "none"
        block = (
            f"\n## 🤖 Response — {ts}\n\n{text or '_(no text output)_'}\n\n"
            f"<details><summary>Turn summary</summary>\n\n- **Tools used:** {summary}\n"
        )
        if files:
            block += "- **Files written/edited:**\n" + "".join(f"  - `{f}`\n" for f in files)
        block += "\n</details>\n"
        append(md, block)
        record(jsonl, event, {"response": text, "tools": tools, "files": files})

    elif event == "PreCompact":
        trig, instr = payload.get("trigger", ""), clip(payload.get("custom_instructions") or "")
        append(
            md,
            f"\n### 🗜️ Compaction starting — {ts} (trigger: {trig})\n" + (f"\nInstructions: {instr}\n" if instr else ""),
        )
        record(jsonl, event, {"trigger": trig, "custom_instructions": instr})

    elif event == "PostCompact":
        summ = clip(payload.get("summary") or payload.get("compact_summary") or payload.get("compaction_summary") or "")
        append(
            md,
            f"\n### 🗜️ Compaction summary — {ts}\n\n<details><summary>Summary</summary>\n\n"
            f"{summ or '_(summary not provided by hook payload)_'}\n\n</details>\n",
        )
        record(jsonl, event, {"summary": summ})

    elif event == "SessionEnd":
        reason = payload.get("reason", "")
        append(md, f"\n### 🔴 Session end — {ts} (reason: {reason})\n")
        record(jsonl, event, {"reason": reason})

    else:
        record(jsonl, event, {"payload_keys": sorted(payload.keys())})


if __name__ == "__main__":
    try:
        main()
    except Exception:  # never block Claude
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        append(LOG_DIR / ".errors.log", f"{now_iso()} {sys.argv[1:]}\n{traceback.format_exc()}\n")
    sys.exit(0)
