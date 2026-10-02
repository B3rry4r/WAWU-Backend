#!/usr/bin/env bash
# Starts wawu-id and the Hub API on this machine against a local Postgres,
# with seeded accounts. Read docs/LOCAL.md first; this is its "one command".
#
#   scripts/local/up.sh            # set up if needed, start both, Ctrl-C stops both
#   scripts/local/up.sh --detach   # same, but leave both running (stop: scripts/local/down.sh)
#
# Settings (environment variables, all optional). A setting you give is
# written into both .env files on THIS run, so a corrected LOCAL_PG_URL after
# a failed run takes effect; a setting you leave out keeps what the .env
# files already say (or the default, the first time):
#   WAWU_ID_DIR    the wawu-id checkout          (default: ../wawu-id next to this repo)
#   LOCAL_PG_URL   Postgres server, no database  (default: postgresql://postgres:postgres@localhost:5432)
#   HUB_DB, ID_DB  database names                (default: wawu_hub_local, wawu_id_local)
#   HUB_PORT       Hub API port                  (default: 3001)
#   ID_PORT        wawu-id port                  (default: 3002)
#
# It never touches anything but this machine: it refuses to run when either
# .env points at a database that is not local, when NODE_ENV is production,
# or when the Fintava base URL is not the sandbox.
set -euo pipefail

HUB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ID_DIR="${WAWU_ID_DIR:-$HUB_DIR/../wawu-id}"
ENVFILE="$HUB_DIR/scripts/local/envfile.js"
STATE_DIR="$HUB_DIR/.local"
LOG_DIR="$STATE_DIR/logs"
DETACH=0

# dotenv/config (which both repos' prisma.config.ts import) obeys
# DOTENV_CONFIG_PATH, DOTENV_CONFIG_OVERRIDE and friends. One left in the
# shell would make Prisma load some other file, possibly a remote
# DATABASE_URL, after every check below had passed. Nothing here needs them.
for v in $(compgen -e | grep -E '^DOTENV_' || true); do unset "$v"; done

# What the caller set explicitly, before any default fills in.
GIVEN_PG="${LOCAL_PG_URL:-}"
GIVEN_HUB_DB="${HUB_DB:-}"
GIVEN_ID_DB="${ID_DB:-}"
GIVEN_HUB_PORT="${HUB_PORT:-}"
GIVEN_ID_PORT="${ID_PORT:-}"
PG_URL="${GIVEN_PG:-postgresql://postgres:postgres@localhost:5432}"
PG_URL="${PG_URL%/}"

for arg in "$@"; do
  case "$arg" in
    --detach) DETACH=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# The value dotenv resolves for KEY, i.e. exactly what the service will use:
# `export KEY=`, indented lines and a later duplicate are all honoured.
env_get() { node "$ENVFILE" get "$1" "$2"; }
# Makes VALUE the only definition of KEY in the file.
env_set() { node "$ENVFILE" set "$1" "$2" "$3"; }
# Sets KEY only when the resolved value differs, and says so.
env_update() { # file label key value(as written) value(as read)
  local current; current="$(env_get "$1" "$3")"
  if [[ "$current" != "$5" ]]; then
    env_set "$1" "$3" "$4"
    echo "    $2 .env: $3 updated"
  fi
}

url_host() { node -e 'try { console.log(new URL(process.argv[1]).hostname.toLowerCase()) } catch { console.log("") }' "$1"; }
url_port() { node -e 'try { const u = new URL(process.argv[1]); console.log(u.port || "") } catch { console.log("") }' "$1"; }
# The server part of a Postgres URL (credentials, host, port), without the database.
url_server() { node -e 'try { const u = new URL(process.argv[1]); console.log(u.protocol + "//" + (u.username ? u.username + (u.password ? ":" + u.password : "") + "@" : "") + u.host) } catch { console.log("") }' "$1"; }
url_db()   { node -e 'try { console.log(decodeURIComponent(new URL(process.argv[1]).pathname.replace(/^\//, ""))) } catch { console.log("") }' "$1"; }
# pg lets ?host= / ?hostaddr= override the host in the URL; treat either as remote.
url_has_host_param() { node -e 'try { const p = new URL(process.argv[1]).searchParams; process.exit(p.has("host") || p.has("hostaddr") ? 0 : 1) } catch { process.exit(1) }' "$1"; }

is_local_host() {
  case "$1" in localhost|127.0.0.1|::1|\[::1\]) return 0 ;; *) return 1 ;; esac
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

