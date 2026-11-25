"""Offload bounded, low-judgment work from Claude Code sessions to a local Ollama server.

Workstation tooling only (docs/steering/local-llm.md); the platform never imports or runs it.
Standard library only, so it works before `uv sync` and costs nothing to start.

Usage:
  ollama_offload.py check                       # server + models reachable? (exit 3 = fall back to Claude)
  ollama_offload.py tasks                       # list task profiles from .claude/ollama/routing.toml
  ollama_offload.py run TASK [inputs] [-q Q]    # run one task; prints a header line, then the answer
  ollama_offload.py stats                       # estimated Claude context avoided so far

Inputs (combinable): -f/--file PATH (repeatable), --stdin, --diff [REV], --staged.

Exit codes: 0 ok · 2 usage error or guard refusal · 3 Ollama unavailable/model missing (do the task yourself).
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, NoReturn

REPO_ROOT = Path(__file__).resolve().parents[2]
CONFIG_PATH = REPO_ROOT / ".claude" / "ollama" / "routing.toml"
USAGE_PATH = REPO_ROOT / ".claude" / "ollama" / "usage.jsonl"

EXIT_OK = 0
EXIT_REFUSED = 2
EXIT_UNAVAILABLE = 3

# Redact credential-shaped strings before they reach the model or come back in its answer.
_REDACTIONS: tuple[tuple[re.Pattern[str], str], ...] = (
    (
        re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S),
        "[REDACTED:private-key]",
    ),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED:aws-key-id]"),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"), "[REDACTED:github-token]"),
    (re.compile(r"\bglpat-[A-Za-z0-9_\-]{20,}\b"), "[REDACTED:gitlab-token]"),
    (re.compile(r"\bsk-[A-Za-z0-9_\-]{20,}\b"), "[REDACTED:api-key]"),
    (re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b"), "[REDACTED:jwt]"),
    (re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-~+/]{16,}=*"), r"\1[REDACTED]"),
    (re.compile(r"(?i)\b([a-z]+://[^\s:/@]+:)[^\s@/]+@"), r"\1[REDACTED]@"),
    (
        re.compile(r"(?i)\b([A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)(\S+)"),
        r"\1[REDACTED]",
    ),
)


class OffloadError(Exception):
    def __init__(self, message: str, exit_code: int) -> None:
        super().__init__(message)
        self.exit_code = exit_code


@dataclass(frozen=True)
class Task:
    name: str
    model: str
    prompt: str
    draft: bool = False
    code: bool = False
    map_reduce: bool = False
    fmt: str = "text"
    temperature: float = 0.0
    replaces_read: bool = False


@dataclass(frozen=True)
class Config:
    host: str
    timeout_s: float
    keep_alive: str
    think: bool
    models: dict[str, str]
    chunk_chars: int
    max_input_chars: int
    num_ctx: int
    deny_paths: tuple[str, ...]
    security_paths: tuple[str, ...]
    tasks: dict[str, Task] = field(default_factory=dict)

    def model_tag(self, tier_or_tag: str) -> str:
        return self.models.get(tier_or_tag, tier_or_tag)


def load_config(path: Path = CONFIG_PATH) -> Config:
    raw = tomllib.loads(path.read_text(encoding="utf-8"))
    server, limits, guard = raw["server"], raw["limits"], raw["guard"]
    tasks = {
        name: Task(
            name=name,
            model=str(t["model"]),
            prompt=str(t["prompt"]).strip(),
            draft=bool(t.get("draft", False)),
            code=bool(t.get("code", False)),
            map_reduce=bool(t.get("map_reduce", False)),
            fmt=str(t.get("format", "text")),
            temperature=float(t.get("temperature", 0.0)),
            replaces_read=bool(t.get("replaces_read", False)),
        )
        for name, t in raw["tasks"].items()
    }
    return Config(
        host=os.environ.get("OLLAMA_HOST") or str(server["host"]),
        timeout_s=float(server.get("timeout_s", 300)),
        keep_alive=str(server.get("keep_alive", "10m")),
        think=bool(server.get("think", False)),
        models={k: str(v) for k, v in raw["models"].items()},
        chunk_chars=int(limits["chunk_chars"]),
        max_input_chars=int(limits["max_input_chars"]),
        num_ctx=int(limits["num_ctx"]),
        deny_paths=tuple(guard["deny_paths"]),
        security_paths=tuple(guard["security_paths"]),
        tasks=tasks,
    )


# --------------------------------------------------------------------------- guards


def _normalize_host(host: str) -> str:
    host = host.rstrip("/")
    return host if "://" in host else f"http://{host}"


def rel_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(REPO_ROOT).as_posix()
    except ValueError:
        return resolved.as_posix()


def matches_any(rel: str, patterns: tuple[str, ...]) -> bool:
    name = PurePosixPath(rel).name
    return any(fnmatch.fnmatchcase(rel, p) or fnmatch.fnmatchcase(name, p) for p in patterns)


def check_path(cfg: Config, task: Task, rel: str) -> None:
    if matches_any(rel, cfg.deny_paths):
        raise OffloadError(f"refused: '{rel}' is secret-bearing and never leaves the repo guard", EXIT_REFUSED)
    if task.code and matches_any(rel, cfg.security_paths):
        raise OffloadError(
            f"refused: '{rel}' is security-critical; code for it is written by Opus (CLAUDE.md model routing)",
            EXIT_REFUSED,
        )


def redact(text: str) -> str:
    for pattern, replacement in _REDACTIONS:
        text = pattern.sub(replacement, text)
    return text


# --------------------------------------------------------------------------- inputs


def _git(*args: str) -> str:
    result = subprocess.run(["git", "-C", str(REPO_ROOT), *args], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise OffloadError(f"git {' '.join(args)} failed: {result.stderr.strip()[:300]}", EXIT_REFUSED)
    return result.stdout


def gather_input(cfg: Config, task: Task, args: argparse.Namespace) -> str:
    parts: list[str] = []
    for f in args.file or []:
        path = Path(f)
        if not path.is_absolute():
            path = Path.cwd() / path
        rel = rel_path(path)
        check_path(cfg, task, rel)
        if not path.is_file():
            raise OffloadError(f"not a file: {f}", EXIT_REFUSED)
        parts.append(f"=== FILE {rel} ===\n{path.read_text(encoding='utf-8', errors='replace')}")
    if args.diff is not None or args.staged:
        rev = [] if args.diff in (None, "") else [args.diff]
        base = ["diff", "--staged"] if args.staged else ["diff", *rev]
        names = [n for n in _git(*base, "--name-only").splitlines() if n]
        safe = [n for n in names if not matches_any(n, cfg.deny_paths)]
        for n in safe:
            check_path(cfg, task, n)
        if safe:
            parts.append(f"=== GIT DIFF ({' '.join(base[1:]) or 'working tree'}) ===\n{_git(*base, '--', *safe)}")
    if args.stdin:
        parts.append(f"=== STDIN ===\n{sys.stdin.read()}")
    text = "\n\n".join(parts)
    if not text.strip():
        raise OffloadError("no input: pass --file, --stdin, --diff [REV] or --staged", EXIT_REFUSED)
    if len(text) > cfg.max_input_chars:
        raise OffloadError(
            f"input is {len(text)} chars (> {cfg.max_input_chars}); narrow it (tail/grep/one package) and retry",
            EXIT_REFUSED,
        )
    return redact(text)


def chunk(text: str, size: int) -> list[str]:
    """Split on line boundaries into pieces of at most `size` chars (a single longer line is hard-split)."""
    chunks: list[str] = []
    current: list[str] = []
    length = 0
    for line in text.splitlines(keepends=True):
        while len(line) > size:
            if current:
                chunks.append("".join(current))
                current, length = [], 0
            chunks.append(line[:size])
            line = line[size:]
        if length + len(line) > size and current:
            chunks.append("".join(current))
            current, length = [], 0
        current.append(line)
        length += len(line)
    if current:
        chunks.append("".join(current))
    return chunks


# --------------------------------------------------------------------------- ollama client


class Ollama:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.base = _normalize_host(cfg.host)

    def _request(self, path: str, body: dict[str, Any] | None, timeout: float) -> dict[str, Any]:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(  # noqa: S310 — host comes from the repo config / OLLAMA_HOST
            f"{self.base}{path}",
            data=data,
            headers={"Content-Type": "application/json"},
            method="GET" if body is None else "POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:  # noqa: S310
                parsed: dict[str, Any] = json.loads(resp.read().decode())
                return parsed
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode(errors="replace")[:300]
            raise OffloadError(f"ollama {path} HTTP {exc.code}: {detail}", EXIT_UNAVAILABLE) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError) as exc:
            raise OffloadError(f"ollama unreachable at {self.base}: {exc}", EXIT_UNAVAILABLE) from exc

    def installed(self) -> set[str]:
        tags = self._request("/api/tags", None, 5)
        return {str(m["name"]) for m in tags.get("models", [])}

    def require(self, tag: str) -> None:
        have = self.installed()
        if tag not in have and f"{tag}:latest" not in have:
            raise OffloadError(f"model '{tag}' not pulled (run: make llm-setup)", EXIT_UNAVAILABLE)

    def chat(self, model: str, system: str, user: str, temperature: float, fmt: str) -> str:
        body: dict[str, Any] = {
            "model": model,
            "stream": False,
            "keep_alive": self.cfg.keep_alive,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "options": {"temperature": temperature, "num_ctx": self.cfg.num_ctx},
            # Thinking models spend hidden reasoning tokens (time and RAM) on condensing; off unless [server].think.
            "think": self.cfg.think,
        }
        if fmt == "json":
            body["format"] = "json"
        reply = self._request("/api/chat", body, self.cfg.timeout_s)
        return str(reply.get("message", {}).get("content", "")).strip()


# --------------------------------------------------------------------------- task execution


def _user_message(question: str | None, payload: str, part: str = "") -> str:
    q = f"QUESTION: {question}\n\n" if question else ""
    return f"{q}INPUT{part}:\n{payload}"


def run_task(client: Ollama, cfg: Config, task: Task, text: str, question: str | None, model: str) -> str:
    if len(text) <= cfg.chunk_chars:
        return client.chat(model, task.prompt, _user_message(question, text), task.temperature, task.fmt)
    if not task.map_reduce:
        raise OffloadError(
            f"task '{task.name}' needs the whole input in one window: {len(text)} chars > {cfg.chunk_chars}; "
            "pass a smaller slice (one function/file)",
            EXIT_REFUSED,
        )
    pieces = chunk(text, cfg.chunk_chars)
    partials = [
        client.chat(
            model,
            task.prompt,
            _user_message(question, piece, f" (part {i}/{len(pieces)} of one larger input)"),
            task.temperature,
            task.fmt,
        )
        for i, piece in enumerate(pieces, 1)
    ]
    merged = "\n\n".join(f"--- partial {i} ---\n{p}" for i, p in enumerate(partials, 1))
    merge_prompt = (
        f"{task.prompt}\n\nThe INPUT below is a set of partial answers, each produced from one chunk of the same "
        "larger input. Merge them into ONE final answer in the required format: deduplicate, keep every distinct "
        "fact, and never add facts that are not in the partials."
    )
    while len(merged) > cfg.chunk_chars:  # recursive reduce for very large inputs
        merged = "\n\n".join(
            client.chat(model, merge_prompt, _user_message(question, piece), task.temperature, task.fmt)
            for piece in chunk(merged, cfg.chunk_chars)
        )
    return client.chat(model, merge_prompt, _user_message(question, merged), task.temperature, task.fmt)


def record_usage(entry: dict[str, Any]) -> None:
    try:
        USAGE_PATH.parent.mkdir(parents=True, exist_ok=True)
        with USAGE_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry) + "\n")
    except OSError:
        pass  # usage accounting must never fail a task


# --------------------------------------------------------------------------- commands


def cmd_check(cfg: Config) -> int:
    client = Ollama(cfg)
    have = client.installed()
    missing = [tag for tag in cfg.models.values() if tag not in have and f"{tag}:latest" not in have]
    for tier, tag in cfg.models.items():
        print(f"{tier:5} {tag:28} {'ok' if tag not in missing else 'MISSING (make llm-setup)'}")
    print(f"server {client.base} ok")
    return EXIT_UNAVAILABLE if missing else EXIT_OK


def cmd_tasks(cfg: Config) -> int:
    for t in cfg.tasks.values():
        flags = ",".join(f for f, on in (("draft", t.draft), ("code", t.code), ("map-reduce", t.map_reduce)) if on)
        first = t.prompt.splitlines()[0]
        print(f"{t.name:15} {t.model:5} {flags:22} {first[:80]}")
    return EXIT_OK


def cmd_run(cfg: Config, args: argparse.Namespace) -> int:
    task = cfg.tasks.get(args.task)
    if task is None:
        raise OffloadError(f"unknown task '{args.task}' (see: tasks)", EXIT_REFUSED)
    text = gather_input(cfg, task, args)
    model = cfg.model_tag(args.model or task.model)
    client = Ollama(cfg)
    client.require(model)
    started = time.monotonic()
    answer = redact(run_task(client, cfg, task, text, args.question, model))
    elapsed = time.monotonic() - started
    status = "DRAFT: verify before use" if task.draft else "local summary: verify claims you act on"
    header = f"[ollama {model} · task={task.name} · {len(text)}→{len(answer)} chars · {elapsed:.1f}s · {status}]"
    out = f"{header}\n{answer}\n"
    if args.out:
        Path(args.out).write_text(out, encoding="utf-8")
        print(f"[ollama] wrote {args.out}")
    else:
        sys.stdout.write(out)
    record_usage(
        {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "task": task.name,
            "model": model,
            "chars_in": len(text),
            "chars_out": len(answer),
            "seconds": round(elapsed, 1),
        }
    )
    return EXIT_OK


def cmd_stats(cfg: Config) -> int:
    """Credits only tasks whose input Claude would otherwise have read (replaces_read); drafts are listed uncredited."""
    if not USAGE_PATH.exists():
        print("no offloads recorded yet")
        return EXIT_OK
    per_task: dict[str, list[int]] = {}
    for line in USAGE_PATH.read_text(encoding="utf-8").splitlines():
        try:
            e = json.loads(line)
        except json.JSONDecodeError:
            continue
        agg = per_task.setdefault(str(e.get("task")), [0, 0, 0])
        agg[0] += 1
        agg[1] += int(e.get("chars_in", 0))
        agg[2] += int(e.get("chars_out", 0))
    total = 0
    for name, (runs, cin, cout) in sorted(per_task.items()):
        task = cfg.tasks.get(name)
        if task is not None and task.replaces_read:
            saved = max(cin - cout, 0) // 4
            total += saved
            note = f"~tokens kept out of Claude context={saved}"
        else:
            note = "draft/retired task: not credited (Claude would not have read the input)"
        print(f"{name:15} runs={runs:<4} in={cin:<9} out={cout:<7} {note}")
    print(f"total ~tokens kept out of Claude context: {total} (estimate: 4 chars/token, read-replacing tasks only)")
    return EXIT_OK


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="verify server and configured models")
    sub.add_parser("tasks", help="list task profiles")
    sub.add_parser("stats", help="usage and estimated context avoided")
    sub.add_parser("models", help="print configured model tags (for `make llm-setup`)")
    run = sub.add_parser("run", help="run one task")
    run.add_argument("task")
    run.add_argument("-f", "--file", action="append", help="input file (repeatable)")
    run.add_argument("--stdin", action="store_true", help="read input from stdin")
    run.add_argument("--diff", nargs="?", const="", default=None, metavar="REV", help="git diff [REV] as input")
    run.add_argument("--staged", action="store_true", help="git diff --staged as input")
    run.add_argument("-q", "--question", help="what to answer / extract / which FR id")
    run.add_argument("-m", "--model", help="tier (fast|deep) or explicit model tag")
    run.add_argument("-o", "--out", help="write the answer to this file instead of stdout")
    return parser


def die(err: OffloadError) -> NoReturn:
    hint = " — fall back: do this task in Claude (Haiku-class work)" if err.exit_code == EXIT_UNAVAILABLE else ""
    print(f"[ollama] {err}{hint}", file=sys.stderr)
    sys.exit(err.exit_code)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        cfg = load_config()
        if args.cmd == "check":
            return cmd_check(cfg)
        if args.cmd == "tasks":
            return cmd_tasks(cfg)
        if args.cmd == "stats":
            return cmd_stats(load_config())
        if args.cmd == "models":
            print("\n".join(sorted(set(cfg.models.values()))))
            return EXIT_OK
        return cmd_run(cfg, args)
    except OffloadError as err:
        die(err)


if __name__ == "__main__":
    sys.exit(main())
