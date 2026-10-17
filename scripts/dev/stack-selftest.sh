#!/usr/bin/env bash
# Self-test for the port checks in stack.sh (FIX-57). Needs only node and /proc: no database, no build, no stack.
#
#   scripts/dev/stack-selftest.sh [base-port]      default base 7850; it uses base .. base+7 and nothing else
#
# It starts dummy listeners and checks that
#   1. `stack.sh up` refuses when a port of the range is already listening (inside the range, and a wildcard one on
#      the Hub's own port), says which process holds it, and creates nothing;
#   2. a service that dies on EADDRINUSE is never reported UP because another process answers on its port;
#   3. a service whose own process (or a child of it) holds its port is UP;
#   4. `stack.sh status` says NOT OURS for a port held by another process and `listening` for the service's own.
# Prints one line per check and ends with `EXIT 0` (all passed) or `EXIT 1`. Everything it starts is stopped on exit.
set -uo pipefail

DEV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${1:-7850}"
[[ "$BASE" =~ ^[0-9]+$ ]] || { echo "base port must be a number" >&2; exit 2; }
P_RANGE=$((BASE + 3)); P_FOREIGN=$((BASE + 4)); P_OWN=$((BASE + 5)); P_CHILD=$((BASE + 6)); P_END=$((BASE + 7))
RANGE="$BASE-$P_END"

# shellcheck source=scripts/dev/stack-ports.sh
. "$DEV_DIR/stack-ports.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/stack-selftest.XXXXXX")" || exit 2
MINE=()   # PIDs this script started
cleanup() {
  local p c
  for p in "${MINE[@]:-}"; do
    [ -n "$p" ] || continue
    for c in $(descendants "$p"); do kill "$c" 2>/dev/null; done   # children first: killing the parent would orphan them
    kill "$p" 2>/dev/null
  done
  for p in "${MINE[@]:-}"; do [ -n "$p" ] && wait "$p" 2>/dev/null; done
  rm -rf "$TMP"
}
trap cleanup EXIT

FAILS=0
ok()   { printf 'ok    %s\n' "$*"; }
bad()  { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }
check() { local what="$1"; shift; if "$@"; then ok "$what"; else bad "$what"; fi; }

# serve <port> <host>: a node HTTP server answering 200 on the port; sets SERVED to its PID. host "" = every address.
SERVED=""
serve() {
  node -e 'const [p,h]=process.argv.slice(1);require("http").createServer((q,r)=>r.end("ok")).listen(Number(p),h||undefined)' "$1" "${2:-}" &
  SERVED=$!; MINE+=("$SERVED")
  local i; for i in $(seq 1 50); do port_listening "$1" && return 0; sleep 0.1; done
  bad "dummy listener on $1 did not start"; return 1
}
unserve() { kill "$1" 2>/dev/null; wait "$1" 2>/dev/null; local i; for i in $(seq 1 50); do port_listening "$2" || return 0; sleep 0.1; done; }

# None of the test ports may be in use before we start: they are ours alone.
for p in $(seq "$BASE" "$P_END"); do
  if port_listening "$p"; then echo "port $p is already in use; not running" >&2; echo "EXIT 2"; exit 2; fi
done

UP_ENV=(env STACK_MIN_FREE_GB=0)

# ---- 1. refusals
serve "$P_RANGE" 127.0.0.1 || true
HOLDER=$SERVED
OUT="$("${UP_ENV[@]}" "$DEV_DIR/stack.sh" up --name selftest --ports "$RANGE" --scratch "$TMP/s1" 2>&1)"; RC=$?
check "up refuses a busy port inside the range (exit $RC)" test "$RC" -ne 0
check "  names the port as inside the range" grep -q "already in use: $P_RANGE (in the range)" <<< "$OUT"
check "  names the process holding it" grep -q "port $P_RANGE is held by pid $HOLDER " <<< "$OUT"
check "  says nothing was started" grep -q "Nothing was started" <<< "$OUT"
check "  created no state folder" test ! -e "$TMP/s1/selftest"
unserve "$HOLDER" "$P_RANGE"