run_logged() { # name dir cmd...   (every step writes $LOG_DIR/<name>.log)
  local name="$1" dir="$2"; shift 2
  if ! (cd "$dir" && "$@") > "$LOG_DIR/$name.log" 2>&1; then
    tail -n 40 "$LOG_DIR/$name.log" >&2
    if [[ "$name" == *-migrate ]]; then
      printf '\nPostgres refused or could not be reached (P1000 = wrong user or password, P1001 = not running or wrong host/port).\n' >&2
      printf 'Fix it by rerunning with the right server, which rewrites DATABASE_URL in both .env files:\n' >&2
      printf '  LOCAL_PG_URL=postgresql://USER:PASSWORD@localhost:5432 scripts/local/up.sh\n' >&2
    fi
    die "$name failed. Full output: $LOG_DIR/$name.log"
  fi
}

# ---------------------------------------------------------------- preflight
[[ "${NODE_ENV:-}" == "production" ]] && die "NODE_ENV is production. This script is for a local machine only."
command -v node >/dev/null || die "Node.js is not installed. Install Node 22 (the version CI and the server use)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 22 )) || die "Node $NODE_MAJOR found; Node 22 or newer is required."
command -v npm >/dev/null || die "npm is not installed."
command -v curl >/dev/null || die "curl is not installed."
[[ -f "$ID_DIR/package.json" ]] && grep -q '"name": "WAWU-ID"' "$ID_DIR/package.json" \
  || die "No wawu-id checkout at $ID_DIR. Clone it next to this repo, or set WAWU_ID_DIR."
ID_DIR="$(cd "$ID_DIR" && pwd)"
mkdir -p "$LOG_DIR"
HUB_ENV="$HUB_DIR/.env"
ID_ENV="$ID_DIR/.env"

# ---------------------------------------------------------------- install
# First, because reading the .env files the services' way needs their dotenv.
# Installing touches no database.
if [[ ! -d "$ID_DIR/node_modules" ]]; then say "Installing wawu-id dependencies"; run_logged id-install "$ID_DIR" npm ci --no-audit --no-fund; fi
if [[ ! -d "$HUB_DIR/node_modules" ]]; then say "Installing Hub API dependencies"; run_logged hub-install "$HUB_DIR" npm ci --no-audit --no-fund; fi

# ---------------------------------------------------------------- signing key
if [[ ! -f "$ID_DIR/keys/private.pem" ]]; then
  say "Generating a local RS256 signing keypair in $ID_DIR/keys (gitignored there)"
  mkdir -p "$ID_DIR/keys"
  node -e '
    const crypto = require("crypto"), fs = require("fs"), path = require("path");
    const dir = process.argv[1];
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    fs.writeFileSync(path.join(dir, "private.pem"), privateKey, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "public.pem"), publicKey);
  ' "$ID_DIR/keys"
fi

# ---------------------------------------------------------------- wawu-id .env
# When one .env is missing and the other exists, the new one is written to
# agree with the survivor: same shared service key, same ports. Deleting
# either file (or both) and rerunning is always safe.
if [[ ! -f "$ID_ENV" ]]; then
  # Same Postgres server (and credentials) as the surviving hub .env.
  if [[ -z "$GIVEN_PG" && -f "$HUB_ENV" ]]; then
    survivor="$(url_server "$(env_get "$HUB_ENV" DATABASE_URL)")"; if [[ -n "$survivor" ]]; then PG_URL="$survivor"; fi
  fi
  say "Writing $ID_ENV (local values only)"
  SERVICE_KEY=""; W_ID_PORT="$GIVEN_ID_PORT"; W_HUB_PORT="$GIVEN_HUB_PORT"
  if [[ -f "$HUB_ENV" ]]; then
    SERVICE_KEY="$(env_get "$HUB_ENV" WAWU_ID_INTERNAL_SERVICE_KEY)"
    [[ -n "$W_ID_PORT" ]] || W_ID_PORT="$(url_port "$(env_get "$HUB_ENV" WAWU_ID_JWKS_URL)")"
    [[ -n "$W_HUB_PORT" ]] || W_HUB_PORT="$(env_get "$HUB_ENV" HUB_API_PORT)"
  fi
  [[ -n "$SERVICE_KEY" ]] || SERVICE_KEY="$(node -p 'require("crypto").randomBytes(32).toString("hex")')"
  node -e '
    const fs = require("fs"), path = require("path");
    const [dir, dbUrl, port, serviceKey, hubPort] = process.argv.slice(1);
    const oneLine = (f) => fs.readFileSync(path.join(dir, "keys", f), "utf8").replace(/\n/g, "\\n");
    const lines = [
      "# Written by wawu-backend scripts/local/up.sh for local testing. Never deploy this file.",
      `DATABASE_URL="${dbUrl}"`,
      `PORT=${port}`,
      `RS256_PRIVATE_KEY="${oneLine("private.pem")}"`,
      `RS256_PUBLIC_KEY="${oneLine("public.pem")}"`,
      "JWT_EXPIRES_IN=15m",
      "REFRESH_EXPIRES_IN=30d",
      `INTERNAL_SERVICE_KEY=${serviceKey}`,
      "# No RESEND_API_KEY: mail is not sent, and each code is written to the wawu-id log instead.",
      "RESEND_API_KEY=",
      `APP_URL=http://localhost:${port}`,
      "ALLOWED_ORIGINS=",
      `WAWUAFRICA_API_URL=http://127.0.0.1:${hubPort}`,
    ];
    fs.writeFileSync(path.join(dir, ".env"), lines.join("\n") + "\n", { mode: 0o600 });
  ' "$ID_DIR" "$PG_URL/${GIVEN_ID_DB:-wawu_id_local}?schema=public" "${W_ID_PORT:-3002}" "$SERVICE_KEY" "${W_HUB_PORT:-3001}"
