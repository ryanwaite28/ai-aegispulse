#!/usr/bin/env bash
# PreToolUse guard for AegisPulse (PROJECT.md §12 rules 6, 11, 13).
# Blocks: edits to committed migrations, hand edits to generated contract code,
# and writes to secret-bearing files. Exit 2 = block (stderr is shown to Claude).
set -euo pipefail

input="$(cat)"
path="$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' <<<"$input")"
[[ -z "$path" ]] && exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
rel="${path#"$root"/}"

block() { echo "BLOCKED by .claude/hooks/guard-files.sh: $1" >&2; exit 2; }

# 1) Secret-bearing files (never author these; use Infisical / .env.example)
case "$(basename "$rel")" in
  .env.example) ;;
  .env|.env.*) block "'$rel' holds secrets. Edit .env.example and use 'make env' (Infisical export) instead." ;;
  *.pem|*.key|*.p12|*.pfx|id_rsa*|id_ed25519*) block "'$rel' looks like private key material. Keys live in Infisical / GitLab masked variables (ADR-0012)." ;;
esac

# 2) Generated contract code
if [[ "$rel" == packages/contracts/generated/* ]]; then
  block "'$rel' is generated. Change the source schema in packages/contracts and run 'make contracts' (PROJECT.md §12 rule 13)."
fi

# 3) Committed migrations are immutable
is_migration=false
if [[ "$rel" =~ /db/migrations?/V[0-9]+__.*\.sql$ || "$rel" =~ ^services/[^/]+/src/main/resources/db/migration/V[0-9]+__.*\.sql$ || "$rel" =~ /mongo-migrations/.+\.(js|ts)$ ]]; then
  is_migration=true
fi
if $is_migration && [[ -f "$path" ]]; then
  if git -C "$root" rev-parse --verify -q HEAD >/dev/null 2>&1 && git -C "$root" cat-file -e "HEAD:$rel" 2>/dev/null; then
    block "'$rel' is a committed migration and is immutable. Create a new V{n+1}__*.sql (expand/contract) instead (PROJECT.md §12 rule 11, ADR-0005)."
  fi
fi

exit 0
