#!/bin/sh
# Brief test runs for Claude Code sessions (docs/steering/local-llm.md): run a suite, keep the full log on disk, and
# print only the exit code, the log path and a local-LLM triage of the log (fallback: the last 60 lines when Ollama
# is unavailable or refuses). The suite's exit code is preserved, so `make test-*-brief` gates exactly like
# `make test-*`. The triage is a lead, never evidence: confirm a failure by re-running it narrowly.
# Usage: scripts/llm/brief.sh NAME COMMAND [ARGS...]
# BRIEF_LOG_DIR overrides the log directory (sessions pass their scratchpad).
set -u
[ "$#" -ge 2 ] || { echo "usage: $0 NAME COMMAND [ARGS...]" >&2; exit 2; }
name=$1
shift
dir=${BRIEF_LOG_DIR:-${TMPDIR:-/tmp}/aegispulse-brief}
mkdir -p "$dir"
log="$dir/$name-$(date +%Y%m%d-%H%M%S).log"

"$@" >"$log" 2>&1
rc=$?
echo "brief: $name exit=$rc lines=$(wc -l <"$log" | tr -d ' ') log=$log"

if summary=$(python3 "$(dirname "$0")/ollama_offload.py" run summarize-log -f "$log" 2>/dev/null); then
  printf '%s\n' "$summary"
else
  echo "brief: local summary unavailable (exit $?); last 60 lines:"
  tail -n 60 "$log"
fi
exit "$rc"
