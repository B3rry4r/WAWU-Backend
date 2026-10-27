#!/usr/bin/env bash
# One command to start and stop a local test stack (OPS-STACK). Read README.md,
# "Local test stack", first.
#
#   scripts/dev/stack.sh up --name <n> --ports <a>-<b> [--with id,web,mobile]
#                           [--web <path>] [--id <path>] [--mobile <path>]
#                           [--rebuild] [--scratch <dir>]
#   scripts/dev/stack.sh status --name <n> [--scratch <dir>]
#   scripts/dev/stack.sh down   --name <n> [--scratch <dir>]
#
# Always started (from this repo): a database <n>_wawu_hub_test, its migrations,
# the Hub on port a, a local Nuvion stand-in (scripts/dev/nuvion-standin.cjs) on
# port b-1, and the mock WAWU ID (the one the contract suite uses) on port b, the
# last port of the range. The Hub always runs WALLET_PROVIDER=nuvion: every wallet
# call goes to the stand-in (nuvion-redirect.cjs sends the one Nuvion sandbox host
# there; the stand-in signs its webhooks with a test secret the stack sets).
# Payments use the repo's own in-process Flutterwave mock (no key set); Fintava
# stays pointed at a closed port on this machine and is never used;
# block-net.cjs refuses any request to a host that is not this machine.
# With --with:
#   id      the real wawu-id (--id <path>) on a+1, database <n>_wawu_id_test;
#           the Hub then signs people in through it instead of the mock
#   web     the web production build (--web <path>, VERCEL_ENV=production) on a+2
#   mobile  the mobile web export (--mobile <path>, own Metro cache) on a+3
#
# Logs: <scratch>/<n>/logs/. PIDs: <scratch>/<n>/pids. <scratch> is --scratch,
# else $STACK_SCRATCH, else ${TMPDIR:-/tmp}/wawu-stack. Pass the same one to
# status and down. Source <scratch>/<n>/env.sh to point a single spec at the stack.
#
# Settings (environment): STACK_PG_URL (default postgresql://postgres:postgres@localhost:5432,
# local only), STACK_MIN_FREE_GB (default 5), WAWU_ID_DIR, WAWU_WEB_DIR, WAWU_MOBILE_DIR
# (defaults for --id, --web, --mobile), STACK_NM_HUB, STACK_NM_ID, STACK_NM_WEB,
# STACK_NM_MOBILE (a node_modules folder to hard-link when the lockfile is the same;
# otherwise npm ci runs).
# STACK_SIGNUP_VERIFY_CHANNEL (default email, R-72) is WAWU ID's SIGNUP_VERIFY_CHANNEL on this stack: the sign-up code is
# mailed, as at launch. WAWU ID's own default stays phone (production sets it); a stack with no text transport could not
# sign anyone up on it (SWEEP-FLOWS B1). Set it to phone only to test the texted path.
# STACK_STORAGE_ENDPOINT / STACK_STORAGE_PATH_STYLE=true point the Hub's object storage at a stand-in on this
# machine (for example http://127.0.0.1:7184), so a spec can see the Hub's own storage calls (deletes included).
# Left unset, the endpoint is a name block-net.cjs refuses, which is what a spec that never reaches storage wants.
#
# A service is UP only when its own process (or a child of it) is the listener on its port, not merely when the
# port answers (FIX-57; scripts/dev/stack-ports.sh). `up` refuses when any port of the range is already listening,
# `status` says NOT OURS for a port another process holds, and scripts/dev/stack-selftest.sh checks all of it.
#
# The stand-in's control routes, and how to seed a funded wallet and fire a webhook:
# README.md, "Local test stack", and scripts/dev/nuvion-tool.cjs.
#
# It never calls a real provider, a wawuafrica.com host or the production Hub.
set -uo pipefail

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEV_DIR="$HUB_DIR/scripts/dev"
PG_BASE="${STACK_PG_URL:-postgresql://postgres:postgres@localhost:5432}"
PG_BASE="${PG_BASE%/}"
MIN_FREE_GB="${STACK_MIN_FREE_GB:-5}"

# dotenv (which Prisma's config and the services load) obeys DOTENV_*. A value
# left in the shell could make a service read some other file.
for v in $(compgen -e | grep -E '^DOTENV_' || true); do unset "$v"; done

