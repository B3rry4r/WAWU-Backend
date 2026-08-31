#!/usr/bin/env bash
#
# One-time droplet provisioning for WAWU.
#
# Run ONCE, as root, on a fresh Ubuntu 24.04 droplet:
#   ssh -i wawu_do_deploy root@<DROPLET_IP> 'bash -s' < deploy/provision.sh
#
# Idempotent — running it again is safe and will not clobber the env files.
#
# WHAT THIS DELIBERATELY DOES NOT DO: write any secret. Secrets live on the
# droplet in /etc/wawu/*.env and are never held by GitHub Actions, so a
# compromised CI account cannot read your database password or your
# Flutterwave live key. The deploy workflow only ever gets SSH access.
set -euo pipefail

APP_USER=wawu
NODE_MAJOR=22

echo "==> System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx ufw rsync ca-certificates gnupg postgresql-client

echo "==> Node ${NODE_MAJOR}"
if ! command -v node >/dev/null || [[ "$(node -v)" != v${NODE_MAJOR}* ]]; then
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
fi
node -v

echo "==> Application user"
# A non-login system user. The services do not need a shell, and root running
# a Node process that speaks to the internet is the thing to avoid.
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin "$APP_USER"

echo "==> Directories"
install -d -o "$APP_USER" -g "$APP_USER" /srv/wawu
install -d -o "$APP_USER" -g "$APP_USER" /srv/wawu/hub-api
install -d -o "$APP_USER" -g "$APP_USER" /srv/wawu/wawu-id
install -d -o "$APP_USER" -g "$APP_USER" /srv/wawu/releases
# 0750 root:wawu — the services read these, nothing else on the box can.
install -d -o root -g "$APP_USER" -m 0750 /etc/wawu

echo "==> Env file stubs (only if absent — never overwrite a real secret)"
for svc in hub-api wawu-id; do
  if [[ ! -f /etc/wawu/${svc}.env ]]; then
    cat > /etc/wawu/${svc}.env <<'ENVEOF'
# Filled in by hand on the droplet. NEVER committed, never in CI.
# See deploy/README.md for the full list this service needs.
NODE_ENV=production
ENVEOF
    chown root:"$APP_USER" /etc/wawu/${svc}.env
    chmod 0640 /etc/wawu/${svc}.env
    echo "    created /etc/wawu/${svc}.env (stub — fill it in)"
  else
    echo "    /etc/wawu/${svc}.env already exists, left alone"
  fi
done

echo "==> Deploy SSH key for CI"
# The workflow connects as this user to run the deploy. It gets a restricted
# shell path via sudoers below rather than root.
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 /home/$APP_USER/.ssh
touch /home/$APP_USER/.ssh/authorized_keys
chown "$APP_USER":"$APP_USER" /home/$APP_USER/.ssh/authorized_keys
chmod 0600 /home/$APP_USER/.ssh/authorized_keys
if [[ -f /root/.ssh/authorized_keys ]]; then
  # Same key you used to get in here. Copied so CI can deploy as `wawu`
  # rather than as root.
  grep -qxFf /root/.ssh/authorized_keys /home/$APP_USER/.ssh/authorized_keys 2>/dev/null \
    || cat /root/.ssh/authorized_keys >> /home/$APP_USER/.ssh/authorized_keys
  sort -u -o /home/$APP_USER/.ssh/authorized_keys /home/$APP_USER/.ssh/authorized_keys
fi
# The app user needs a shell to run the deploy script over SSH.
usermod --shell /bin/bash "$APP_USER"

echo "==> sudoers: restart only, nothing else"
cat > /etc/sudoers.d/wawu-deploy <<'SUDOEOF'
# The deploy user may restart its own services and nothing more. A full
# NOPASSWD:ALL here would make the CI key equivalent to root.
wawu ALL=(root) NOPASSWD: /usr/bin/systemctl restart wawu-hub-api, /usr/bin/systemctl restart wawu-id, /usr/bin/systemctl status wawu-hub-api, /usr/bin/systemctl status wawu-id, /usr/bin/systemctl is-active wawu-hub-api, /usr/bin/systemctl is-active wawu-id
SUDOEOF
chmod 0440 /etc/sudoers.d/wawu-deploy
visudo -c -f /etc/sudoers.d/wawu-deploy

echo "==> Firewall"
ufw allow OpenSSH
ufw allow 'Nginx Full'
# 3001 and 3002 are NOT opened. Both services are reached through nginx only,
# so the app ports are not exposed to the internet.
ufw --force enable
ufw status verbose

echo "==> nginx: drop the default site"
rm -f /etc/nginx/sites-enabled/default

echo
echo "Provisioning done."
echo "NEXT:"
echo "  1. Fill in /etc/wawu/hub-api.env and /etc/wawu/wawu-id.env"
echo "  2. Install the systemd units and nginx sites (deploy/install-services.sh)"
echo "  3. Push to main, or run the workflow by hand"
