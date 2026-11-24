"""Build identity for logs/traces (``{runtime}@{git sha}``). Images write /app/build-info.json; local runs use "dev"."""

import json
import re
from pathlib import Path


def build_version(path: str = "/app/build-info.json") -> str:
    p = Path(path)
    if not p.is_file():
        return "dev"
    sha = json.loads(p.read_text()).get("gitSha")
    return sha if isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{7,40}", sha) else "dev"