say() { printf '%s\n' "$*"; }
die() { printf 'stack.sh: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; exit 2; }

# ---------------------------------------------------------------- arguments
CMD="${1:-}"
[ -n "$CMD" ] || usage
shift
NAME=""; PORTS=""; WITH=""; REBUILD=0; SCRATCH_ARG=""
WEB_DIR="${WAWU_WEB_DIR:-}"; ID_DIR="${WAWU_ID_DIR:-}"; MOBILE_DIR="${WAWU_MOBILE_DIR:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --name)    [ "$#" -ge 2 ] || die "--name needs a value"; NAME="$2"; shift 2 ;;
    --ports)   [ "$#" -ge 2 ] || die "--ports needs a value"; PORTS="$2"; shift 2 ;;
    --with)    [ "$#" -ge 2 ] || die "--with needs a value"; WITH="$2"; shift 2 ;;
    --web)     [ "$#" -ge 2 ] || die "--web needs a path"; WEB_DIR="$2"; shift 2 ;;
    --id)      [ "$#" -ge 2 ] || die "--id needs a path"; ID_DIR="$2"; shift 2 ;;
    --mobile)  [ "$#" -ge 2 ] || die "--mobile needs a path"; MOBILE_DIR="$2"; shift 2 ;;
    --scratch) [ "$#" -ge 2 ] || die "--scratch needs a folder"; SCRATCH_ARG="$2"; shift 2 ;;
    --rebuild) REBUILD=1; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

case "$CMD" in up|status|down) ;; -h|--help) usage ;; *) die "unknown command: $CMD (up, status or down)" ;; esac
[[ "$NAME" =~ ^[a-z][a-z0-9_]{0,19}$ ]] || die "--name is required: lower case letters, digits and _, starting with a letter, at most 20 characters"