serve "$BASE" "" || true   # every address, so IPv6 too: the Hub's own port
HOLDER=$SERVED
OUT="$("${UP_ENV[@]}" "$DEV_DIR/stack.sh" up --name selftest --ports "$RANGE" --scratch "$TMP/s1" 2>&1)"; RC=$?
check "up refuses a wildcard listener on the Hub's port (exit $RC)" test "$RC" -ne 0
check "  names the port as hub" grep -q "already in use: $BASE (hub)" <<< "$OUT"
unserve "$HOLDER" "$BASE"

# ---- 2. a service that died on EADDRINUSE is not UP just because the port answers
serve "$P_FOREIGN" 127.0.0.1 || true
FOREIGN=$SERVED
check "the foreign process answers on :$P_FOREIGN (what fooled the old check)" curl -sf -m 3 -o /dev/null "http://127.0.0.1:$P_FOREIGN/"
node -e 'require("net").createServer().listen(Number(process.argv[1]), "127.0.0.1")' "$P_FOREIGN" > "$TMP/dies.log" 2>&1 &
LOSER=$!; MINE+=("$LOSER")
wait_owned "$LOSER" "$P_FOREIGN" "http://127.0.0.1:$P_FOREIGN/" 10; RC=$?
check "a service that lost the port is not UP (exit $RC)" test "$RC" -ne 0
check "  says the port is held by the other process" grep -q "held by pid $FOREIGN " <<< "$WAIT_WHY"
check "  its log shows EADDRINUSE" grep -q EADDRINUSE "$TMP/dies.log"

# ---- 3. a service that holds its own port is UP, directly or through a child
node -e 'require("http").createServer((q,r)=>r.end("ok")).listen(Number(process.argv[1]), "127.0.0.1")' "$P_OWN" &
OWN=$!; MINE+=("$OWN")
wait_owned "$OWN" "$P_OWN" "http://127.0.0.1:$P_OWN/" 10; RC=$?
check "a service holding its own port is UP (exit $RC)" test "$RC" -eq 0
check "  a different process does not own that port" bash -c '. "$0"; ! owns_port "$1" "$2"' "$DEV_DIR/stack-ports.sh" "$FOREIGN" "$P_OWN"
cat > "$TMP/child.sh" <<'CHILD'
node -e 'require("http").createServer((q,r)=>r.end("ok")).listen(Number(process.argv[1]), "127.0.0.1")' "$1" &
wait
CHILD
sh "$TMP/child.sh" "$P_CHILD" &
PARENT=$!; MINE+=("$PARENT")
wait_owned "$PARENT" "$P_CHILD" "http://127.0.0.1:$P_CHILD/" 10; RC=$?
check "a listener that is a child of the service's process is UP (exit $RC)" test "$RC" -eq 0

# ---- 4. status
mkdir -p "$TMP/s2/sx"
ticks() { awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$1/stat"; }
printf 'mock-id %s %s %s\n' "$LOSER" "$P_FOREIGN" "$(ticks "$FOREIGN")" > "$TMP/s2/sx/pids"   # a recorded PID whose port is held by another
OUT="$("$DEV_DIR/stack.sh" status --name sx --scratch "$TMP/s2" 2>&1)"; RC=$?
check "status flags a port held by another process (exit $RC)" test "$RC" -ne 0
check "  prints NOT OURS with the holder" grep -q "NOT OURS: port held by pid $FOREIGN " <<< "$OUT"
printf 'mock-id %s %s %s\n' "$OWN" "$P_OWN" "$(ticks "$OWN")" > "$TMP/s2/sx/pids"
OUT="$("$DEV_DIR/stack.sh" status --name sx --scratch "$TMP/s2" 2>&1)"; RC=$?
check "status is clean for a service holding its own port (exit $RC)" test "$RC" -eq 0
check "  prints listening" grep -q "listening" <<< "$OUT"

if [ "$FAILS" -eq 0 ]; then echo "all checks passed"; echo "EXIT 0"; exit 0; fi
echo "$FAILS check(s) failed"; echo "EXIT 1"; exit 1
