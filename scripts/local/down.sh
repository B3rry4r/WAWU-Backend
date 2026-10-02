#!/usr/bin/env bash
# Stops what `scripts/local/up.sh --detach` started. See docs/LOCAL.md.
set -euo pipefail

STATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.local"
stopped=0
for name in hub-api wawu-id; do
  pidfile="$STATE_DIR/$name.pid"
  [[ -f "$pidfile" ]] || continue
  pid="$(cat "$pidfile")"
  if kill "$pid" 2>/dev/null; then
    echo "Stopped $name (pid $pid)"
    stopped=$((stopped + 1))
  else
    echo "$name (pid $pid) was not running"
  fi
  rm -f "$pidfile"
done
(( stopped > 0 )) || echo "Nothing to stop."