SCRATCH="${SCRATCH_ARG:-${STACK_SCRATCH:-${TMPDIR:-/tmp}/wawu-stack}}"
case "$SCRATCH" in /*) ;; *) SCRATCH="$PWD/$SCRATCH" ;; esac
STATE="$SCRATCH/$NAME"
LOGS="$STATE/logs"
PIDS="$STATE/pids"
ENVF="$STATE/stack.env"
DB_HUB="${NAME}_wawu_hub_test"
DB_ID="${NAME}_wawu_id_test"

# ---------------------------------------------------------------- helpers
# port_open, port_listening, listener_pids, owns_port, wait_owned and descendants (FIX-57: a port that
# answers is not proof the service holds it; its own process must be the listener).
# shellcheck source=scripts/dev/stack-ports.sh
. "$DEV_DIR/stack-ports.sh"

# Field 22 of /proc/<pid>/stat: when the process started. A PID that was reused
# by another process has a different value, so a recorded PID is only trusted
# when this still matches.
proc_ticks() { awk '{ sub(/^.*\) /, ""); print $20 }' "/proc/$1/stat" 2>/dev/null; }
alive_same() { [ -d "/proc/$1" ] && [ "$(proc_ticks "$1")" = "$2" ]; }

# Stops a PID and its children: TERM, up to 8 seconds of grace, then KILL.
stop_tree() {
  local pid="$1" all p n
  all="$pid $(descendants "$pid" | tr '\n' ' ')"
  for p in $all; do kill -TERM "$p" 2>/dev/null || true; done
  for n in $(seq 1 16); do
    local left=0
    for p in $all; do [ -d "/proc/$p" ] && left=1; done
    [ "$left" -eq 0 ] && return 0
    sleep 0.5
  done
  for p in $all; do kill -KILL "$p" 2>/dev/null || true; done
}

pg_host_ok() {
  [[ "$PG_BASE" =~ ^postgres(ql)?://([^@/]*@)?([^:/]+)(:[0-9]+)?$ ]] || return 1
  case "${BASH_REMATCH[3]}" in localhost|127.0.0.1) return 0 ;; *) return 1 ;; esac
}
psql_admin() { psql "$PG_BASE/postgres" -v ON_ERROR_STOP=1 -qAt "$@"; }
db_exists() { [ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname = '$1'" 2>/dev/null)" = "1" ]; }

free_gb() { free -g | awk '/^Mem:/ { print $7 }'; }

rand_hex() { node -p 'require("crypto").randomBytes(24).toString("hex")'; }

# ---------------------------------------------------------------- status
cmd_status() {
  if [ ! -f "$PIDS" ]; then say "stack $NAME: not running (no pids in $STATE)"; return 0; fi
  local bad=0 name pid port ticks state alive foreign=""
  while read -r name pid port ticks; do
    [ -n "$name" ] || continue
    alive=0; alive_same "$pid" "$ticks" && alive=1
    # UP means this service's own process holds the port, not just that the port answers.
    if (( alive )) && owns_port "$pid" "$port"; then state="listening"
    elif port_listening "$port"; then
      state="NOT OURS: port held by $(holder_text "$port") ($( (( alive )) && echo "this process alive, not the listener" || echo "this process gone"))"
      bad=1; foreign="$foreign $name"
    elif (( alive )); then state="NOT listening (process alive)"; bad=1
    else state="NOT listening (process gone)"; bad=1; fi
    printf '%-9s :%-5s pid %-7s %s\n' "$name" "$port" "$pid" "$state"
  done < "$PIDS"
  for name in $foreign; do
    [ -f "$LOGS/$name.log" ] || continue
    say "last 10 lines of $LOGS/$name.log:"
    tail -n 10 "$LOGS/$name.log" | cut -c1-200 | sed 's/^/  | /'
  done
  local prov="" nport=""
  [ -f "$ENVF" ] && prov="$(sed -n 's/^WALLET_PROVIDER=//p' "$ENVF")" && nport="$(sed -n 's/^NUV_PORT=//p' "$ENVF")"
  [ -n "$prov" ] && printf 'provider  %s (stand-in on :%s)\n' "$prov" "$nport"
  return "$bad"
}

# ---------------------------------------------------------------- down
cmd_down() {
  local bad=0 name pid port ticks ports=""
  if [ -f "$PIDS" ]; then
    # newest first, so the web and the Hub stop before what they call
    local lines; lines="$(tac "$PIDS")"
    while read -r name pid port ticks; do
      [ -n "$name" ] || continue
      ports="$ports $port"
      if alive_same "$pid" "$ticks"; then
        stop_tree "$pid"
        say "stopped $name (pid $pid)"
      else
        say "$name (pid $pid) was not running"
      fi
    done <<< "$lines"
    local still=""
    for port in $ports; do
      for _ in $(seq 1 20); do port_open "$port" || break; sleep 0.5; done
      port_open "$port" && still="$still $port"
    done
    if [ -n "$still" ]; then say "STILL OPEN:$still"; bad=1; else say "ports closed:$ports"; fi
  else
    say "stack $NAME: nothing running (already down)"
  fi

  if pg_host_ok && psql_admin -c "SELECT 1" >/dev/null 2>&1; then
    local db
    for db in "$DB_HUB" "$DB_ID"; do
      if db_exists "$db"; then
        if psql_admin -c "DROP DATABASE \"$db\" WITH (FORCE)" >/dev/null 2>&1; then say "dropped database $db"
        else say "could not drop database $db"; bad=1; fi
      fi
    done
  else
    say "Postgres not reachable: databases $DB_HUB and $DB_ID not checked"; bad=1
  fi

  rm -f "$PIDS" "$ENVF" "$STATE/env.sh"
  rm -rf "$STATE/tmp" "$STATE/mobile-dist" "$STATE/keys"
  return "$bad"
}

[ "$CMD" = "status" ] && { cmd_status; exit $?; }
[ "$CMD" = "down" ] && { cmd_down; exit $?; }

# ================================================================ up
[[ "$PORTS" =~ ^([0-9]+)-([0-9]+)$ ]] || die "--ports <a>-<b> is required, for example --ports 6531-6534"
PORT_A="${BASH_REMATCH[1]}"; PORT_B="${BASH_REMATCH[2]}"
(( PORT_A >= 1024 && PORT_B <= 65535 && PORT_A < PORT_B )) || die "--ports must be two ports from 1024 up with the first below the last"

WITH_ID=0; WITH_WEB=0; WITH_MOBILE=0
IFS=',' read -r -a WITH_LIST <<< "$WITH"
for w in "${WITH_LIST[@]:-}"; do
  case "$w" in
    "") ;;
    id) WITH_ID=1 ;;
    web) WITH_WEB=1 ;;
    mobile) WITH_MOBILE=1 ;;
    *) die "--with takes id, web and mobile (comma separated), not \"$w\"" ;;
  esac
done

HUB_PORT=$PORT_A
ID_PORT=$((PORT_A + 1))
WEB_PORT=$((PORT_A + 2))
MOB_PORT=$((PORT_A + 3))
MOCK_PORT=$PORT_B
NUV_PORT=$((PORT_B - 1))
TOP=$HUB_PORT
(( WITH_ID )) && TOP=$ID_PORT
(( WITH_WEB )) && TOP=$WEB_PORT
(( WITH_MOBILE )) && TOP=$MOB_PORT
# What each service listens on: the Hub on a, then id, web and mobile on a+1, a+2 and a+3, and the mock WAWU ID on b.
USED_PORTS=("$HUB_PORT:hub")
(( WITH_ID )) && USED_PORTS+=("$ID_PORT:wawu-id")
(( WITH_WEB )) && USED_PORTS+=("$WEB_PORT:web")
(( WITH_MOBILE )) && USED_PORTS+=("$MOB_PORT:mobile")
if (( NUV_PORT <= TOP )); then
  ASKED=""
  for pair in "${USED_PORTS[@]}"; do ASKED="$ASKED ${pair#*:} ${pair%%:*},"; done
  die "the range $PORTS is too small. Needed:${ASKED% ,}, the Nuvion stand-in on the port below the last, and the mock WAWU ID on the last port, which must be above $((TOP + 1)) (for example --ports $PORT_A-$((TOP + 2)))"
fi
USED_PORTS+=("$NUV_PORT:nuvion" "$MOCK_PORT:mock-id")

# ---------------------------------------------------------------- refusals (nothing is changed before these pass)
[ ! -f "$ENVF" ] || die "stack $NAME already exists ($STATE). Stop it first: scripts/dev/stack.sh down --name $NAME"
if [ "${NODE_ENV:-}" = "production" ]; then die "NODE_ENV is production. This is for a local machine only."; fi

FREE="$(free_gb)"
[[ "$FREE" =~ ^[0-9]+$ ]] || die "cannot read free memory from \`free -g\`"
(( FREE >= MIN_FREE_GB )) || die "only ${FREE} GB of memory available; a stack needs at least $MIN_FREE_GB GB. Wait a minute and try again. Nothing was started."

# Every port of the range, not only the ones this stack uses (FIX-57): a listener anywhere in the range means
# two stacks were given overlapping ranges.
[ -r /proc/net/tcp ] || die "this needs Linux (/proc/net/tcp) to tell which process holds a port"
BUSY=""
LISTENING=" $(listening_hexes | tr '\n' ' ')"
for (( p = PORT_A; p <= PORT_B; p++ )); do
  printf -v hex '%04X' "$p"
  if [[ "$LISTENING" == *" $hex "* ]] || port_open "$p"; then
    label="in the range"
    for pair in "${USED_PORTS[@]}"; do [ "${pair%%:*}" = "$p" ] && label="${pair#*:}"; done
    BUSY="$BUSY $p ($label)"
    printf 'stack.sh: port %s is held by %s\n' "$p" "$(holder_text "$p")" >&2
  fi
done
[ -z "$BUSY" ] || die "already in use:$BUSY. Choose other ports with --ports, or stop what uses them. Nothing was started."

command -v node >/dev/null || die "node is not installed"
(( $(node -p 'process.versions.node.split(".")[0]') >= 22 )) || die "Node 22 or newer is required"
command -v psql >/dev/null || die "psql is not installed"
command -v curl >/dev/null || die "curl is not installed"
command -v flock >/dev/null || die "flock is not installed"
pg_host_ok || die "STACK_PG_URL must be a local Postgres (localhost or 127.0.0.1) with no database name"
psql_admin -c "SELECT 1" >/dev/null 2>&1 || die "Postgres is not reachable at $PG_BASE (start it: service postgresql start)"

if (( WITH_ID )); then
  [ -n "$ID_DIR" ] || die "--with id needs --id <path to a wawu-id checkout>"
  ID_DIR="$(cd "$ID_DIR" 2>/dev/null && pwd)" || die "--id path does not exist"
  grep -q '"name": "WAWU-ID"' "$ID_DIR/package.json" 2>/dev/null || die "$ID_DIR is not a wawu-id checkout"
fi
if (( WITH_WEB )); then
  [ -n "$WEB_DIR" ] || die "--with web needs --web <path to a wawuafrica checkout>"
  WEB_DIR="$(cd "$WEB_DIR" 2>/dev/null && pwd)" || die "--web path does not exist"
  grep -q '"next"' "$WEB_DIR/package.json" 2>/dev/null || die "$WEB_DIR is not the web app"
  # The web build writes .next inside the checkout, so one checkout serves one stack at a time.
  for other in "$SCRATCH"/*/stack.env; do
    [ -f "$other" ] || continue
    if grep -qx "WEB_DIR=$WEB_DIR" "$other"; then die "another stack ($(basename "$(dirname "$other")")) is using $WEB_DIR. Give this one its own worktree."; fi
  done
