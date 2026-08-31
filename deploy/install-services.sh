#!/usr/bin/env bash
#
# Installs systemd units, nginx sites and TLS. Run as root on the droplet,
# after provision.sh and after the env files are filled in.
#
#   API_DOMAIN=api.example.com ID_DOMAIN=id.example.com \
#   LETSENCRYPT_EMAIL=ops@example.com \
#   bash deploy/install-services.sh
#
# Idempotent.
set -euo pipefail

: "${API_DOMAIN:?set API_DOMAIN, e.g. api.wawuafrica.com}"
: "${ID_DOMAIN:?set ID_DOMAIN, e.g. id.wawuafrica.com}"
: "${LETSENCRYPT_EMAIL:?set LETSENCRYPT_EMAIL}"

APP_USER=wawu

echo "==> systemd units"

# Both units share this shape:
#   EnvironmentFile  — secrets, root-owned, 0640, read at start
#   Restart=always   — a crash comes back; a bad deploy does not need a human
#   RestartSec       — backs off so a crash-loop does not spin the CPU
#   Hardening        — the service cannot write outside its own directory,
#                      cannot see other users' /home, cannot gain privileges.
#                      This is the difference between "an RCE in a dependency
#                      reads the database" and "an RCE in a dependency reads
#                      almost nothing".
write_unit () {
  local name=$1 dir=$2 envfile=$3 desc=$4 entry=$5
  cat > /etc/systemd/system/${name}.service <<UNIT
[Unit]
Description=${desc}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${dir}
EnvironmentFile=${envfile}
ExecStart=/usr/bin/node ${entry}
Restart=always
RestartSec=3
# Give up after 5 failures in 60s instead of restarting for ever. A unit that
# can never start — a missing entry file, a bad env var — otherwise loops
# silently at 20 restarts a minute and buries the real error in the journal.
StartLimitBurst=5
StartLimitIntervalSec=60
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${name}

# --- hardening ---
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${dir}
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
UNIT
}

# THE ENTRY PATH IS dist/src/main.js, NOT dist/main.js.
# prisma.config.ts and scripts/ live outside src/, so tsc's rootDir becomes
# the project root and the whole tree is nested one level deeper than a
# textbook Nest layout. Guessing dist/main.js here is what made the first
# deploy crash-loop 54 times before anybody looked at the journal.
write_unit wawu-hub-api /srv/wawu/hub-api  /etc/wawu/hub-api.env  "WAWU Hub API"              dist/src/main.js
write_unit wawu-id      /srv/wawu/wawu-id  /etc/wawu/wawu-id.env  "WAWU ID (identity service)" dist/main.js

systemctl daemon-reload
systemctl enable wawu-hub-api wawu-id >/dev/null

echo "==> nginx sites"
write_site () {
  local domain=$1 port=$2 name=$3
  cat > /etc/nginx/sites-available/${name} <<NGINX
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    # certbot writes its challenge here before TLS exists.
    location /.well-known/acme-challenge/ { root /var/www/html; }

    location / {
        proxy_pass         http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        # The app needs to know the ORIGINAL scheme. Without this every
        # redirect and every absolute URL it builds comes out as http://
        # even though the browser arrived on https, and OAuth breaks.
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_set_header   Upgrade           \$http_upgrade;
        proxy_set_header   Connection        "upgrade";
        proxy_read_timeout 120s;
    }

    # File uploads go to Spaces, but a multipart request still passes through
    # here on its way. The nginx default of 1m rejects a large one with a 413
    # that looks like an app bug.
    client_max_body_size 25m;
}
NGINX
  ln -sf /etc/nginx/sites-available/${name} /etc/nginx/sites-enabled/${name}
}

write_site "$API_DOMAIN" 3001 wawu-hub-api
write_site "$ID_DOMAIN"  3002 wawu-id

nginx -t
systemctl reload nginx

echo "==> TLS"
if ! command -v certbot >/dev/null; then
  apt-get install -y -qq certbot python3-certbot-nginx
fi
# --keep-until-expiring so re-running this script does not burn rate limit.
certbot --nginx --non-interactive --agree-tos --keep-until-expiring \
  -m "$LETSENCRYPT_EMAIL" -d "$API_DOMAIN" -d "$ID_DOMAIN" --redirect || {
  echo
  echo "certbot failed. This is almost always DNS: $API_DOMAIN and $ID_DOMAIN"
  echo "must already resolve to this droplet's IP. Point them, wait, re-run."
  echo "The sites still work over plain HTTP in the meantime."
}

systemctl list-timers certbot.timer --no-pager | head -3 || true

echo
echo "Done. Services are enabled but not started until a deploy has put code"
echo "in /srv/wawu/*. Run the GitHub Action, or deploy/deploy.sh by hand."
