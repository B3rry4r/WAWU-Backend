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

The Hub API's rate limits (20/s and 200/min per caller) count each caller by
the address nginx puts last in `X-Forwarded-For`. The app trusts exactly one
hop, and only from a loopback peer (`hubTrustProxy` in
`src/hub-app-options.ts`, task OPS-11), so a request that reaches the port any
other way is counted by its own address and its header is ignored. Putting a
CDN or load balancer in front of nginx adds a hop: change that setting with it,
or every caller shares the CDN's buckets.

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
# sslmode=verify-full needs DigitalOcean's CA. Plain sslmode=require FAILS
# with "self-signed certificate in certificate chain" — Prisma validates the
# chain even on `require`, unlike libpq. Get the CA once:
#   openssl s_client -starttls postgres -connect HOST:25060 -showcerts </dev/null 2>/dev/null \
#     | awk '/BEGIN CERT/,/END CERT/' | csplit -sz -f /tmp/c- - '/BEGIN CERT/' '{*}'
#   cp /tmp/c-01 /etc/wawu/do-ca.crt   # the LAST cert is the Project CA
DATABASE_URL='postgresql://USER:PASS@db-host:25060/wawu_hub?sslmode=verify-full&sslrootcert=/etc/wawu/do-ca.crt'

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

# Which company holds the naira wallets (MONEY-20, NUV-01): fintava (or
# empty), or nuvion, which needs the NUVION_* values below; any other value
# stops the server.
# ROLLBACK between providers = change this one value, then
# `sudo systemctl restart wawu-hub-api`. Nothing else is edited, no migration
# runs, and the FINTAVA_* and NUVION_* values stay in place either way: the
# server acts only on the wallets, openings and ledger rows of the provider
# it runs, and both webhook receivers stay mounted.
WALLET_PROVIDER=fintava
# Nuvion (NUV-01; read only when WALLET_PROVIDER=nuvion). Put here by NUV-10:
# NUVION_BASE_URL is exactly https://api.nuvion.co in production
# (https://api.nuvion.dev is the sandbox); anything else stops the server.
# NUVION_API_VERSION may stay empty (pinned to 2026-02-06). Under nuvion a
# missing NUVION_BASE_URL, NUVION_API_KEY, NUVION_WEBHOOK_SECRET or
# NUVION_OPERATIONAL_ACCOUNT_ID stops the server at boot, naming it.
# NUVION_WEBHOOK_SECRET is shown once by Nuvion when NUV-10 registers
#   https://<the API's public host>/api/hub/webhooks/nuvion
# and is read under any WALLET_PROVIDER: without it every delivery is
# refused with 401. NUVION_HOSTED_LIVENESS is on or off (empty: off): the
# selfie step of opening stays off until the sandbox shows Nuvion can start a
# session for a child entity (NUV-03, R-39); NUVION_LIVENESS_REDIRECT_ORIGINS
# lists where its page may return to, each an https origin and a path prefix
# (an empty list allows no address). NUVION_WALLET_* are the owner's bank, licence and
# deposit-insurance lines for Nuvion wallets (empty hides them).
# PIN reset codes go by email under nuvion (R-39): WAWU ID sends them
# (WAWU_ID_BASE_URL and WAWU_ID_INTERNAL_SERVICE_KEY, BACKEND_GAPS G-400).
NUVION_BASE_URL=
NUVION_API_KEY=
NUVION_API_VERSION=
NUVION_WEBHOOK_SECRET=
NUVION_OPERATIONAL_ACCOUNT_ID=
NUVION_TIMEOUT_MS=
NUVION_MONEY_TIMEOUT_MS=
NUVION_CHECK_TIMEOUT_MS=
NUVION_RESEND_SAFETY_MS=
NUVION_HOSTED_LIVENESS=
NUVION_LIVENESS_REDIRECT_ORIGINS=
NUVION_WALLET_BANK_NAME=
NUVION_WALLET_LICENCE_LINE=
NUVION_WALLET_DEPOSIT_INSURANCE_LINE=
# Fintava (naira wallets; src/fintava/, MONEY-06). Production must name the
# live base URL here: the client never assumes live, and refuses any host
# other than Fintava's. The timeouts may stay empty (defaults in
# .env.example). Live values are put here by OPS-10.
# These are needed for the wallet to work, not for the server to start.
# With FINTAVA_BASE_URL unset the server starts, logs one warning ("Fintava
# is not configured on this server"), sends nothing to Fintava, and the
# wallet routes answer 503 provider_unreachable (MONEY-11). A value that IS
# set is checked at boot: anything but Fintava's two hosts stops the server.
# FINTAVA_WEBHOOK_SECRET is the live dashboard's webhook secret. OPS-10
# registers this webhook URL in Fintava's live dashboard (MONEY-07):
#   https://<the API's public host>/api/hub/webhooks/fintava
# Without the secret every delivery is refused with 401 (fails closed).
FINTAVA_BASE_URL=
FINTAVA_API_KEY=
FINTAVA_WEBHOOK_SECRET=
FINTAVA_TIMEOUT_MS=
FINTAVA_MONEY_TIMEOUT_MS=
FINTAVA_CHECK_TIMEOUT_MS=
FINTAVA_RESEND_SAFETY_MS=
# The BVN check (KYC-01) and the selfie match (KYC-02). IDENTITY_HASH_KEY is
# the secret the BVN and NIN are hashed under: `openssl rand -hex 32`, set
# once, never changed (every stored hash would stop matching). Unset, the
# server starts and both checks answer 503. BVN_CHECKS_PER_DAY and
# SELFIE_CHECKS_PER_DAY may stay empty (3 each, provisional).
# The same key also derives (HKDF, label wawu/kyc-check-handle/v1) the key
# the BVN check's 30-minute `checkHandle` is sealed under (KYC-03): no
# separate setting. Changing IDENTITY_HASH_KEY voids every handle out.
IDENTITY_HASH_KEY=
BVN_CHECKS_PER_DAY=
SELFIE_CHECKS_PER_DAY=
# Under WALLET_PROVIDER=nuvion (NUV-02 round 3), both may stay empty
# (provisional): IDENTITY_HOLD_DAYS, how long an unfinished opening holds its
# BVN (14), and OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR, the opening tries one
# address may make in an hour (10).
IDENTITY_HOLD_DAYS=
OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR=
# Opening the account (MONEY-12) needs IDENTITY_HASH_KEY and the FINTAVA_*
# settings above. The wallet's bank name (empty: "Loma Bank", provisional)
# and the owner's licence and deposit-insurance lines (empty: hidden).
WALLET_BANK_NAME=
WALLET_LICENCE_LINE=
WALLET_DEPOSIT_INSURANCE_LINE=
# Receipts (WALLET-18): the address a receipt's code opens, without the
# code: https://<the API's public host>/api/hub/r. Empty: receipts print
# wawu/r/<code> with no link. Receipts print WALLET_BANK_NAME and
# WALLET_LICENCE_LINE as above.
RECEIPT_VERIFY_BASE_URL=
# Receipt images and PDFs drawn at once (WALLET-18; 1 to 8, empty: 2,
# PROVISIONAL(RECEIPT-RENDER-CONCURRENCY)). A PDF in flight holds about
# 45 MB; a request waits up to 10 s for a turn, then gets 503 with Retry-After.
RECEIPT_RENDER_CONCURRENCY=
# About: where "Contact support" sends mail (SETTINGS-02). The owner's fact, no default
# (empty: the row says "Not available yet").
SUPPORT_EMAIL=
# Nuvion's charges (NUV-07, R-42), read only when WALLET_PROVIDER=nuvion. No
# default: the owner fills them in from Nuvion's written NGN fees (NUV-10).
# While any is empty under nuvion, every fee quote and every money-moving
# route answers 503 fees_not_set and nothing is sent to Nuvion (the balance,
# history and account number keep working). Kobo: one whole number, or
# from:fee bands such as 0:<fee>,<from>:<fee>. A bad value stops the server
# at boot. Set them, then `sudo systemctl restart wawu-hub-api`. A rollback to
# fintava ignores them (Fintava's ruled fees apply, .env.example).
NUVION_FEE_BOOK_TRANSFER=
NUVION_FEE_BANK_PAYOUT=
NUVION_FEE_INFLOW=
# WAWU's own limits on moving money (NUV-07), per person and per kind, under
# either provider. Whole kobo, 1 or more; empty = no WAWU limit. Above one,
# 403 limit_reached naming the limit, before anything is sent. The owner sets
# them (NUV-10); a bad value, or a per-transaction limit above its daily one
# (or a daily above its monthly), stops the server at boot.
WAWU_LIMIT_WAWU_TRANSFER_PER_TRANSACTION_KOBO=
WAWU_LIMIT_WAWU_TRANSFER_DAILY_KOBO=
WAWU_LIMIT_WAWU_TRANSFER_MONTHLY_KOBO=
WAWU_LIMIT_BANK_TRANSFER_PER_TRANSACTION_KOBO=
WAWU_LIMIT_BANK_TRANSFER_DAILY_KOBO=
WAWU_LIMIT_BANK_TRANSFER_MONTHLY_KOBO=
WAWU_LIMIT_PURCHASE_PER_TRANSACTION_KOBO=
WAWU_LIMIT_PURCHASE_DAILY_KOBO=
WAWU_LIMIT_PURCHASE_MONTHLY_KOBO=
WAWU_LIMIT_BILL_PER_TRANSACTION_KOBO=
WAWU_LIMIT_BILL_DAILY_KOBO=
WAWU_LIMIT_BILL_MONTHLY_KOBO=

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
| `API_DOMAIN` | `api.wawuafrica.com` |