fi
if (( WITH_MOBILE )); then
  [ -n "$MOBILE_DIR" ] || die "--with mobile needs --mobile <path to the mobile app checkout>"
  MOBILE_DIR="$(cd "$MOBILE_DIR" 2>/dev/null && pwd)" || die "--mobile path does not exist"
  [ -f "$MOBILE_DIR/app.json" ] || die "$MOBILE_DIR is not the mobile app"
fi

# ---------------------------------------------------------------- state
mkdir -p "$LOGS" || die "cannot create $LOGS"
{
  echo "NAME=$NAME"
  echo "PORTS=$PORTS"
  echo "WITH=$WITH"
  echo "HUB_PORT=$HUB_PORT"
  echo "MOCK_PORT=$MOCK_PORT"
  echo "NUV_PORT=$NUV_PORT"
  echo "WALLET_PROVIDER=nuvion"
  echo "DB_HUB=$DB_HUB"
  (( WITH_ID )) && { echo "ID_PORT=$ID_PORT"; echo "DB_ID=$DB_ID"; echo "ID_DIR=$ID_DIR"; }
  (( WITH_WEB )) && { echo "WEB_PORT=$WEB_PORT"; echo "WEB_DIR=$WEB_DIR"; }
  (( WITH_MOBILE )) && { echo "MOB_PORT=$MOB_PORT"; echo "MOBILE_DIR=$MOBILE_DIR"; }
} > "$ENVF"
: > "$PIDS"

SUMMARY=()   # name|url|pid|state
FAIL_NAME=""; FAIL_LOG=""; FAIL_WHY=""

