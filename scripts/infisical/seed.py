"""Seed Infisical folders + GENERATED secrets from deploy/infisical/secrets-catalog.yaml (MB-06, ADR-0012).

Operator-run from the MB-03 shell (INFISICAL_TOKEN from the svc_admin login). Never run by the AI agent or CI.

    uv run python -I scripts/infisical/seed.py --env dev --dry-run    # names/counts only; writes nothing
    uv run python -I scripts/infisical/seed.py --env dev              # creates folders, fills MISSING generated keys

Guarantees:
- Idempotent: existing keys are never overwritten (rotation is a separate, explicit operation).
- No secret value is printed, logged, or passed on a command line: values reach the CLI through a 0600 file in a
  private temp directory that is deleted immediately.
- `reference` keys (connection URLs composed from data-store folders) are deferred to Phase 9, when the in-cluster
  hostnames exist; `external` keys are listed for their owners to enter in the UI.
- --env prod requires typing the environment name to confirm.
"""

import argparse
import base64
import json
import os
import secrets
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

import yaml
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

REPO = Path(__file__).resolve().parents[2]
CATALOG = REPO / "deploy" / "infisical" / "secrets-catalog.yaml"
DEFAULT_DOMAIN = "https://infisical.rmwhs.com/api"


def _strong() -> str:
    return "Aa1-" + secrets.token_hex(20)


def _rsa_pem() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    return pem.decode("ascii")


GENERATORS: Mapping[str, Callable[[], str]] = {
    "hex24": lambda: secrets.token_hex(24),
    "hex32": lambda: secrets.token_hex(32),
    "strong": _strong,
    "b64-32": lambda: base64.b64encode(secrets.token_bytes(32)).decode("ascii"),
    "mongo-keyfile": lambda: base64.b64encode(secrets.token_bytes(756)).decode("ascii"),
    "rsa2048-pem": _rsa_pem,
}
DEFERRED = {"reference": "Phase 9 (needs in-cluster hostnames)", "external": "owner enters in the UI"}


@dataclass(frozen=True)
class FolderPlan:
    folder: str
    present: list[str]
    to_generate: dict[str, str]  # key -> generator
    deferred: dict[str, str]  # key -> reason


def load_catalog(path: Path = CATALOG) -> dict[str, dict[str, str]]:
    data = yaml.safe_load(path.read_text())
    folders: dict[str, dict[str, str]] = data["folders"]
    for folder, keys in folders.items():
        for key, generator in keys.items():
            if generator not in GENERATORS and generator not in DEFERRED:
                raise ValueError(f"unknown generator {generator!r} for {folder}/{key}")
    return folders


def plan_folder(folder: str, keys: Mapping[str, str], existing: set[str]) -> FolderPlan:
    present = sorted(k for k in keys if k in existing)
    to_generate = {k: g for k, g in keys.items() if k not in existing and g in GENERATORS}
    deferred = {k: DEFERRED[g] for k, g in keys.items() if k not in existing and g in DEFERRED}
    return FolderPlan(folder, present, to_generate, deferred)


class InfisicalCli:
    """Thin wrapper over the `infisical` CLI. The token comes from INFISICAL_TOKEN (never an argument)."""

    def __init__(self, env: str, project_id: str, domain: str) -> None:
        self.base = ["infisical", "--domain", domain, "--silent"]
        self.scope = ["--env", env, "--projectId", project_id]

    def _run(self, args: list[str]) -> subprocess.CompletedProcess[str]:
        return subprocess.run([*self.base[:1], *args, *self.base[1:], *self.scope], capture_output=True, text=True)

    def ensure_folder(self, folder: str) -> None:
        result = self._run(["secrets", "folders", "create", "--name", folder, "--path", "/"])
        if result.returncode != 0 and "exist" not in (result.stderr + result.stdout).lower():
            raise RuntimeError(f"could not create folder /{folder}: {result.stderr.strip()[:200]}")

    def existing_keys(self, folder: str) -> set[str]:
        result = self._run(
            ["secrets", "--path", f"/{folder}", "--output", "json", "--expand=false", "--include-imports=false"]
        )
        if result.returncode != 0:
            if "not found" in (result.stderr + result.stdout).lower():
                return set()
            raise RuntimeError(f"could not list /{folder}: {result.stderr.strip()[:200]}")
        rows = json.loads(result.stdout or "[]")
        return {str(r.get("secretKey") or r.get("key")) for r in rows}  # values are never read further

    def set_from_file(self, folder: str, values: Mapping[str, str]) -> None:
        with tempfile.TemporaryDirectory(prefix="aegis-seed-") as tmp:
            os.chmod(tmp, 0o700)
            path = Path(tmp) / "secrets.yaml"
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as handle:
                yaml.safe_dump(dict(values), handle, default_style='"')
            result = self._run(["secrets", "set", "--path", f"/{folder}", "--file", str(path), "--output", "json"])
        if result.returncode != 0:
            raise RuntimeError(f"could not set secrets in /{folder}: {result.stderr.strip()[:200]}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--env", required=True, choices=["dev", "prod"])
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--only", nargs="*", default=None, help="limit to these folders")
    args = parser.parse_args(argv)

    if not os.environ.get("INFISICAL_TOKEN"):
        print(
            "seed: INFISICAL_TOKEN is not set; log in as svc_admin first (docs/runbooks/infisical.md, MB-03)",
            file=sys.stderr,
        )
        return 2
    catalog = yaml.safe_load(CATALOG.read_text())
    folders = load_catalog()
    if args.only:
        folders = {f: k for f, k in folders.items() if f in set(args.only)}
    if args.env == "prod" and not args.dry_run:
        typed = input("Seeding PRODUCTION. Type 'prod' to continue: ")
        if typed.strip() != "prod":
            print("seed: not confirmed; nothing changed")
            return 1

    cli = InfisicalCli(args.env, catalog["project"], os.environ.get("INFISICAL_DOMAIN", DEFAULT_DOMAIN))
    totals = {"present": 0, "generated": 0, "deferred": 0}
    for folder, keys in folders.items():
        existing = cli.existing_keys(folder)
        plan = plan_folder(folder, keys, existing)
        action = "would generate" if args.dry_run else "generated"
        print(
            f"/{folder}: {len(plan.present)} present, {action} {len(plan.to_generate)}, deferred {len(plan.deferred)}"
        )
        for key in sorted(plan.to_generate):
            print(f"    + {key} ({plan.to_generate[key]})")
        for key, reason in sorted(plan.deferred.items()):
            print(f"    ~ {key}: {reason}")
        if not args.dry_run and plan.to_generate:
            cli.ensure_folder(folder)
            cli.set_from_file(folder, {k: GENERATORS[g]() for k, g in plan.to_generate.items()})
        totals["present"] += len(plan.present)
        totals["generated"] += len(plan.to_generate)
        totals["deferred"] += len(plan.deferred)
    verb = "would generate" if args.dry_run else "generated"
    summary = f"{totals['present']} present, {verb} {totals['generated']}, deferred {totals['deferred']}"
    print(f"seed[{args.env}]: {summary} (values never printed)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
