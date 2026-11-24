#!/usr/bin/env bash
# Appends local-only secrets that were added after an existing .env was generated (append-only; never overwrites,
# never prints a value). Called by gen-local-secrets.sh; run it by hand once for an older .env:
#   scripts/dev/ensure-local-vars.sh [env-file]   (default: the repo's .env)
# Keys (PROJECT.md §10.4): JWT_SIGNING_KEY_CURRENT_PEM (FR-AUTH-05), PLATFORM_ADMIN_BOOTSTRAP_PASSWORD (FR-TEN-09),
# SERVICE_CLIENT_SECRET_{RUNTIME} for each §5.7.4 SERVICE account (FR-TEN-07, ADR-0017), INGESTION_KEK_BASE64 (FR-WHK-01).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
out="${1:-$root/.env}"
[[ -f "$out" ]] || { echo "ensure-local-vars: $out missing; run 'make env' first" >&2; exit 1; }
added=()
managed=(JWT_SIGNING_KEY_CURRENT_PEM PLATFORM_ADMIN_BOOTSTRAP_PASSWORD INGESTION_KEK_BASE64)
for runtime in GATEWAY INGESTION FILES EVENTS ORCHESTRATOR DOC_EXTRACTION RISK_SCORING DATA_INTEL SCHEDULER_TRIGGER; do
  managed+=("SERVICE_CLIENT_SECRET_${runtime}")
done

# Repair: an earlier append onto a last line without a trailing newline glued "KEY=…" onto the previous entry (e.g. the
# PEM inside OTEL_EXPORTER_OTLP_HEADERS, which then broke OTLP auth). Split such lines; when a key then occurs more than
# once, keep the last occurrence — the value compose was already using. Values are never printed.
repair() {
  local tmp names
  names="$(IFS='|'; echo "${managed[*]}")"
  tmp="$(mktemp "$out.XXXXXX")"
  awk -v names="$names" '
    BEGIN { n = split(names, k, "|") }
    /^[[:space:]]*#/ { out[++m] = $0; next }
    {
      line = $0
      do {
        cut = 0
        for (i = 1; i <= n; i++) {
          p = index(line, k[i] "=")
          if (p > 1 && (cut == 0 || p < cut)) cut = p
        }
        if (cut > 0) { out[++m] = substr(line, 1, cut - 1); line = substr(line, cut); split_count++ }
      } while (cut > 0)
      out[++m] = line
    }
    END {
      for (j = m; j >= 1; j--) {
        key = out[j]; sub(/=.*/, "", key)
        managed_key = 0
        for (i = 1; i <= n; i++) if (key == k[i]) managed_key = 1
        if (managed_key && (key in seen)) { drop[j] = 1; dropped++ } else if (managed_key) seen[key] = 1
      }
      for (j = 1; j <= m; j++) if (!(j in drop)) print out[j]
      printf "%d %d\n", split_count + 0, dropped + 0 > "/dev/stderr"
    }' "$out" > "$tmp" 2> "$tmp.stats"
  read -r split dup < "$tmp.stats"
  rm -f "$tmp.stats"
  if [[ "$split" -gt 0 ]]; then
    mv "$tmp" "$out"
    echo "ensure-local-vars: repaired ${split} glued line(s); removed ${dup} superseded duplicate(s) (values never printed)"
  else
    rm -f "$tmp"
  fi
}
repair
# Appends below must start on a fresh line.
if [[ -s "$out" && -n "$(tail -c 1 "$out")" ]]; then printf '\n' >> "$out"; fi
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
# A KEK that does not decode to exactly 32 bytes (e.g. an older hex value) is replaced too; ingestion refuses it.
kek_ok() {
  local v
  v="$(sed -n 's/^INGESTION_KEK_BASE64=//p' "$out" | tail -n 1)"
  [[ -n "$v" ]] && [[ "$(printf '%s' "$v" | base64 -d 2>/dev/null | wc -c | tr -d ' ')" == "32" ]]
}
if ! has INGESTION_KEK_BASE64 || ! kek_ok; then
  drop INGESTION_KEK_BASE64
  echo "INGESTION_KEK_BASE64=$(openssl rand -base64 32)" >> "$out"
  added+=(INGESTION_KEK_BASE64)
fi
for name in "${managed[@]}"; do
  [[ "$name" == SERVICE_CLIENT_SECRET_* ]] || continue
  if ! has "$name"; then
    drop "$name"
    echo "${name}=$(openssl rand -hex 32)" >> "$out"
    added+=("$name")
  fi
done
chmod 600 "$out"
echo "ensure-local-vars: added ${#added[@]} key(s)${added:+: ${added[*]}} (values never printed)"
