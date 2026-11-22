#!/usr/bin/env bash
# Full-history scan on the default branch; commit-range scan on merge requests (ADR-0007).
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -n "${CI_MERGE_REQUEST_DIFF_BASE_SHA:-}" ]]; then
  gitleaks git --redact --no-banner --config .gitleaks.toml --log-opts="${CI_MERGE_REQUEST_DIFF_BASE_SHA}..HEAD"
else
  gitleaks git --redact --no-banner --config .gitleaks.toml
fi
echo "scan-gitleaks: OK"
