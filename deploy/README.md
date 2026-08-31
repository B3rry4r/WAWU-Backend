# Deploying WAWU to DigitalOcean

Two Node services on one droplet behind nginx, a managed Postgres, and Spaces
for object storage. Auto-deploy on push to `main`.

```
                    ┌─────────── droplet (Ubuntu 24.04) ───────────┐
  api.DOMAIN  ──▶   │ nginx :443 ──▶ 127.0.0.1:3001  wawu-hub-api  │
  id.DOMAIN   ──▶   │ nginx :443 ──▶ 127.0.0.1:3002  wawu-id       │
                    └──────────────────┬───────────────────────────┘
                                       │ private network
                          ┌────────────┴────────────┐
                          │  Managed Postgres        │
                          │  Spaces (S3-compatible)  │
                          └──────────────────────────┘
```

Ports 3001/3002 are **not** open to the internet. `ufw` allows SSH and nginx
only, so both services are reachable through nginx or not at all.

---

## Order of operations

### 1. Droplet

Create → Droplets. **Same region as your managed Postgres** — same-region
traffic goes over the private network, which is faster and not billed.

- Ubuntu 24.04 LTS · Basic · Regular · **4 GB / 2 vCPU**
- Authentication: **SSH Key** → paste `wawu_do_deploy.pub`
- Hostname `wawu-api-1`, Monitoring on

### 2. Point DNS

Two A records at your DNS provider, both to the droplet's IPv4:

| Record | Value |
|---|---|
| `api` | droplet IP |
| `id`  | droplet IP |

Do this **before** step 4 — Let's Encrypt proves you own the name by fetching
a file over HTTP, so the name has to resolve first.

### 3. Provision

```bash
ssh -i wawu_do_deploy root@DROPLET_IP 'bash -s' < deploy/provision.sh
```

Installs Node 22, nginx, ufw; creates the `wawu` service user; creates
`/etc/wawu/*.env` stubs; gives the deploy user permission to restart **only**
its two services.

### 4. Fill in the secrets

Secrets live on the droplet and are never held by GitHub. A compromised CI
account gets SSH access, not your database password.

```bash
ssh -i wawu_do_deploy root@DROPLET_IP
nano /etc/wawu/hub-api.env
```

`hub-api.env` needs at least:

```
NODE_ENV=production
HUB_API_PORT=3001

# From the managed database page. Use the PRIVATE host and keep sslmode=require.
DATABASE_URL=postgresql://USER:PASS@private-db-host:25060/wawu?sslmode=require

# The identity service, reached over loopback — not through nginx.
WAWU_ID_BASE_URL=http://127.0.0.1:3002
WAWU_ID_JWKS_URL=http://127.0.0.1:3002/.well-known/jwks.json
WAWU_ID_INTERNAL_SERVICE_KEY=<same value as in wawu-id.env>

# 32+ characters each, and different from one another.
ADMIN_JWT_SECRET=
ADMIN_JWT_REFRESH_SECRET=

FLUTTERWAVE_SECRET_KEY=
FLUTTERWAVE_PUBLIC_KEY=
FLUTTERWAVE_WEBHOOK_HASH=

GEMINI_API_KEY=

# Spaces — S3-compatible, so the AWS SDK talks to it unchanged.
S3_ENDPOINT=https://REGION.digitaloceanspaces.com
S3_REGION=REGION
S3_BUCKET=wawu-media
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
```

Then `chmod 640 /etc/wawu/*.env && chown root:wawu /etc/wawu/*.env`.

> Generate a secret with: `openssl rand -base64 48`

### 5. Services, nginx and TLS

```bash
API_DOMAIN=api.YOURDOMAIN ID_DOMAIN=id.YOURDOMAIN \
LETSENCRYPT_EMAIL=you@yourdomain \
bash deploy/install-services.sh
```

certbot installs a renewal timer; nothing to do again.

### 6. GitHub secrets

Repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|---|---|
| `DROPLET_SSH_KEY` | the **whole** `wawu_do_deploy` private file, `-----BEGIN` line included |
| `DROPLET_HOST` | droplet IP |
| `DROPLET_HOST_KEY` | output of `ssh-keyscan -t ed25519 DROPLET_IP` |
| `API_DOMAIN` | `api.YOURDOMAIN` |

`DROPLET_HOST_KEY` is not optional busywork: without it the workflow would
have to accept any host answering on that IP, which defeats the check.

### 7. Deploy

Push to `main`, or Actions → Deploy Hub API → Run workflow.

The workflow tests first (real Postgres, real JWKS handshake, the full
contract suite) and only then rsyncs. It finishes by curling the live domain
— a run that goes green means the service actually answered, not merely that
`systemctl restart` returned.

---

## Spaces

Create → Spaces Object Storage, **same region as the droplet**.

- Name it (e.g. `wawu-media`), restrict file listing
- Then **Settings → CORS** — add your web origin, methods GET/PUT, and the
  headers your uploader sends. Without this the browser blocks direct uploads
  with an error that looks like the upload code is broken.
- API → Spaces Keys → generate a key pair, put it in `hub-api.env`

Spaces is S3-compatible, so the existing AWS SDK code works with only
`S3_ENDPOINT` changed. **The Railway bucket does not migrate itself** — copy
the objects across before switching:

```bash
# On any machine with s3cmd or rclone configured for both
rclone sync railway:OLD_BUCKET spaces:wawu-media --progress
```

---

## Operating it

```bash
# is it up
sudo systemctl status wawu-hub-api

# logs, live
sudo journalctl -u wawu-hub-api -f

# logs, last 200
sudo journalctl -u wawu-hub-api -n 200 --no-pager

# restart by hand
sudo systemctl restart wawu-hub-api

# deploy by hand, without CI
ssh -i wawu_do_deploy wawu@DROPLET_IP 'bash /srv/wawu/hub-api/deploy/deploy.sh hub-api'
```

### When a deploy fails

The workflow fails at the step that broke, and `deploy.sh` prints the last 40
journal lines when a service does not come up. The most common causes:

| Symptom | Cause |
|---|---|
| Service restarts in a loop | A missing env var. `journalctl` names it. |
| `migrate deploy` fails | A migration needs a column that already exists — the database and the migration history disagree. Do **not** run `migrate dev` here; it can reset the database. |
| 502 from nginx | The service is down, or bound to a different port than the site expects. |
| certbot fails | DNS does not resolve to this droplet yet. |

### Rolling back

There is no automatic rollback in this setup, and pretending otherwise would
be worse than saying so. To go back:

```bash
git revert <bad commit> && git push    # re-runs the pipeline on known-good code
```

A migration is **not** reverted by that. Reversing a migration is a
hand-written down-migration, which is why `migrate deploy` failing loudly is
better than it improvising.

---

## What is NOT set up

Named so nobody assumes otherwise:

- **No zero-downtime deploy.** `systemctl restart` drops in-flight requests
  for a second or two. Fine at current traffic; becomes worth fixing when it
  is not.
- **No automatic rollback.** See above.
- **No off-droplet log retention.** `journalctl` is local; if the droplet dies
  the logs die with it.
- **No staging environment.** `main` goes straight to production.
