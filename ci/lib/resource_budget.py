"""Sums container requests per node tier from rendered manifests (stdin) and enforces PROJECT.md §5.4 budgets."""

from __future__ import annotations

import argparse
import sys
from typing import Any

import yaml

# (cpu millicores, memory MiB) request budgets per environment and node tier (NFR-03).
BUDGETS = {
    "prod": {"compute": (2000, 4608), "storage": (1000, 4096)},
    "dev": {"compute": (1000, 3072), "storage": (500, 2048)},
}
WORKLOAD_KINDS = {"Deployment": 1, "StatefulSet": 1, "DaemonSet": 1, "Job": 0, "CronJob": 0}


def cpu_m(v: str) -> int:
    return int(v[:-1]) if v.endswith("m") else int(float(v) * 1000)


def mem_mi(v: str) -> int:
    binary = {"Ki": 1 / 1024, "Mi": 1.0, "Gi": 1024.0, "Ti": 1024.0 * 1024}
    decimal = {"k": 1e3, "M": 1e6, "G": 1e9, "T": 1e12}
    for suffix, factor in binary.items():
        if v.endswith(suffix):
            return round(float(v[: -len(suffix)]) * factor)
    for suffix, factor in decimal.items():
        if v.endswith(suffix):
            return round(float(v[: -len(suffix)]) * factor / 1048576)
    return round(float(v) / 1048576)


def pod_spec(doc: dict[str, Any]) -> tuple[dict[str, Any], int] | None:
    kind = doc.get("kind")
    if kind not in WORKLOAD_KINDS:
        return None
    spec = doc.get("spec", {})
    if kind == "CronJob":
        return spec["jobTemplate"]["spec"]["template"]["spec"], 0
    replicas = spec.get("replicas", 1) if WORKLOAD_KINDS[kind] else 0
    return spec["template"]["spec"], replicas


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--env", required=True, choices=sorted(BUDGETS))
    env = ap.parse_args().env
    totals = {"compute": [0, 0], "storage": [0, 0]}
    errors: list[str] = []
    for doc in yaml.safe_load_all(sys.stdin):
        if not doc:
            continue
        found = pod_spec(doc)
        if found is None:
            continue
        spec, replicas = found
        name = f"{doc['kind']}/{doc['metadata']['name']}"
        tier = "storage" if spec.get("nodeSelector", {}).get("dedicated") == "storage" else "compute"
        for c in spec.get("initContainers", []) + spec.get("containers", []):
            res = c.get("resources", {})
            req, lim = res.get("requests", {}), res.get("limits", {})
            for kind_, d in (("requests", req), ("limits", lim)):
                for k in ("cpu", "memory"):
                    if k not in d:
                        errors.append(f"{name}/{c['name']}: missing {kind_}.{k}")
            if c in spec.get("containers", []) and "cpu" in req and "memory" in req:
                totals[tier][0] += cpu_m(str(req["cpu"])) * replicas
                totals[tier][1] += mem_mi(str(req["memory"])) * replicas
    for tier, (cpu, mem) in totals.items():
        bcpu, bmem = BUDGETS[env][tier]
        status = "OK" if cpu <= bcpu and mem <= bmem else "OVER BUDGET"
        print(f"[{env}] {tier:8s} requests cpu={cpu}m/{bcpu}m mem={mem}Mi/{bmem}Mi  {status}")
        if status != "OK":
            errors.append(f"{env} {tier} requests exceed budget")
    for e in errors:
        print(f"RESOURCE VIOLATION: {e}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
