#!/usr/bin/env bash
# Runs a command with its FULL output in a log file and prints only the end.
# This is the quiet-output rule as a tool (docs/WORKFLOW.md, "Spend less").
#
#   scripts/dev/quiet.sh <name> -- <command...>
#
# The log is <scratch>/logs/<name>.log, where <scratch> is $STACK_SCRATCH
# (default: ${TMPDIR:-/tmp}/wawu-stack). The last line of the log is "EXIT <code>".
# Prints the last 15 lines of the log; on failure, also up to 20 lines that
# match FAIL, Error, a cross mark or "failed". Exits with the command's code.
set -u

usage() { echo "usage: quiet.sh <name> -- <command...>" >&2; exit 2; }

[ "$#" -ge 3 ] || usage
NAME="$1"; shift
[ "$1" = "--" ] || usage
shift
case "$NAME" in *[!A-Za-z0-9._-]*|"") echo "quiet.sh: the name may hold only letters, digits, . _ -" >&2; exit 2 ;; esac

SCRATCH="${STACK_SCRATCH:-${TMPDIR:-/tmp}/wawu-stack}"
LOG="$SCRATCH/logs/$NAME.log"
mkdir -p "$SCRATCH/logs" || { echo "quiet.sh: cannot create $SCRATCH/logs" >&2; exit 2; }

"$@" > "$LOG" 2>&1
CODE=$?
echo "EXIT $CODE" >> "$LOG"

tail -n 15 "$LOG" | cut -c1-200
if [ "$CODE" -ne 0 ]; then
  MATCHES="$(grep -n -m 20 -E 'FAIL|Error|✕|failed' "$LOG" | cut -c1-200 || true)"
  if [ -n "$MATCHES" ]; then
    echo "--- failure lines (up to 20) ---"
    printf '%s\n' "$MATCHES"
  fi
  echo "--- full log: $LOG ---"
fi
exit "$CODE"