fi

# ---------------------------------------------------------------- hub .env
if [[ ! -f "$HUB_ENV" ]]; then
  # Same Postgres server (and credentials) as the wawu-id .env.
  if [[ -z "$GIVEN_PG" ]]; then
    survivor="$(url_server "$(env_get "$ID_ENV" DATABASE_URL)")"; if [[ -n "$survivor" ]]; then PG_URL="$survivor"; fi
  fi
  say "Writing $HUB_ENV from .env.example (local values only)"
  W_ID_PORT="${GIVEN_ID_PORT:-$(env_get "$ID_ENV" PORT)}"
  W_HUB_PORT="${GIVEN_HUB_PORT:-$(url_port "$(env_get "$ID_ENV" WAWUAFRICA_API_URL)")}"
  cp "$HUB_DIR/.env.example" "$HUB_ENV"
  chmod 600 "$HUB_ENV"
  env_set "$HUB_ENV" DATABASE_URL "\"$PG_URL/${GIVEN_HUB_DB:-wawu_hub_local}?schema=public\""
  env_set "$HUB_ENV" HUB_API_PORT "${W_HUB_PORT:-3001}"
  env_set "$HUB_ENV" CORS_ORIGIN "http://localhost:8081,http://localhost:19006,http://localhost:3000"
  env_set "$HUB_ENV" WAWU_ID_JWKS_URL "http://localhost:${W_ID_PORT:-3002}/.well-known/jwks.json"
  env_set "$HUB_ENV" WAWU_ID_BASE_URL "http://localhost:${W_ID_PORT:-3002}"
  env_set "$HUB_ENV" WAWU_ID_INTERNAL_SERVICE_KEY "$(env_get "$ID_ENV" INTERNAL_SERVICE_KEY)"
fi

# ---------------------------------------------------------------- settings given on this run
# Applied to files that already exist too, so fixing LOCAL_PG_URL (or a port)
# after a failed run works without editing anything by hand.
if [[ -n "$GIVEN_PG$GIVEN_HUB_DB$GIVEN_ID_DB$GIVEN_HUB_PORT$GIVEN_ID_PORT" ]]; then
  say "Applying the settings given on this run"
  if [[ -n "$GIVEN_PG$GIVEN_ID_DB" ]]; then
    db="${GIVEN_ID_DB:-$(url_db "$(env_get "$ID_ENV" DATABASE_URL)")}"; db="${db:-wawu_id_local}"
    env_update "$ID_ENV" wawu-id DATABASE_URL "\"$PG_URL/$db?schema=public\"" "$PG_URL/$db?schema=public"
  fi
  if [[ -n "$GIVEN_PG$GIVEN_HUB_DB" ]]; then
    db="${GIVEN_HUB_DB:-$(url_db "$(env_get "$HUB_ENV" DATABASE_URL)")}"; db="${db:-wawu_hub_local}"
    env_update "$HUB_ENV" hub DATABASE_URL "\"$PG_URL/$db?schema=public\"" "$PG_URL/$db?schema=public"
  fi
  if [[ -n "$GIVEN_ID_PORT" ]]; then
    env_update "$ID_ENV" wawu-id PORT "$GIVEN_ID_PORT" "$GIVEN_ID_PORT"
    env_update "$ID_ENV" wawu-id APP_URL "http://localhost:$GIVEN_ID_PORT" "http://localhost:$GIVEN_ID_PORT"
    env_update "$HUB_ENV" hub WAWU_ID_JWKS_URL "http://localhost:$GIVEN_ID_PORT/.well-known/jwks.json" "http://localhost:$GIVEN_ID_PORT/.well-known/jwks.json"
    env_update "$HUB_ENV" hub WAWU_ID_BASE_URL "http://localhost:$GIVEN_ID_PORT" "http://localhost:$GIVEN_ID_PORT"
  fi
  if [[ -n "$GIVEN_HUB_PORT" ]]; then
    env_update "$HUB_ENV" hub HUB_API_PORT "$GIVEN_HUB_PORT" "$GIVEN_HUB_PORT"
    env_update "$ID_ENV" wawu-id WAWUAFRICA_API_URL "http://127.0.0.1:$GIVEN_HUB_PORT" "http://127.0.0.1:$GIVEN_HUB_PORT"
  fi
