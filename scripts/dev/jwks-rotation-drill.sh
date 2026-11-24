#!/usr/bin/env bash
# Local JWKS rotation drill (FR-AUTH-05; docs/runbooks/key-rotation.md "Drill"). Operator-run.
# Rotates the registry signing key to a throwaway key through a temporary compose override (.env is never modified),
# checks that a token signed by the previous key keeps working through the gateway and that new tokens carry the new
# kid, then restores the normal key. Prints statuses and key ids only: the platform-admin password is read from .env
# into the environment of a Python helper (never a command-line argument) and tokens never leave that helper.
# Requires `make up` and the bootstrap PLATFORM_ADMIN (registry-bootstrap).
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$root"
compose=(docker compose --env-file .env -f deploy/compose/docker-compose.yml)
work="$(mktemp -d)"
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

E2E_PA_PASSWORD="$(sed -n 's/^PLATFORM_ADMIN_BOOTSTRAP_PASSWORD=//p' .env | tail -n 1)"
export E2E_PA_PASSWORD DRILL_STATE="$work/state.json"

# step <name>: login + JWKS + /me checks inside Python; the previous step's token is kept in a 0700 temp dir.
step() {
  python3 -I - "$1" <<'PY'
import base64, json, os, sys, urllib.request, urllib.error
base, step, state = "http://127.0.0.1:8080", sys.argv[1], os.environ["DRILL_STATE"]
def req(method, path, token=None, body=None):
    r = urllib.request.Request(base + path, method=method, data=None if body is None else json.dumps(body).encode(),
        headers={"content-type": "application/json", **({"authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(r, timeout=30) as res: return res.status, json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e: return e.code, {}
def kid(t):
    h = t.split(".")[0]; h += "=" * (-len(h) % 4); return json.loads(base64.urlsafe_b64decode(h))["kid"]
_, login = req("POST", "/v1/auth/login", body={"tenantSlug": "platform", "email": "admin@aegispulse.local",
                                              "password": os.environ["E2E_PA_PASSWORD"]})
token = login["data"]["accessToken"]
_, jwks = req("GET", "/.well-known/jwks.json")
kept = json.load(open(state)) if os.path.exists(state) else {}
line = f"{step}: jwks={[k['kid'] for k in jwks['keys']]} new-login kid={kid(token)} /me(new)={req('GET', '/v1/auth/me', token)[0]}"
if "first" in kept:
    line += f" /me(token from before rotation, kid={kid(kept['first'])})={req('GET', '/v1/auth/me', kept['first'])[0]}"
else:
    kept["first"] = token
    with open(state, "w") as f: json.dump(kept, f)
os.chmod(state, 0o600)
print(line)
PY
}

restart() {
  "${compose[@]}" "$@" up -d --force-recreate registry >/dev/null 2>&1
  WAIT_PROBE=readyz scripts/dev/compose-wait.sh >/dev/null 2>&1
}

step "1 before"
drill_kid="drill-$(date -u +%Y%m%d%H%M%S)"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$work/key.pem" 2>/dev/null
cat > "$work/override.yml" <<YML
services:
  registry:
    environment:
      JWT_SIGNING_KEY_CURRENT_PEM: \${DRILL_PEM}
      JWT_SIGNING_KEY_CURRENT_KID: $drill_kid
YML
DRILL_PEM="$(cat "$work/key.pem")" restart -f "$work/override.yml"
step "2 rotated"
restart
step "3 restored"
echo "jwks-rotation-drill: done (the drill key stays PREVIOUS for 24 h, then retires; it was never stored outside $work)"
