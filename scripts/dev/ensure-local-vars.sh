#!/usr/bin/env bash
# Appends local-only secrets that were added after an existing .env was generated (append-only; never overwrites,
# never prints a value). Called by gen-local-secrets.sh; run it by hand once for an older .env:
#   scripts/dev/ensure-local-vars.sh
# Keys (PROJECT.md §10.4): JWT_SIGNING_KEY_CURRENT_PEM (FR-AUTH-05), PLATFORM_ADMIN_BOOTSTRAP_PASSWORD (FR-TEN-09),
# SERVICE_CLIENT_SECRET_{RUNTIME} for each §5.7.4 SERVICE account (FR-TEN-07, ADR-0017).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="$root/.env"
[[ -f "$out" ]] || { echo "ensure-local-vars: $out missing; run 'make env' first" >&2; exit 1; }
added=()
# A key counts as present only with a real value: empty or "<placeholder>" lines (from .env.example) are replaced.
has() { grep -Eq "^$1=.+" "$out" && ! grep -Eq "^$1=(\"\"|<[^>]*>)?[[:space:]]*(#.*)?$" "$out"; }
drop() {
  local tmp
  tmp="$(mktemp "$out.XXXXXX")"
  grep -v "^$1=" "$out" > "$tmp" || true
  mv "$tmp" "$out"
}
if ! has JWT_SIGNING_KEY_CURRENT_PEM; then
  drop JWT_SIGNING_KEY_CURRENT_PEM
  # PKCS#8 RSA-2048, one line with \n escapes inside double quotes (compose expands them to real newlines).
  pem="$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null | awk '{printf "%s\\n", $0}')"
  printf 'JWT_SIGNING_KEY_CURRENT_PEM="%s"\n' "$pem" >> "$out"
  added+=(JWT_SIGNING_KEY_CURRENT_PEM)
fi
if ! has PLATFORM_ADMIN_BOOTSTRAP_PASSWORD; then
  drop PLATFORM_ADMIN_BOOTSTRAP_PASSWORD
  echo "PLATFORM_ADMIN_BOOTSTRAP_PASSWORD=Aa1-$(openssl rand -hex 20)" >> "$out"
  added+=(PLATFORM_ADMIN_BOOTSTRAP_PASSWORD)
fi
for runtime in GATEWAY INGESTION FILES EVENTS ORCHESTRATOR DOC_EXTRACTION RISK_SCORING DATA_INTEL SCHEDULER_TRIGGER; do
  name="SERVICE_CLIENT_SECRET_${runtime}"
  if ! has "$name"; then
    drop "$name"
    echo "${name}=$(openssl rand -hex 32)" >> "$out"
    added+=("$name")
  fi
done
chmod 600 "$out"
echo "ensure-local-vars: added ${#added[@]} key(s)${added:+: ${added[*]}} (values never printed)"