`DROPLET_HOST_KEY` is not optional busywork: without it the workflow would
have to accept any host answering on that IP, which defeats the check.

### 7. Deploy

Push to `main`, or Actions → Deploy Hub API → Run workflow.

The workflow tests first (real Postgres, real JWKS handshake, the full
contract suite) and only then rsyncs. It finishes by curling the live domain
— a run that goes green means the service actually answered, not merely that
`systemctl restart` returned.

---

## Live as of 31 Aug 2026

| | |
|---|---|
| Droplet | `134.122.18.234` (NYC1) |
| Hub API | https://api.wawuafrica.com |
| WAWU ID | https://id.wawuafrica.com |
| Database | managed Postgres NYC3, `wawu_hub` + `wawu_id`, `sslmode=verify-full` |
| Spaces | `wawu` in SFO3 |
| TLS | Let's Encrypt, auto-renewing |

Secrets were carried over from the Railway deployment (`wawu-api` and
`WAWU-ID` services) rather than regenerated, so the RS256 keypair, the
Flutterwave test credentials and the Resend/Termii keys are the same ones that
were already in use. That matters for RS256 specifically: tokens issued by the
Railway deployment remain valid here.

`GEMINI_API_KEY` was never in Railway — the Legal AI intake postdates that
deployment. It is the one key still unset, and only that feature depends on it.

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
