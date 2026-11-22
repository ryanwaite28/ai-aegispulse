#!/bin/sh
# Renders *.tmpl files under /templates into /rendered, replacing __NAME__ with the value of env var NAME.
# Generated secrets are hex/base64url (no '|' or '&'), which keeps sed substitution safe.
set -eu
find /templates -name '*.tmpl' | while read -r tpl; do
  rel=${tpl#/templates/}
  out="/rendered/${rel%.tmpl}"
  mkdir -p "$(dirname "$out")"
  content=$(cat "$tpl")
  names=$(grep -o '__[A-Z0-9_]*__' "$tpl" | sort -u | sed 's/__//g')
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    val=$(printenv "$name" || true)
    if [ -z "$val" ]; then echo "render.sh: missing env var $name for $rel" >&2; exit 1; fi
    content=$(printf '%s' "$content" | sed "s|__${name}__|${val}|g")
  done <<EOF
$names
EOF
  printf '%s\n' "$content" > "$out"
  echo "rendered $rel"
done