fi

# ---------------------------------------------------------------- resolve, as the services will
ID_PORT="$(env_get "$ID_ENV" PORT)"; ID_PORT="${ID_PORT:-3000}"
ID_DB_URL="$(env_get "$ID_ENV" DATABASE_URL)"
HUB_PORT="$(env_get "$HUB_ENV" HUB_API_PORT)"; HUB_PORT="${HUB_PORT:-3001}"
HUB_DB_URL="$(env_get "$HUB_ENV" DATABASE_URL)"

# Both services and Prisma let a variable already set in the shell win over
# the .env file. A DATABASE_URL (or PORT) exported in this terminal would
# silently send everything below somewhere else, so every key the two .env
# files define (as dotenv reads them) is cleared from this script's
# environment first.
for f in "$HUB_ENV" "$ID_ENV"; do
  for k in $(node "$ENVFILE" keys "$f"); do unset "$k"; done
done

# ---------------------------------------------------------------- safety
for pair in "hub:$HUB_DB_URL" "wawu-id:$ID_DB_URL"; do
  name="${pair%%:*}"; url="${pair#*:}"
  host="$(url_host "$url")"
  is_local_host "$host" || die "The $name .env has DATABASE_URL on \"${host:-?}\", not this machine. Point it at a local Postgres (docs/LOCAL.md); this script never touches another database."
  url_has_host_param "$url" && die "The $name .env DATABASE_URL sets ?host= or ?hostaddr=, which can point it off this machine. Remove it."
done
for f in "$HUB_ENV" "$ID_ENV"; do
  [[ "$(env_get "$f" NODE_ENV | tr '[:upper:]' '[:lower:]')" == "production" ]] && die "$f sets NODE_ENV=production. Remove it for local testing."
done
FINTAVA_URL="$(env_get "$HUB_ENV" FINTAVA_BASE_URL)"
if [[ -n "$FINTAVA_URL" ]]; then
  [[ "$(url_host "$FINTAVA_URL")" == "dev.fintavapay.com" ]] \
    || die "FINTAVA_BASE_URL is \"$FINTAVA_URL\", not Fintava's sandbox. Local testing uses only https://dev.fintavapay.com/api/dev"
fi
CARDEX_KEY="$(env_get "$HUB_ENV" CARDEX_API_KEY)"
[[ -z "$CARDEX_KEY" || "$CARDEX_KEY" == cdx_test_* ]] || die "CARDEX_API_KEY is not a cdx_test_ (sandbox) key. Local testing uses the sandbox."
JWKS_PORT="$(url_port "$(env_get "$HUB_ENV" WAWU_ID_JWKS_URL)")"
[[ "$JWKS_PORT" == "$ID_PORT" ]] || die "The hub .env has WAWU_ID_JWKS_URL on port ${JWKS_PORT:-?}, but wawu-id runs on $ID_PORT. Rerun with ID_PORT=$ID_PORT to line them up."
[[ "$(env_get "$HUB_ENV" WAWU_ID_INTERNAL_SERVICE_KEY)" == "$(env_get "$ID_ENV" INTERNAL_SERVICE_KEY)" ]] \
  || die "WAWU_ID_INTERNAL_SERVICE_KEY (hub .env) and INTERNAL_SERVICE_KEY (wawu-id .env) differ. Make them the same value, or delete both .env files and rerun."