# A Ctrl-C or kill during `up` stops what it started.
on_signal() { echo; echo "interrupted: stopping stack $NAME"; cmd_down >/dev/null 2>&1; exit 130; }
trap on_signal INT TERM

record_pid() { echo "$1 $2 $3 $(proc_ticks "$2")" >> "$PIDS"; }

LENV=()
# launch <name> <port> <cwd> <command...>, with the variables in LENV. Own session, own log.
launch() {
  local name="$1" port="$2" cwd="$3"; shift 3
  ( cd "$cwd" && exec env "${LENV[@]}" setsid "$@" ) > "$LOGS/$name.log" 2>&1 < /dev/null 9>&- &
  local pid=$!
  sleep 0.3
  record_pid "$name" "$pid" "$port"
  LAST_PID=$pid
}

# wait_up <name> <port> <url> <seconds>: 0 when the URL answers 2xx and this service's own process (LAST_PID) holds
# the port, 1 when the process died or time ran out. An answer from another process on the port does not count (FIX-57).
wait_up() {
  wait_owned "$LAST_PID" "$2" "$3" "$4"
}

# run_step <log-name> <cwd> <command...>: full output to the log; 0 on success.
run_step() {
  local name="$1" cwd="$2"; shift 2
  ( cd "$cwd" && "$@" ) > "$LOGS/$name.log" 2>&1
}

# service <name> <port> <cwd> <url> <wait-seconds> <command...>: launch, wait, record in the summary.
service() {
  local name="$1" port="$2" cwd="$3" url="$4" secs="$5"; shift 5
  launch "$name" "$port" "$cwd" "$@"
  # The address shown for a page (web, mobile) is the one the Hub's CORS list allows: localhost, not 127.0.0.1.
  # The health probe below keeps the address it was given.
  local shown="$url"
  case "$name" in web|mobile) shown="${url/127.0.0.1/localhost}" ;; esac
  if wait_up "$name" "$port" "$url" "$secs"; then
    SUMMARY+=("$name|$shown|$LAST_PID|UP")
    return 0
  fi
  SUMMARY+=("$name|$shown|$LAST_PID|FAILED")
  FAIL_NAME="$name"; FAIL_LOG="$LOGS/$name.log"; FAIL_WHY="$WAIT_WHY"
  return 1
}

fail_step() { FAIL_NAME="$1"; FAIL_LOG="$LOGS/$1.log"; SUMMARY+=("$1|-|-|FAILED"); }

# needs_build <output-file> <path...>: 0 when the output is missing or any path is newer than it.
needs_build() {
  local out="$1"; shift
  [ "$REBUILD" -eq 1 ] && return 0
  [ -f "$out" ] || return 0
  [ -n "$(find "$@" -newer "$out" -print -quit 2>/dev/null)" ]
}

# ensure_modules <dir> <label> <seed node_modules or empty>
ensure_modules() {
  local dir="$1" label="$2" seed="${3:-}"
  [ -d "$dir/node_modules" ] && return 0
  if [ -n "$seed" ] && [ -d "$seed" ] && cmp -s "$(dirname "$seed")/package-lock.json" "$dir/package-lock.json"; then
    cp -al "$seed" "$dir/node_modules" > "$LOGS/$label-install.log" 2>&1 && return 0
  fi
  run_step "$label-install" "$dir" npm ci --no-audit --no-fund
}

new_db() {
  psql_admin -c "DROP DATABASE IF EXISTS \"$1\" WITH (FORCE)" -c "CREATE DATABASE \"$1\"" > "$LOGS/db-$1.log" 2>&1
}

BUILD_LOCK="$SCRATCH/.build.lock"
mkdir -p "$SCRATCH"
SERVICE_KEY="stack-$NAME-$(rand_hex)"
ADMIN_SECRET="$(rand_hex)"; ADMIN_REFRESH="$(rand_hex)"
# Nuvion on this stack: a test webhook secret shared by the stand-in (signs) and the Hub (verifies), kept off disk,
# WAWU's operational account, and the fees (kobo; the stand-in charges what the Hub is told to quote).
NUVION_SECRET="stack-nuvion-whsec-$(rand_hex)"
NUVION_OPS_ID="01STACKOPERATIONAL0000001"
# The hosted selfie (FIX-47 L2): STACK_NUVION_LIVENESS=on gives the Hub NUVION_HOSTED_LIVENESS=on, and the app's return
# address (a string the Hub compares; nothing is ever sent to it) as the one it may hand the stand-in. Left unset it is off.
NUVION_LIVENESS="${STACK_NUVION_LIVENESS:-}"
case "$NUVION_LIVENESS" in ''|off|on) ;; *) echo "STACK_NUVION_LIVENESS must be on or off" >&2; exit 2;; esac
NUVION_LIVENESS_RETURN=""; [ "$NUVION_LIVENESS" = on ] && NUVION_LIVENESS_RETURN="https://wawuafrica.com/selfie"
NUVION_FEE_BOOK="${STACK_NUVION_FEE_BOOK:-0}"; NUVION_FEE_BANK="${STACK_NUVION_FEE_BANK:-2500}"; NUVION_FEE_IN="${STACK_NUVION_FEE_INFLOW:-0}"
# The WAWU card (WALLET-31): Nuvion's fee for making a card, as dev measured it on 24 Oct (65,772 kobo).
NUVION_FEE_CARD="${STACK_NUVION_FEE_CARD:-65772}"
HUB_DB_URL="$PG_BASE/$DB_HUB?schema=public"
ID_DB_URL="$PG_BASE/$DB_ID?schema=public"
BLOCK_NET="--require=$DEV_DIR/block-net.cjs"

