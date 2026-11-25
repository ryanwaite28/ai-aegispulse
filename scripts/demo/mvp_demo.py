"""make demo-mvp: Phase 8 exit demo (PROJECT.md §11 Phase 8, MVP vertical slice) on the local compose stack.

1. Capture every message the burst routes: a temporary queue bound `#` on the four topic exchanges.
2. Burst: 6 transactions on one account of the seeded demo tenant. The saga scores deliveries in parallel, so the
   per-transaction velocity count is order-dependent, but the transaction counted last always sees all 6 (record,
   then count: FR-TXN-04) and so scores 80 and is ESCALATED; at least one more reaches a HIGH case (policy-v1, §1.4.5).
3. Snapshot what the platform stored (risk evaluations, cases, transitions, policy evaluations, audit entries,
   archived events) and verify every audit chain (scheduler job cases-audit-verify).
4. Replay every captured message 3x to its original exchange and routing key (duplicates as broker redelivery or
   replay would produce them), wait for the queues to drain, snapshot again: the counts must be identical
   (NFR-02) and the chains still valid.
5. Show the saga's distributed trace from OpenObserve: Node (orchestrator) → Python (risk-scoring) → Java (cases).

Credentials (platform admin, RabbitMQ and OpenObserve admin) come from the resolved compose config in memory and are
never printed. Local stack only.
"""

import base64
import json
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ["docker", "compose", "--env-file", ".env", "-f", "deploy/compose/docker-compose.yml"]
GATEWAY = "http://127.0.0.1:8080"
RABBIT = "http://127.0.0.1:15672/api"
VHOST = "aegispulse-local"
CAPTURE = f"demo.capture.{uuid.uuid4().hex[:8]}"
EXCHANGES = ["aegispulse.ingress", "aegispulse.enrichment", "aegispulse.domain", "aegispulse.intelligence"]


def out(line: str) -> None:
    print(f"demo-mvp: {line}", flush=True)


def compose_env() -> dict[str, dict[str, str]]:
    cfg = json.loads(
        subprocess.run(
            [*COMPOSE, "--profile", "tools", "config", "--format", "json"], cwd=ROOT, capture_output=True, check=True
        ).stdout
    )
    return {name: (svc.get("environment") or {}) for name, svc in cfg["services"].items()}


def http(method: str, url: str, body: Any = None, headers: dict[str, str] | None = None) -> tuple[int, Any]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(  # noqa: S310 — fixed local URLs
        url, data=data, method=method, headers={"content-type": "application/json", **(headers or {})}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 — fixed local URLs
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, json.loads(raw) if raw else {}


def basic(user: str, password: str) -> dict[str, str]:
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()}


def psql(sql: str) -> str:
    return subprocess.run(
        [*COMPOSE, "exec", "-T", "postgres", "psql", "-U", "aegis_admin", "-d", "aegispulse", "-tAc", sql],
        cwd=ROOT,
        capture_output=True,
        check=True,
        text=True,
    ).stdout.strip()


def mongo_count(tenant: str) -> int:
    js = f"db.getSiblingDB('aegispulse_events').events_archive.countDocuments({{tenantId: '{tenant}'}})"
    r = subprocess.run(
        [
            *COMPOSE,
            "exec",
            "-T",
            "mongo",
            "sh",
            "-c",
            f'mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" '
            f'--authenticationDatabase admin --eval "{js}"',
        ],
        cwd=ROOT,
        capture_output=True,
        check=True,
        text=True,
    )
    return int(r.stdout.strip().splitlines()[-1])


def snapshot(tenant: str) -> dict[str, int]:
    tables = ["risk_evaluations", "cases", "case_transitions", "policy_evaluations", "case_evidence", "audit_log"]
    counts = {t: int(psql(f"SELECT count(*) FROM cases.{t} WHERE tenant_id = '{tenant}'")) for t in tables}
    counts["transaction_submissions"] = int(
        psql(f"SELECT count(*) FROM ingestion.transaction_submissions WHERE tenant_id = '{tenant}'")
    )
    counts["events_archive"] = mongo_count(tenant)
    return counts