port_in_use "$ID_PORT" && die "Port $ID_PORT (wawu-id) is already in use. Stop whatever is on it (scripts/local/down.sh if it is a detached run), or rerun with ID_PORT=<free port>."
port_in_use "$HUB_PORT" && die "Port $HUB_PORT (Hub API) is already in use. Stop whatever is on it (scripts/local/down.sh if it is a detached run), or rerun with HUB_PORT=<free port>."

# ---------------------------------------------------------------- migrate, seed, build
say "wawu-id: migrating $(url_db "$ID_DB_URL") (created if missing)"
run_logged id-migrate "$ID_DIR" env DATABASE_URL="$ID_DB_URL" sh -c 'npx prisma generate && npx prisma migrate deploy'
say "Hub API: migrating $(url_db "$HUB_DB_URL") (created if missing)"
run_logged hub-migrate "$HUB_DIR" env DATABASE_URL="$HUB_DB_URL" sh -c 'npx prisma generate && npx prisma migrate deploy'


say "Seeding the Hub (prisma/seed.ts) and the same three accounts in wawu-id"
run_logged hub-seed "$HUB_DIR" env DATABASE_URL="$HUB_DB_URL" npx prisma db seed
run_logged id-seed "$HUB_DIR" env WAWU_ID_DATABASE_URL="$ID_DB_URL" node scripts/local/seed-wawu-id.js

say "Building wawu-id and the Hub API"
run_logged id-build "$ID_DIR" npm run build
run_logged hub-build "$HUB_DIR" npm run build

# ---------------------------------------------------------------- start
start() { # name dir entry database-url
  local name="$1" dir="$2" entry="$3" db="$4"
  (cd "$dir" && export DATABASE_URL="$db" && exec node "$entry") > "$LOG_DIR/$name.log" 2>&1 &
  echo $! > "$STATE_DIR/$name.pid"
}

wait_healthy() { # name url pidfile
  local name="$1" url="$2" pid; pid="$(cat "$3")"
  for _ in $(seq 1 90); do
    if curl -sf "$url" >/dev/null 2>&1; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 40 "$LOG_DIR/$name.log" >&2
      die "$name exited during startup. Log: $LOG_DIR/$name.log"
    fi
    sleep 1
  done
  tail -n 40 "$LOG_DIR/$name.log" >&2
  die "$name did not answer $url within 90 seconds. Log: $LOG_DIR/$name.log"
}

stop_all() {
  for name in hub-api wawu-id; do
    if [[ -f "$STATE_DIR/$name.pid" ]]; then
      kill "$(cat "$STATE_DIR/$name.pid")" 2>/dev/null || true
      rm -f "$STATE_DIR/$name.pid"
    fi
  done
}

if (( DETACH == 0 )); then trap 'stop_all' EXIT; trap 'exit 130' INT TERM; fi

say "Starting wawu-id on :$ID_PORT"
start wawu-id "$ID_DIR" dist/main.js "$ID_DB_URL"
wait_healthy wawu-id "http://localhost:$ID_PORT/health" "$STATE_DIR/wawu-id.pid"
say "Starting the Hub API on :$HUB_PORT"
start hub-api "$HUB_DIR" dist/src/main.js "$HUB_DB_URL"
wait_healthy hub-api "http://localhost:$HUB_PORT/api/hub/health" "$STATE_DIR/hub-api.pid"

LAN_IP="$( (ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}') | head -n 1 || true)"
[[ -n "$LAN_IP" ]] || LAN_IP="<this machine's LAN IP>"
cat <<EOF

WAWU is running locally.
  Hub API   http://localhost:$HUB_PORT/api/hub/health
  wawu-id   http://localhost:$ID_PORT/health
  Phone on the same Wi-Fi: EXPO_PUBLIC_API_URL=http://$LAN_IP:$HUB_PORT
  Seeded sign-ins (password: wawu-local-2026, or LOCAL_SEED_PASSWORD if you set it):
    user@test.wawu.dev            plain user
    creator-basic@test.wawu.dev   creator, KYC pending
    creator-pro@test.wawu.dev     creator, KYC approved
  Logs: $LOG_DIR/wawu-id.log and $LOG_DIR/hub-api.log
        (sign-up email codes are printed in the wawu-id log: grep "code=")
  Check it end to end: scripts/local/smoke.sh
EOF

if (( DETACH == 1 )); then
  echo "  Running in the background. Stop with: scripts/local/down.sh"
  exit 0
fi
echo "  Press Ctrl-C to stop both."
wait
