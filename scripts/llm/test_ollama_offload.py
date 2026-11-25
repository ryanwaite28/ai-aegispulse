"""Local-LLM offload CLI (docs/steering/local-llm.md): config, guards, redaction, chunking, map-reduce, fallback.

A stdlib HTTP server stands in for Ollama, so these run without a model pulled.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, ClassVar

import pytest

_spec = importlib.util.spec_from_file_location("ollama_offload", Path(__file__).with_name("ollama_offload.py"))
assert _spec is not None
assert _spec.loader is not None
off = importlib.util.module_from_spec(_spec)
sys.modules["ollama_offload"] = off
_spec.loader.exec_module(off)


class _FakeOllama(BaseHTTPRequestHandler):
    models: ClassVar[list[str]] = ["qwen2.5-coder:7b", "qwen2.5-coder:14b"]
    calls: ClassVar[list[dict[str, Any]]] = []

    def log_message(self, format: str, *args: object) -> None:  # silence test output
        return

    def _send(self, payload: dict[str, Any]) -> None:
        data = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        self._send({"models": [{"name": m} for m in self.models]})

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).calls.append(body)
        user = body["messages"][1]["content"]
        self._send({"message": {"content": f"answer#{len(self.calls)} len={len(user)} token=ghp_{'a' * 36}"}})


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    _FakeOllama.calls = []
    httpd = HTTPServer(("127.0.0.1", 0), _FakeOllama)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    host = f"http://127.0.0.1:{httpd.server_address[1]}"
    monkeypatch.setenv("OLLAMA_HOST", host)
    yield host
    httpd.shutdown()


@pytest.fixture
def usage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    path = tmp_path / "usage.jsonl"
    monkeypatch.setattr(off, "USAGE_PATH", path)
    return path


def test_repo_config_loads_and_every_task_uses_a_known_tier() -> None:
    cfg = off.load_config()
    assert {"fast", "deep"} <= set(cfg.models)
    assert {"summarize-log", "commit-msg", "changelog", "test-scaffold"} <= set(cfg.tasks)
    for task in cfg.tasks.values():
        assert task.model in cfg.models, task.name
        assert task.fmt in {"text", "json"}
        assert task.prompt


def test_secret_files_are_refused_for_every_task() -> None:
    cfg = off.load_config()
    for rel in (".env", "deploy/compose/.env.local", "certs/tls.key", "cosign.key"):
        with pytest.raises(off.OffloadError) as exc:
            off.check_path(cfg, cfg.tasks["summarize-file"], rel)
        assert exc.value.exit_code == off.EXIT_REFUSED


def test_security_paths_refused_only_for_code_writing_tasks() -> None:
    cfg = off.load_config()
    rel = "services/ingestion/src/service/webhook-verifier.ts"
    off.check_path(cfg, cfg.tasks["summarize-file"], rel)  # reading/summarizing is allowed
    with pytest.raises(off.OffloadError, match="security-critical"):
        off.check_path(cfg, cfg.tasks["test-scaffold"], rel)
    domain = "services/cases/src/main/java/io/aegispulse/cases/domain/Policy.java"
    off.check_path(cfg, cfg.tasks["test-scaffold"], domain)


# Fake credentials are assembled at runtime so no credential-shaped literal sits in the source (gitleaks).
_FAKE_AWS_ID = "AK" + "IA" + "ABCDEFGHIJKLMNOP"
_FAKE_GITLAB = "gl" + "pat-" + "abcdefghijklmnopqrstu"


@pytest.mark.parametrize(
    "secret",
    [
        "DATABASE_PASSWORD=hunter2hunter2",
        "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
        "amqp://aegis:s3cr3tpass@rabbitmq:5672",
        _FAKE_AWS_ID,
        _FAKE_GITLAB,
    ],
)
def test_redaction_strips_credential_shapes(secret: str) -> None:
    out = off.redact(f"line before\n{secret}\nline after")
    assert "[REDACTED" in out
    leaks = ("hunter2hunter2", "abcdefghijklmnopqrstuvwxyz012345", "s3cr3tpass", _FAKE_AWS_ID, _FAKE_GITLAB[:7])
    for leaked in leaks:
        assert leaked not in out


def test_chunk_respects_size_and_preserves_content() -> None:
    text = "".join(f"line {i:04d} {'x' * (i % 50)}\n" for i in range(800)) + "y" * 2500
    pieces = off.chunk(text, 1000)
    assert all(len(p) <= 1000 for p in pieces)
    assert "".join(pieces) == text


def test_run_small_input_single_call_with_header_and_redacted_answer(
    server: str, usage: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    log = tmp_path / "unit.log"
    log.write_text("FAIL tests/x.test.ts > FR-CASE-05 assign\nAssertionError: expected 1 to be 2\n", encoding="utf-8")
    rc = off.main(["run", "summarize-log", "-f", str(log)])
    out = capsys.readouterr().out
    assert rc == 0
    assert len(_FakeOllama.calls) == 1
    call = _FakeOllama.calls[0]
    assert call["model"] == "qwen2.5-coder:7b"
    assert call["stream"] is False
    assert call["options"]["temperature"] == 0.0
    assert out.startswith("[ollama qwen2.5-coder:7b · task=summarize-log")
    assert "ghp_" not in out  # model output is redacted too
    entry = json.loads(usage.read_text(encoding="utf-8").splitlines()[0])
    assert entry["task"] == "summarize-log"
    assert entry["chars_in"] > 0


def test_large_input_is_map_reduced(
    server: str, usage: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    big = tmp_path / "big.log"
    big.write_text("".join(f"ok test {i}\n" for i in range(3000)), encoding="utf-8")
    cfg = off.load_config()
    monkeypatch.setattr(off, "load_config", lambda: off.Config(**{**cfg.__dict__, "chunk_chars": 8000}))
    assert off.main(["run", "summarize-log", "-f", str(big)]) == 0
    capsys.readouterr()
    n_chunks = len(off.chunk(big.read_text(encoding="utf-8"), 8000))
    assert n_chunks > 1
    assert len(_FakeOllama.calls) == n_chunks + 1  # map + final merge
    assert "partial answers" in _FakeOllama.calls[-1]["messages"][0]["content"]


def test_non_map_reduce_task_refuses_oversized_input(
    server: str, usage: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "domain.py"
    src.write_text("x = 1\n" * 3000, encoding="utf-8")
    cfg = off.load_config()
    monkeypatch.setattr(off, "load_config", lambda: off.Config(**{**cfg.__dict__, "chunk_chars": 1000}))
    with pytest.raises(SystemExit) as exc:
        off.main(["run", "explain", "-f", str(src)])
    assert exc.value.code == off.EXIT_REFUSED
    assert _FakeOllama.calls == []


def test_json_format_task_requests_json_mode(server: str, usage: Path, tmp_path: Path) -> None:
    f = tmp_path / "a.txt"
    f.write_text("phase 8g done", encoding="utf-8")
    assert off.main(["run", "extract", "-f", str(f), "-q", "phase id"]) == 0
    assert _FakeOllama.calls[0]["format"] == "json"
    assert _FakeOllama.calls[0]["messages"][1]["content"].startswith("QUESTION: phase id")


def test_unreachable_server_exits_3_for_fallback(
    monkeypatch: pytest.MonkeyPatch, usage: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setenv("OLLAMA_HOST", "http://127.0.0.1:9")  # discard port: nothing listens
    f = tmp_path / "a.log"
    f.write_text("x", encoding="utf-8")
    with pytest.raises(SystemExit) as exc:
        off.main(["run", "summarize-log", "-f", str(f)])
    assert exc.value.code == off.EXIT_UNAVAILABLE
    assert "fall back" in capsys.readouterr().err


def test_missing_model_exits_3(server: str, usage: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_FakeOllama, "models", ["something-else:1b"])
    f = tmp_path / "a.log"
    f.write_text("x", encoding="utf-8")
    with pytest.raises(SystemExit) as exc:
        off.main(["run", "summarize-log", "-f", str(f)])
    assert exc.value.code == off.EXIT_UNAVAILABLE
    assert _FakeOllama.calls == []
