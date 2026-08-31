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

echo "==> npm ci"
# `ci` not `install`: it installs exactly the lockfile, so a deploy cannot
# silently pick up a different version of a dependency than the one that was
# tested.
npm ci --no-audit --no-fund

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

echo "==> restart ${UNIT}"
sudo /usr/bin/systemctl restart "${UNIT}"

# Wait for it to actually come up rather than declaring success on the
# restart command returning. systemd returns as soon as it has forked.
echo "==> health"
for i in $(seq 1 20); do
  if sudo /usr/bin/systemctl is-active --quiet "${UNIT}"; then
    sleep 2
    if sudo /usr/bin/systemctl is-active --quiet "${UNIT}"; then
      echo "${UNIT} is up"
      exit 0
    fi
  fi
  sleep 2
done

echo "${UNIT} did NOT come up. Last 40 log lines:" >&2
journalctl -u "${UNIT}" -n 40 --no-pager >&2 || true
exit 1
