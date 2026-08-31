#!/usr/bin/env bash
#
# Runs ON THE DROPLET, as the `wawu` user, once CI has rsynced the source.
#   bash /srv/wawu/hub-api/deploy/deploy.sh hub-api
#
# Kept in the repo rather than pasted into a workflow YAML so it can be read,
# reviewed and run by hand when a deploy needs debugging at 2am.
set -euo pipefail

SERVICE="${1:?usage: deploy.sh <hub-api|wawu-id>}"
DIR="/srv/wawu/${SERVICE}"
UNIT="wawu-${SERVICE#wawu-}"
[[ "$SERVICE" == "wawu-id" ]] && UNIT="wawu-id"
[[ "$SERVICE" == "hub-api" ]] && UNIT="wawu-hub-api"

cd "$DIR"

# THE ENV FILE HAS TO BE LOADED HERE, EXPLICITLY.
#
# systemd's EnvironmentFile applies to the SERVICE, not to this script, and
# prisma.config.ts reads process.env.DATABASE_URL. Without this,
# `prisma migrate deploy` fails with "datasource.url is required" — which
# reads like a Prisma config bug and is really just an empty environment.
# `set -a` exports everything the file defines so the child processes see it.
ENV_FILE="/etc/wawu/${SERVICE}.env"
if [[ -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "Cannot read ${ENV_FILE}. The deploy user must be in the wawu group." >&2
  exit 1
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is empty in ${ENV_FILE}. Fill it in before deploying." >&2
  exit 1
fi

echo "==> npm ci"
# `ci` not `install`: it installs exactly the lockfile, so a deploy cannot
# silently pick up a different version of a dependency than the one that was
# tested.
#
# --include=dev is REQUIRED and not an oversight. The env file above sets
# NODE_ENV=production, and npm honours that by omitting devDependencies — but
# the Nest CLI and the TypeScript compiler ARE devDependencies, and this box
# builds from source. Without it the install succeeds and the build then dies
# with "sh: 1: nest: not found", which looks like a broken PATH and is really
# a missing package.
npm ci --include=dev --no-audit --no-fund

echo "==> prisma"
if [[ -f prisma/schema.prisma ]]; then
  npx prisma generate

  # migrate deploy, NOT migrate dev. `dev` can decide to reset the database
  # when it sees drift, which on a production box is the whole customer list.
  # `deploy` only applies pending migrations and fails loudly otherwise.
  echo "==> prisma migrate deploy"
  npx prisma migrate deploy
fi

echo "==> build"
npm run build

# Check the thing systemd is about to run actually exists. Without this a
# wrong ExecStart shows up as a crash-loop and a timeout two minutes later,
# rather than one line naming the missing file.
ENTRY=$(awk -F' ' '/^ExecStart=/{print $NF}' "/etc/systemd/system/${UNIT}.service")
if [[ -n "$ENTRY" && ! -f "$DIR/$ENTRY" ]]; then
  echo "Build did not produce $DIR/$ENTRY (systemd ExecStart expects it)." >&2
  echo "Built entry points found:" >&2
  find "$DIR/dist" -name 'main.js' -maxdepth 3 2>/dev/null >&2 || true
  exit 1
fi

echo "==> restart ${UNIT}"
# sudo is needed for restart and NOTHING else here. `is-active` is a read and
# works unprivileged — routing it through sudo only widened what the deploy
# key could do, and the --quiet flag did not match the sudoers rule anyway,
# which is what made the first deploy fail with "a password is required".
sudo -n /usr/bin/systemctl restart "${UNIT}"

# Wait for it to actually come up rather than declaring success on the
# restart command returning. systemd returns as soon as it has forked.
echo "==> health"
for i in $(seq 1 20); do
  if systemctl is-active --quiet "${UNIT}"; then
    # Checked twice, two seconds apart. systemd reports active the instant it
    # has forked, so a service that crashes on its first request would still
    # look like a clean deploy on a single check.
    sleep 2
    if systemctl is-active --quiet "${UNIT}"; then
      echo "${UNIT} is up"
      exit 0
    fi
  fi
  sleep 2
done

echo "${UNIT} did NOT come up. Last 40 log lines:" >&2
journalctl -u "${UNIT}" -n 40 --no-pager >&2 || true
exit 1
