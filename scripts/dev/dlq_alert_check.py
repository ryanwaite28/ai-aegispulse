"""Local equivalent of the FR-MSG-04 OpenObserve alerts (deploy/observability/alerts/dlq-spike.json).

Evaluates each alert's PromQL against the local OpenObserve (http://localhost:5080) and applies its
promql_condition, as the scheduled alert would. The local stack ships no RabbitMQ metrics to OpenObserve, so an
alert whose stream has no data there (aegispulse-dlq-depth) falls back to the broker itself: current depth of every
*.dlq queue via rabbitmqctl (the 10-minute persistence window is the cluster alert's job).

Exit codes: 0 = nothing firing, 1 = at least one alert would fire, 2 = could not evaluate.
The OpenObserve login is read from the resolved compose config in memory and never printed.
"""

import base64
import json
import operator
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
ALERTS = ROOT / "deploy/observability/alerts/dlq-spike.json"
COMPOSE = ["docker", "compose", "--env-file", ".env", "-f", "deploy/compose/docker-compose.yml"]
O2 = "http://localhost:5080"
VHOST = "aegispulse-local"
OPS = {">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le, "=": operator.eq}


def o2_auth() -> str:
    config = json.loads(
        subprocess.run([*COMPOSE, "config", "--format", "json"], cwd=ROOT, capture_output=True, check=True).stdout
    )
    env = config["services"]["openobserve"]["environment"]
    return base64.b64encode(f"{env['ZO_ROOT_USER_EMAIL']}:{env['ZO_ROOT_USER_PASSWORD']}".encode()).decode()


def promql(auth: str, query: str) -> list[dict[str, Any]]:
    url = f"{O2}/api/default/prometheus/api/v1/query?query={urllib.parse.quote(query)}"
    request = urllib.request.Request(url, headers={"Authorization": f"Basic {auth}"})  # noqa: S310 — fixed local URL
    with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310
        body = json.loads(response.read())
    if body.get("status") != "success":
        raise RuntimeError(f"promql query failed: {body.get('error', body)}")
    result: list[dict[str, Any]] = body["data"]["result"]
    return result


def dlq_depths() -> dict[str, int]:
    out = subprocess.run(
        [*COMPOSE, "exec", "-T", "rabbitmq", "rabbitmqctl", "-q", "-p", VHOST, "list_queues", "name", "messages_ready"],
        cwd=ROOT,
        capture_output=True,
        check=True,
        text=True,
    ).stdout
    depths: dict[str, int] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].endswith(".dlq") and parts[1].isdigit():
            depths[parts[0]] = int(parts[1])
    return depths


def main() -> int:
    alerts = json.loads(ALERTS.read_text())["alerts"]
    try:
        auth = o2_auth()
    except (subprocess.CalledProcessError, KeyError) as e:
        print(f"dlq-alert-check: cannot read the local OpenObserve login from compose: {type(e).__name__}")
        return 2
    firing = False
    for alert in alerts:
        cond = alert["query_condition"]
        check = cond["promql_condition"]
        compare = OPS[check["operator"]]
        try:
            series = promql(auth, cond["promql"])
        except (urllib.error.URLError, RuntimeError) as e:
            print(f"{alert['name']}: cannot query OpenObserve ({e})")
            return 2
        if series:
            hits = [
                (s["metric"], float(s["value"][1])) for s in series if compare(float(s["value"][1]), check["value"])
            ]
            values = ", ".join(f"{s['metric'] or 'total'}={float(s['value'][1]):g}" for s in series)
            source = "OpenObserve"
        elif alert["stream_name"] == "rabbitmq_queue_messages_ready":
            depths = dlq_depths()
            hits = [({"queue": q}, float(d)) for q, d in depths.items() if compare(d, check["value"])]
            values = ", ".join(f"{q}={d}" for q, d in sorted(depths.items()) if d) or "every *.dlq empty"
            source = "rabbitmqctl (no RabbitMQ metrics in local OpenObserve)"
        else:
            hits, values, source = [], "no samples yet", "OpenObserve"
        state = "FIRING" if hits else "ok"
        firing = firing or bool(hits)
        print(f"{alert['name']}: {state} — {check['operator']} {check['value']:g} via {source}: {values}")
    return 1 if firing else 0


if __name__ == "__main__":
    sys.exit(main())