# The identity service the Hub signs people in through.
if (( WITH_ID )); then IDP_PORT=$ID_PORT; else IDP_PORT=$MOCK_PORT; fi

build_all() {
  # ---- databases
  new_db "$DB_HUB" || { fail_step "db-$DB_HUB"; return 1; }
  if (( WITH_ID )); then new_db "$DB_ID" || { fail_step "db-$DB_ID"; return 1; }; fi

  # ---- Hub: modules, migrations, build (one at a time across stacks)
  ensure_modules "$HUB_DIR" hub "${STACK_NM_HUB:-}" || { fail_step hub-install; return 1; }
  run_step hub-migrate "$HUB_DIR" env DATABASE_URL="$HUB_DB_URL" npx --no-install prisma migrate deploy || { fail_step hub-migrate; return 1; }
  exec 9>"$BUILD_LOCK"; flock 9
  if [ ! -d "$HUB_DIR/generated/prisma" ] || needs_build "$HUB_DIR/dist/src/main.js" "$HUB_DIR/src" "$HUB_DIR/prisma" "$HUB_DIR/package.json" "$HUB_DIR/package-lock.json" "$HUB_DIR/tsconfig.json" "$HUB_DIR/tsconfig.build.json"; then
    run_step hub-build "$HUB_DIR" npm run build || { flock -u 9; fail_step hub-build; return 1; }
  else
    echo "dist is current; build skipped (--rebuild forces it)" > "$LOGS/hub-build.log"
  fi

  # ---- the mock WAWU ID (it writes its signing keys on its first start, so one at a time)
  LENV=(MOCK_WAWU_ID_PORT="$MOCK_PORT" WAWU_ID_INTERNAL_SERVICE_KEY="$SERVICE_KEY")
  service mock-id "$MOCK_PORT" "$HUB_DIR" "http://127.0.0.1:$MOCK_PORT/health" 30 node mock-wawu-id/server.js || { flock -u 9; return 1; }
  flock -u 9

  # ---- the Nuvion stand-in (the Hub's only wallet provider on this stack)
  LENV=(NUVION_STANDIN_PORT="$NUV_PORT" HUB_WEBHOOK_URL="http://127.0.0.1:$HUB_PORT/api/hub/webhooks/nuvion"
    NUVION_WEBHOOK_SECRET="$NUVION_SECRET" NUVION_OPERATIONAL_ACCOUNT_ID="$NUVION_OPS_ID"
    NUVION_FEE_BOOK_TRANSFER="$NUVION_FEE_BOOK" NUVION_FEE_BANK_PAYOUT="$NUVION_FEE_BANK" NUVION_FEE_INFLOW="$NUVION_FEE_IN"
    NUVION_FEE_CARD_CREATE="$NUVION_FEE_CARD"
    NODE_OPTIONS="$BLOCK_NET")
  service nuvion "$NUV_PORT" "$HUB_DIR" "http://127.0.0.1:$NUV_PORT/health" 30 node scripts/dev/nuvion-standin.cjs || return 1

  # ---- the real wawu-id
  if (( WITH_ID )); then
    ensure_modules "$ID_DIR" id "${STACK_NM_ID:-}" || { fail_step id-install; return 1; }
    mkdir -p "$STATE/keys"
    node -e '
      const c = require("crypto"), fs = require("fs"), d = process.argv[1];
      const k = c.generateKeyPairSync("rsa", { modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      fs.writeFileSync(d + "/private.pem", k.privateKey, { mode: 0o600 });
      fs.writeFileSync(d + "/public.pem", k.publicKey);' "$STATE/keys" || { fail_step id-keys; return 1; }
    run_step id-migrate "$ID_DIR" env DATABASE_URL="$ID_DB_URL" sh -c 'npx --no-install prisma generate && npx --no-install prisma migrate deploy' || { fail_step id-migrate; return 1; }
    exec 9>"$BUILD_LOCK"; flock 9
    if needs_build "$ID_DIR/dist/main.js" "$ID_DIR/src" "$ID_DIR/prisma" "$ID_DIR/package.json" "$ID_DIR/tsconfig.json" "$ID_DIR/tsconfig.build.json"; then
      run_step id-build "$ID_DIR" npm run build || { flock -u 9; fail_step id-build; return 1; }
    else
      echo "dist is current; build skipped (--rebuild forces it)" > "$LOGS/id-build.log"
    fi
    flock -u 9
    LENV=(DATABASE_URL="$ID_DB_URL" PORT="$ID_PORT" NODE_ENV=development
      RS256_PRIVATE_KEY="$(cat "$STATE/keys/private.pem")" RS256_PUBLIC_KEY="$(cat "$STATE/keys/public.pem")"
      JWT_EXPIRES_IN=15m REFRESH_EXPIRES_IN=30d INTERNAL_SERVICE_KEY="$SERVICE_KEY"
      RESEND_API_KEY="${STACK_RESEND_API_KEY:-}" APP_URL="http://localhost:$ID_PORT" ALLOWED_ORIGINS=
      SIGNUP_VERIFY_CHANNEL="${STACK_SIGNUP_VERIFY_CHANNEL:-email}"
      WAWUAFRICA_API_URL="http://127.0.0.1:$HUB_PORT" NODE_OPTIONS="$BLOCK_NET --max-old-space-size=1024")
    service wawu-id "$ID_PORT" "$ID_DIR" "http://127.0.0.1:$ID_PORT/health" 60 node dist/main.js || return 1
  fi

  # ---- the Hub
  local cors="http://localhost:$HUB_PORT"
  (( WITH_WEB )) && cors="$cors,http://localhost:$WEB_PORT"
  (( WITH_MOBILE )) && cors="$cors,http://localhost:$MOB_PORT"
  LENV=(DATABASE_URL="$HUB_DB_URL" HUB_API_PORT="$HUB_PORT" NODE_ENV=development CORS_ORIGIN="$cors"
    WAWU_ID_JWKS_URL="http://localhost:$IDP_PORT/.well-known/jwks.json" WAWU_ID_BASE_URL="http://localhost:$IDP_PORT"
    WAWU_ID_INTERNAL_SERVICE_KEY="$SERVICE_KEY"
    FLUTTERWAVE_SECRET_KEY= FLUTTERWAVE_PUBLIC_KEY=FLWPUBK_TEST-placeholder FLUTTERWAVE_SECRET_HASH=stack-webhook-hash
    ADMIN_JWT_SECRET="$ADMIN_SECRET" ADMIN_JWT_REFRESH_SECRET="$ADMIN_REFRESH"
    STORAGE_ENDPOINT="${STACK_STORAGE_ENDPOINT:-https://bucket.example-storage.dev}" STORAGE_ACCESS_KEY_ID=stack-key
    STORAGE_SECRET_ACCESS_KEY=stack-secret STORAGE_BUCKET=stack-bucket STORAGE_REGION=auto
    STORAGE_FORCE_PATH_STYLE="${STACK_STORAGE_PATH_STYLE:-}"
    FINTAVA_BASE_URL=http://127.0.0.1:1/api/dev FINTAVA_API_KEY=stack-key-not-real
    WALLET_PROVIDER=nuvion NUVION_BASE_URL=https://api.nuvion.dev NUVION_API_KEY=stack-nuvion-key-not-real
    NUVION_WEBHOOK_SECRET="$NUVION_SECRET" NUVION_OPERATIONAL_ACCOUNT_ID="$NUVION_OPS_ID"
    NUVION_FEE_BOOK_TRANSFER="$NUVION_FEE_BOOK" NUVION_FEE_BANK_PAYOUT="$NUVION_FEE_BANK" NUVION_FEE_INFLOW="$NUVION_FEE_IN"
    NUVION_FEE_CARD_CREATE="$NUVION_FEE_CARD"
    NUVION_WALLET_BANK_NAME=Nuvion
    NUVION_HOSTED_LIVENESS="$NUVION_LIVENESS" NUVION_LIVENESS_REDIRECT_ORIGINS="$NUVION_LIVENESS_RETURN"
    STACK_NUVION_STANDIN_PORT="$NUV_PORT"
    FINTAVA_WEBHOOK_SECRET="whsec_stack_$NAME" FEE_QUOTE_KEY="stack-fee-quote-key-$SERVICE_KEY"
    MERCHANT_MAX_PER_TXN_KOBO=1000000000 IDENTITY_HASH_KEY="$SERVICE_KEY"
    CARDEX_API_KEY= GEMINI_API_KEY= EXPO_ACCESS_TOKEN= PUSH_ENABLED=false
    NODE_OPTIONS="$BLOCK_NET --require=$DEV_DIR/nuvion-redirect.cjs --max-old-space-size=1536")
  service hub "$HUB_PORT" "$HUB_DIR" "http://127.0.0.1:$HUB_PORT/api/hub/health" 90 node dist/src/main.js || return 1

  # ---- the web production build
  if (( WITH_WEB )); then
    local web_env=(VERCEL_ENV=production NEXT_PUBLIC_API_BASE_URL="http://localhost:$HUB_PORT"
      NEXT_PUBLIC_WAWU_ID_BASE_URL="http://localhost:$IDP_PORT" NEXT_PUBLIC_USE_MOCKS=false
      NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY= NEXT_TELEMETRY_DISABLED=1)
    ensure_modules "$WEB_DIR" web "${STACK_NM_WEB:-}" || { fail_step web-install; return 1; }
    run_step web-build "$WEB_DIR" env "${web_env[@]}" NODE_OPTIONS=--max-old-space-size=3072 npx --no-install next build || { fail_step web-build; return 1; }
    LENV=("${web_env[@]}" NODE_ENV=production NODE_OPTIONS=--max-old-space-size=1024)
    service web "$WEB_PORT" "$WEB_DIR" "http://127.0.0.1:$WEB_PORT/join" 90 node node_modules/next/dist/bin/next start -p "$WEB_PORT" || return 1
  fi

  # ---- the mobile web export, with its own Metro cache
  if (( WITH_MOBILE )); then
    ensure_modules "$MOBILE_DIR" mobile "${STACK_NM_MOBILE:-}" || { fail_step mobile-install; return 1; }
    rm -rf "$STATE/tmp" "$STATE/mobile-dist"; mkdir -p "$STATE/tmp"
    run_step mobile-export "$MOBILE_DIR" env TMPDIR="$STATE/tmp" EXPO_PUBLIC_API_URL="http://localhost:$HUB_PORT" \
      EXPO_PUBLIC_ID_URL="http://localhost:$IDP_PORT" CI=1 EXPO_NO_TELEMETRY=1 EXPO_OFFLINE=1 \
      NODE_OPTIONS=--max-old-space-size=3072 npx --no-install expo export --platform web --output-dir "$STATE/mobile-dist" \
      || { fail_step mobile-export; return 1; }
    # Only this stack's ports may be baked into the bundle.
    local found stray=""
    found="$(grep -rhoE --include='*.js' '(localhost|127\.0\.0\.1):[0-9]+' "$STATE/mobile-dist" 2>/dev/null | sed -E 's/.*://' | sort -u | tr '\n' ' ')"
    for p in $found; do
      [ "$p" = "$HUB_PORT" ] || [ "$p" = "$IDP_PORT" ] || stray="$stray $p"
    done
    echo "baked localhost ports: ${found:-none}; this stack: $HUB_PORT $IDP_PORT" >> "$LOGS/mobile-export.log"
    if [ -n "$stray" ]; then
      echo "STRAY PORTS in the export:$stray (not this stack's $HUB_PORT or $IDP_PORT)" >> "$LOGS/mobile-export.log"
      fail_step mobile-export; return 1
    fi
    LENV=(NODE_OPTIONS=--max-old-space-size=256)
    service mobile "$MOB_PORT" "$DEV_DIR" "http://127.0.0.1:$MOB_PORT/" 30 node static-serve.cjs "$STATE/mobile-dist" "$MOB_PORT" || return 1
  fi
  return 0
}

STARTED=$SECONDS
build_all
RESULT=$?

# A file to source before running one spec against this stack.
cat > "$STATE/env.sh" <<EOF
# Source this to run a spec against stack $NAME: . $STATE/env.sh
export DATABASE_URL="$HUB_DB_URL"
export WAWU_ID_JWKS_URL="http://localhost:$MOCK_PORT/.well-known/jwks.json"
export WAWU_ID_BASE_URL="http://localhost:$MOCK_PORT"
export HUB_URL="http://localhost:$HUB_PORT"
export NUVION_STANDIN_URL="http://127.0.0.1:$NUV_PORT"
EOF

# ---------------------------------------------------------------- summary
say "stack $NAME  (logs $LOGS, $((SECONDS - STARTED)) s)"
for row in "${SUMMARY[@]}"; do
  IFS='|' read -r s_name s_url s_pid s_state <<< "$row"
  printf '  %-9s %-46s pid %-7s %s\n' "$s_name" "$s_url" "$s_pid" "$s_state"
done
if [ "$RESULT" -ne 0 ]; then
  say ""
  [ -z "$FAIL_WHY" ] || say "  why: $FAIL_WHY"
  say "FAILED at ${FAIL_NAME:-?}. Last 15 lines of ${FAIL_LOG:-the log}:"
  [ -f "$FAIL_LOG" ] && tail -n 15 "$FAIL_LOG" | cut -c1-200 | sed 's/^/  | /'
  say "What is running stays up. Stop it: scripts/dev/stack.sh down --name $NAME${SCRATCH_ARG:+ --scratch $SCRATCH}"
  exit 1
fi
say "  env for one spec: . $STATE/env.sh"
say "  stop: scripts/dev/stack.sh down --name $NAME${SCRATCH_ARG:+ --scratch $SCRATCH}"
exit 0
