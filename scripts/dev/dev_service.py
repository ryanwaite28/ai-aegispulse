"""`make dev SERVICE=<name>` (PROJECT.md §4.5, §9.5): one service natively, with hot reload, against compose.

1. Reads the service's resolved compose definition (`docker compose config --format json`, piped in on stdin). The
   environment — secrets included — is held in memory and handed only to the child process; nothing is printed.
2. Rewrites in-network hosts to host-published ports (postgres → localhost:5432, objectstore:8333 → localhost:9000,
   http://<service>:<port> → http://localhost:<port>, Mongo gets directConnection=true).
3. Stops the service's container and starts a socat proxy container that answers on the compose network under the
   service's name, forwarding to the native process (host.docker.internal), so the gateway and other callers keep
    working.
4. Runs the service with hot reload (Node: tsx watch · Java: gradle bootRun · Python: uvicorn --reload).
5. On exit (Ctrl-C), removes the proxy and starts the container again.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ["docker", "compose", "--env-file", ".env", "-f", "deploy/compose/docker-compose.yml"]
NETWORK = "aegispulse_default"
PROXY_IMAGE = "alpine/socat:1.8.0.3"
INFRA = {
    "postgres": "5432",
    "mongo": "27017",
    "redis": "6379",
    "rabbitmq": "5672",
    "clamav": "3310",
    "openobserve": "5080",
}
NODE = {
    "gateway": "gateway/nest-http",
    "ingestion": "services/ingestion",
    "files": "services/files",
    "events": "services/events",
    "orchestrator": "services/orchestrator",
}
JAVA = {"registry", "cases"}
PYTHON = {"risk-scoring", "sensitivity-scanner", "doc-extraction", "data-intel"}
RUNTIMES = set(NODE) | JAVA | PYTHON


def localize(value: str, services: dict[str, str]) -> str:
    """Rewrites compose-network hosts in one env value to their host-published equivalents."""
    if value in INFRA:
        return "localhost"
    v = value.replace("objectstore:8333", "localhost:9000")
    for name, port in {**INFRA, **services}.items():
        v = re.sub(rf"(?<=[/@]){re.escape(name)}(?=:{port}\b)", "localhost", v)
    if v.startswith("mongodb://") and "directConnection" not in v:
        v = re.sub(r"[?&]replicaSet=[^&]*", "", v)
        v += ("&" if "?" in v else "?") + "directConnection=true"
    return v


def command(name: str, svc: dict[str, Any]) -> tuple[list[str], Path]:
    if name in NODE:
        src = ROOT / NODE[name] / "src" / "main.ts"
        return ["pnpm", "--dir", str(ROOT / "packages/contracts"), "exec", "tsx", "watch", str(src)], ROOT / NODE[name]
    if name in JAVA:
        return ["./gradlew", "--no-daemon", f":{name}:bootRun"], ROOT
    args = (svc.get("build") or {}).get("args") or {}
    module, port = args.get("MODULE"), args.get("PORT")
    if not module or not port:
        raise SystemExit(f"dev: compose build args MODULE/PORT missing for {name}")
    return [
        "uv",
        "run",
        "--package",
        name,
        "uvicorn",
        module,
        "--port",
        port,
        "--reload",
        "--reload-dir",
        str(ROOT / "services" / name / "src"),
    ], ROOT


def run(*cmd: str, check: bool = True) -> int:
    return subprocess.run(
        list(cmd), cwd=ROOT, check=check, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode


def main() -> int:
    name = sys.argv[1] if len(sys.argv) > 1 else ""
    if name not in RUNTIMES:
        print(f"usage: make dev SERVICE=<{'|'.join(sorted(RUNTIMES))}>", file=sys.stderr)
        return 2
    config = json.load(sys.stdin)
    services = {
        n: (s.get("ports") or [{}])[0].get("target", "") for n, s in config["services"].items() if n in RUNTIMES
    }
    services = {n: str(p) for n, p in services.items() if p}
    svc = config["services"][name]
    env = {**os.environ, **{k: localize(str(v), services) for k, v in (svc.get("environment") or {}).items()}}
    if name in JAVA and Path("/opt/homebrew/opt/openjdk@25").exists():
        env.setdefault("JAVA_HOME", "/opt/homebrew/opt/openjdk@25")
    port = services[name]
    cmd, cwd = command(name, svc)

    proxy = f"aegispulse-dev-{name}"
    print(f"dev: stopping the {name} container; a proxy answers as {name}:{port} on {NETWORK}", file=sys.stderr)
    run(*COMPOSE, "stop", name)
    run("docker", "rm", "-f", proxy, check=False)
    run(
        "docker",
        "run",
        "-d",
        "--rm",
        "--name",
        proxy,
        "--network",
        NETWORK,
        "--network-alias",
        name,
        "--add-host",
        "host.docker.internal:host-gateway",
        PROXY_IMAGE,
        f"TCP-LISTEN:{port},fork,reuseaddr",
        f"TCP:host.docker.internal:{port}",
    )
    if name in NODE:
        subprocess.run(["pnpm", "run", "build:kits"], cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
    print(
        f"dev: running {name} natively on :{port} with hot reload (Ctrl-C to stop and restore the container)",
        file=sys.stderr,
    )
    child = subprocess.Popen(cmd, cwd=cwd, env=env)
    try:
        return child.wait()
    except KeyboardInterrupt:
        child.send_signal(signal.SIGINT)
        return child.wait()
    finally:
        run("docker", "rm", "-f", proxy, check=False)
        run(*COMPOSE, "up", "-d", name, check=False)
        print(f"dev: {name} container restored", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