def queue_depths(rabbit: dict[str, str], names: list[str]) -> dict[str, int]:
    depths = {}
    for q in names:
        _, b = http("GET", f"{RABBIT}/queues/{VHOST}/{urllib.parse.quote(q, safe='')}", headers=rabbit)
        depths[q] = int(b.get("messages", 0))
    return depths


def wait_drained(rabbit: dict[str, str]) -> None:
    queues = ["orchestrator.txn.q", "cases.audit-ingest.q", "events.archive.q"]
    for _ in range(120):
        d = queue_depths(rabbit, queues)
        if all(v == 0 for v in d.values()):
            return
        time.sleep(1)
    raise RuntimeError(f"queues not drained: {d}")


def verify_chains() -> str:
    r = subprocess.run(
        ["make", "trigger", "JOB=cases-audit-verify"], cwd=ROOT, capture_output=True, text=True, check=True
    )
    line = next(ln for ln in r.stdout.splitlines() if "cases-audit-verify" in ln and "summary" in ln)
    return json.dumps(json.loads(line)["summary"])


def main() -> int:
    env = compose_env()
    pa_password = next(v for e in env.values() for k, v in e.items() if k == "PLATFORM_ADMIN_BOOTSTRAP_PASSWORD")
    rabbit = basic(env["rabbitmq"]["RABBITMQ_DEFAULT_USER"], env["rabbitmq"]["RABBITMQ_DEFAULT_PASS"])
    o2 = basic(env["openobserve"]["ZO_ROOT_USER_EMAIL"], env["openobserve"]["ZO_ROOT_USER_PASSWORD"])
    tenant = json.loads((ROOT / ".seed-state.json").read_text())["tenant-acme-capital"]
    st, b = http(
        "POST",
        f"{GATEWAY}/v1/auth/login",
        {"tenantSlug": "platform", "email": "admin@aegispulse.local", "password": pa_password},
    )
    if st != 200:
        raise RuntimeError(f"platform admin login: HTTP {st}")
    auth = {"authorization": "Bearer " + b["data"]["accessToken"], "x-aegis-tenant": tenant}

    # 1. capture queue
    # RabbitMQ 4 refuses transient non-exclusive queues: durable, self-expiring after 15 idle minutes.
    st, b = http(
        "PUT",
        f"{RABBIT}/queues/{VHOST}/{CAPTURE}",
        {"durable": True, "auto_delete": False, "arguments": {"x-expires": 900_000}},
        rabbit,
    )
    if st not in (201, 204):
        raise RuntimeError(f"capture queue: HTTP {st} {b}")
    for ex in EXCHANGES:
        st, b = http("POST", f"{RABBIT}/bindings/{VHOST}/e/{ex}/q/{CAPTURE}", {"routing_key": "#"}, rabbit)
        if st != 201:
            raise RuntimeError(f"capture binding {ex}: HTTP {st} {b}")
    try:
        # 2. burst
        account = f"acc-demo-{uuid.uuid4().hex[:6]}"
        out(f"1. burst: 6 x 60,000 EUR wires to IR from account {account} (new counterparty each)")
        txns = []
        for _ in range(6):
            st, b = http(
                "POST",
                f"{GATEWAY}/v1/transactions",
                {
                    "idempotencyKey": f"demo-{uuid.uuid4()}",
                    "accountId": account,
                    "counterpartyId": f"cp-{uuid.uuid4().hex[:8]}",
                    "counterpartyName": "Demo Counterparty",
                    "amount": "60000.00",
                    "currency": "EUR",
                    "country": "IR",
                    "channel": "WIRE",
                    "occurredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                },
                auth,
            )
            if st != 202:
                raise RuntimeError(f"submit: HTTP {st} {b}")
            txns.append(b["data"])
            time.sleep(0.3)
        escalated = None
        for t in txns:
            for _ in range(120):
                _, d = http("GET", f"{GATEWAY}/v1/transactions/{t['transactionId']}", headers=auth)
                if d["data"]["processingStatus"] != "ACCEPTED":
                    break
                time.sleep(0.5)
            data = d["data"]
            case = ""
            if data["caseId"]:
                _, c = http("GET", f"{GATEWAY}/v1/cases/{data['caseId']}", headers=auth)
                cd = c["data"]
                case = (
                    f" → case {cd['caseNumber']} {cd['status']} {cd['severity']}"
                    f" (policy {cd['latestPolicyEvaluation']['policyScore']})"
                )
                if cd["status"] == "ESCALATED" and escalated is None:
                    escalated = cd
            out(
                f"   score {data['latestEvaluation']['score']:>3} {data['latestEvaluation']['band']:<6}"
                f" {data['processingStatus']}{case}"
            )
        if escalated is None:
            raise RuntimeError("no ESCALATED case")
        _, tl = http("GET", f"{GATEWAY}/v1/cases/{escalated['id']}/timeline", headers=auth)
        out(
            "2. timeline of "
            + escalated["caseNumber"]
            + ": "
            + " → ".join(x["toStatus"] for x in tl["data"]["transitions"])
        )
        wait_drained(rabbit)
        out("3. audit chains: " + verify_chains())
        before = snapshot(tenant)
        out("4. stored for the tenant: " + json.dumps(before))

        # 4. replay every captured message 3x
        _, msgs = http(
            "POST",
            f"{RABBIT}/queues/{VHOST}/{CAPTURE}/get",
            {"count": 1000, "ackmode": "ack_requeue_false", "encoding": "auto"},
            rabbit,
        )
        if not isinstance(msgs, list):
            raise RuntimeError(f"capture get: {msgs}")
        out(f"5. captured {len(msgs)} routed messages; replaying each 3x to its exchange/routing key")
        published = 0
        for m in msgs:
            for _ in range(3):
                props = m.get("properties", {})
                _, r = http(
                    "POST",
                    f"{RABBIT}/exchanges/{VHOST}/{m['exchange']}/publish",
                    {
                        "properties": {
                            k: v
                            for k, v in props.items()
                            if k in ("content_type", "headers", "message_id", "correlation_id", "type", "delivery_mode")
                        },
                        "routing_key": m["routing_key"],
                        "payload": m["payload"],
                        "payload_encoding": m["payload_encoding"],
                    },
                    rabbit,
                )
                published += 1 if r.get("routed") else 0
        out(f"   republished {published} copies")
        time.sleep(3)
        wait_drained(rabbit)
        after = snapshot(tenant)
        out("6. stored after replay: " + json.dumps(after))
        same = after == before
        out(
            "   duplicates created: "
            + ("none" if same else json.dumps({k: after[k] - before[k] for k in after if after[k] != before[k]}))
        )
        out("7. audit chains after replay: " + verify_chains())

        # 5. trace
        last = txns[-1]["eventId"]
        logs = subprocess.run(
            [*COMPOSE, "logs", "orchestrator", "--no-log-prefix", "--since", "15m"],
            cwd=ROOT,
            capture_output=True,
            text=True,
        ).stdout
        trace_id = next(
            (
                json.loads(ln).get("traceId")
                for ln in logs.splitlines()
                if ln.startswith("{") and last in ln and "transaction.scored" in ln
            ),
            None,
        )
        if trace_id:
            for _ in range(30):
                _, r = http(
                    "POST",
                    "http://localhost:5080/api/default/_search?type=traces",
                    {
                        "query": {
                            "sql": (
                                'SELECT service_name, operation_name, start_time FROM "default"'
                                f" WHERE trace_id = '{trace_id}' ORDER BY start_time"
                            ),
                            "start_time": int((time.time() - 3600) * 1_000_000),
                            "end_time": int((time.time() + 60) * 1_000_000),
                            "size": 200,
                        }
                    },
                    o2,
                )
                hits = r.get("hits", [])
                if {h["service_name"] for h in hits} >= {
                    "aegispulse-orchestrator",
                    "aegispulse-risk-scoring",
                    "aegispulse-cases",
                }:
                    break
                time.sleep(2)
            services = []
            for h in hits:
                if h["service_name"] not in services:
                    services.append(h["service_name"])
            out(f"8. trace {trace_id}: {len(hits)} spans across " + " → ".join(services))
        else:
            out("8. trace: no traceId found in orchestrator logs")
        return 0 if same else 1
    finally:
        http("DELETE", f"{RABBIT}/queues/{VHOST}/{CAPTURE}", headers=rabbit)


if __name__ == "__main__":
    sys.exit(main())
