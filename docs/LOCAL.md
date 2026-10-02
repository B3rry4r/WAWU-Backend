# Running WAWU on your own machine

Every task is tested here, never against the live server. This page starts
the whole backend locally: Postgres, `wawu-id` (sign-in) and the Hub API,
with seeded accounts, and shows how the phone reaches it.

```
 phone / web app ──▶ Hub API  :3001  (this repo)      ──┐
        │                │ verifies tokens with JWKS     ├──▶ Postgres :5432
        └──sign in──▶ wawu-id :3002  (wawu-id repo)   ──┘   wawu_hub_local, wawu_id_local
```

The ports match the server (Hub 3001, wawu-id 3002). Port 4001 is left for
`mock-wawu-id`, which only the contract tests use (README, "Running the
tests"). This page runs the **real** `wawu-id`.

## 1. What you need

- **Node 22** (`node -v`), npm, git, curl and bash. macOS and Linux work as
  they are. On Windows, use WSL 2 and run everything inside it.
- **Postgres 16**, either installed or in Docker (step 3).
- Both repos cloned **side by side** in the same folder:

```bash
mkdir wawu && cd wawu
git clone https://github.com/B3rry4r/WAWU-Backend.git wawu-backend
git clone https://github.com/B3rry4r/wawu-id.git wawu-id
```

If `wawu-id` lives somewhere else, set `WAWU_ID_DIR=/path/to/wawu-id` before
step 4.

## 2. Keys and secrets

You need **no keys** to start. The script writes a `.env` in each repo with
local-only values: a freshly generated signing key for `wawu-id`, a random
service key shared by the two, and local database addresses. Both `.env`
files are gitignored. Once they exist, the script changes them only when you
give it a setting (section 4, "Settings"), and then only the lines that
setting controls.

Sandbox keys (Fintava, Cardex) go in `wawu-backend/.env` only, never in a
committed file and never in the mobile app (section 7).

## 3. Postgres

**Option A, installed.** Any Postgres 16 on this machine with a user that can
create databases.

- macOS: `brew install postgresql@16 && brew services start postgresql@16`
- Ubuntu 24.04: `sudo apt install postgresql-16`, then
  `sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';"`.
  Ubuntu 22.04 does not ship Postgres 16: add the PostgreSQL apt repository
  first (https://www.postgresql.org/download/linux/ubuntu/), then the same
  two commands.

**Option B, Docker.**

```bash
docker run -d --name wawu-local-postgres \
  -e POSTGRES_PASSWORD=postgres -p 5432:5432 \
  -v wawu-local-pg:/var/lib/postgresql/data postgres:16
```

The script assumes `postgresql://postgres:postgres@localhost:5432`. If yours
differs (another user, password or port, for example `-p 5433:5432` because
5432 is taken), give it `LOCAL_PG_URL` (section 4, "Settings"):

```bash
LOCAL_PG_URL=postgresql://me:secret@localhost:5433 scripts/local/up.sh
```

That also fixes a run that already failed on the wrong password or port:
rerun with the right `LOCAL_PG_URL` and it rewrites `DATABASE_URL` in both
`.env` files, keeping the database names.

You do not create the databases. Migrating creates `wawu_hub_local` and
`wawu_id_local` if they are missing (`HUB_DB` and `ID_DB` change the names).

## 4. Start everything

From `wawu-backend`:

```bash
scripts/local/up.sh
```

On a fresh clone this takes a few minutes. It:

1. checks Node and the `wawu-id` checkout;
2. runs `npm ci` in each repo that has no `node_modules`;
3. writes `wawu-id/.env` and a signing keypair in `wawu-id/keys/` (both
   gitignored there), and `wawu-backend/.env` from `.env.example`, if they
   are missing, applies any settings you gave, and runs the safety checks
   below;
4. migrates both databases (`prisma migrate deploy`);
5. seeds the Hub (`prisma/seed.ts`) and gives the same three accounts a
   sign-in on `wawu-id` (`scripts/local/seed-wawu-id.js`);
6. builds both and starts them, waits for both health endpoints, and prints
   the addresses.

Ctrl-C stops both. To leave them running in the background instead:

```bash
scripts/local/up.sh --detach     # start
scripts/local/down.sh            # stop
```

Logs are in `wawu-backend/.local/logs/`: `wawu-id.log` and `hub-api.log`
for the running services, and one file per setup step (`id-install`,
`id-migrate`, `hub-migrate`, `hub-seed`, `id-seed`, `id-build`, `hub-build`
and so on), rewritten on every run.

**Settings.** All optional, given as environment variables on the command
line. A setting you give is written into both `.env` files on that run (so
it also corrects a run that failed); one you leave out keeps what the `.env`
files already say, or the default the first time.

| Setting | Default | What it changes |
| --- | --- | --- |
| `LOCAL_PG_URL` | `postgresql://postgres:postgres@localhost:5432` | the Postgres server (user, password, host, port) in both `DATABASE_URL`s |
| `HUB_DB` | `wawu_hub_local` | the Hub's database name |
| `ID_DB` | `wawu_id_local` | `wawu-id`'s database name |
| `HUB_PORT` | `3001` | the Hub's port, and where `wawu-id` calls it |
| `ID_PORT` | `3002` | `wawu-id`'s port, and where the Hub fetches its signing keys |
| `WAWU_ID_DIR` | `../wawu-id` | where the `wawu-id` checkout is |

For example, with 3001 and 3002 already taken:
`HUB_PORT=3101 ID_PORT=3102 scripts/local/up.sh`. If you move the ports, use
the new ones in the addresses below.

**Safety.** It refuses to run, before touching any database, if either
`.env` points at a database that is not on this machine, if `NODE_ENV` is
`production`, if `FINTAVA_BASE_URL` is set to anything but Fintava's sandbox
host, or if `CARDEX_API_KEY` is not a `cdx_test_` key. It reads the `.env`
files with dotenv, exactly as the services do, so `export KEY=...`, indented
lines and a later duplicate line are all seen. It also ignores any of those
variables exported in your terminal (`DATABASE_URL`, `PORT` and the rest),
and any `DOTENV_CONFIG_*` or `DOTENV_KEY` (which would make Prisma load a
different file), and it hands every migrate, seed and service the
`DATABASE_URL` it has just checked. A variable left over from another
project cannot redirect it.

## 5. Check it works

```bash
curl http://localhost:3001/api/hub/health
# {"statusCode":200,"message":"OK","data":{"ok":true,"service":"wawu-hub-api"}}
curl http://localhost:3002/health
# {"status":"ok"}
```

Then the end-to-end check, with the stack running:

```bash
scripts/local/smoke.sh
```

It registers a new person on `wawu-id`, confirms their email with the code
`wawu-id` generated, signs in through the real `/auth/login`, calls
`GET /api/hub/users/me` with that token (and without one, which must be
401), writes their bio and reads it back, then signs in as a seeded creator
and reads the seeded profile. It prints one PASS line per step and exits 0
only if all passed. No token is made up anywhere; every one comes from
`wawu-id`'s login.

## 6. Signing in

**Seeded accounts.** Password `wawu-local-2026` (or `LOCAL_SEED_PASSWORD` if
you set it before step 4). Same people and ids as `prisma/seed.ts`:

| Email | Who |
| --- | --- |
| `user@test.wawu.dev` | plain user (Adaeze Okonkwo) |
| `creator-basic@test.wawu.dev` | creator, KYC pending (Chidi Umeh) |
| `creator-pro@test.wawu.dev` | creator, KYC approved (Zainab Bello) |

**A new account,** the way the app does it. Locally no email is sent:
`wawu-id` has no `RESEND_API_KEY`, so it writes each code it generates to
its log instead.

```bash
ID=http://localhost:3002; HUB=http://localhost:3001/api/hub

curl -X POST $ID/auth/register -H 'content-type: application/json' -d '{
  "firstName":"Ngozi","lastName":"Eze","email":"ngozi@example.test",
  "phone":"+2348012345678","country":"Nigeria","password":"choose-a-password"}'

curl -X POST $ID/auth/email/verify/start -H 'content-type: application/json' \
  -d '{"email":"ngozi@example.test"}'
grep -a "to=ngozi@example.test" .local/logs/wawu-id.log | grep -o 'code=[0-9]*' | tail -1

curl -X POST $ID/auth/email/verify/confirm -H 'content-type: application/json' \
  -d '{"email":"ngozi@example.test","code":"<the code>"}'

TOKEN=$(curl -s -X POST $ID/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"ngozi@example.test","password":"choose-a-password"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.accessToken')

curl $HUB/users/me -H "authorization: Bearer $TOKEN"
```

Signing in before confirming the email answers `EMAIL_NOT_VERIFIED`, as it
does on the server. Access tokens last 15 minutes; sign in again for a new
one.

## 7. Reaching it from the phone

The app reads the Hub's address from `EXPO_PUBLIC_API_URL` when it is
started or built.

**Web on this machine.** `EXPO_PUBLIC_API_URL=http://localhost:3001 npm run web`
in the mobile repo. The browser enforces CORS, so the web app's address must
be in `CORS_ORIGIN` in `wawu-backend/.env`. The script lists
`http://localhost:8081` (Expo's web port), `http://localhost:19006` and
`http://localhost:3000`. If you serve the web app anywhere else, add that
origin, comma separated, and restart.

**Phone on the same Wi-Fi.** Both services listen on every network
interface, so the phone can use this computer's LAN address. `up.sh` prints
it; otherwise `ipconfig getifaddr en0` (macOS) or `hostname -I` (Linux).

```bash
EXPO_PUBLIC_API_URL=http://192.168.1.23:3001 npx expo start
```

- The phone and the computer must be on the same network, and the
  computer's firewall must allow incoming connections on 3001 and 3002
  (with the macOS firewall on, it asks the first time `node` listens; say
  Allow).
- Some office and hotel Wi-Fi blocks devices from seeing each other. Use a
  tunnel there.
- Native apps send no `Origin`, so CORS does not apply to them. A phone's
  browser does: add `http://192.168.1.23:8081` to `CORS_ORIGIN` if you open
  the web app on the phone.
- Signing in from the phone talks to `wawu-id`, at
  `http://192.168.1.23:3002`.

**Through a tunnel.** A tunnel gives this machine a public HTTPS address.
Use it when the phone is on another network, and always for Fintava's and
Cardex's webhooks, which cannot reach `localhost`. Either of:

```bash
cloudflared tunnel --url http://localhost:3001     # no account needed; prints https://<random>.trycloudflare.com
ngrok http 3001                                    # needs a free ngrok account
```

Then `EXPO_PUBLIC_API_URL=https://<random>.trycloudflare.com`. The phone
also needs `wawu-id` to sign in, so run a second tunnel for port 3002. A
quick tunnel's address changes every time it starts; whatever you gave it
to (the app, a dashboard) needs the new one.

## 8. Fintava and Cardex sandbox

`.env.example` lists the settings, empty:

```
FINTAVA_BASE_URL=        # sandbox: https://dev.fintavapay.com/api/dev
FINTAVA_API_KEY=
FINTAVA_WEBHOOK_SECRET=
CARDEX_BASE_URL=         # https://cardex.live/api (cdx_test_ keys are the sandbox)
CARDEX_API_KEY=
CARDEX_SIGNING_SECRET=
CARDEX_WEBHOOK_SECRET=
```

Put the **sandbox** values in `wawu-backend/.env` and restart. Never the live
ones: local testing is sandbox only, and `up.sh` refuses any Fintava URL but the sandbox
and any Cardex key that is not `cdx_test_`.

MONEY-06 added the Fintava client and MONEY-07 the Fintava webhook route,
`POST /api/hub/webhooks/fintava`; WALLET-33 does the same for Cardex.
To receive their webhooks locally:

1. Start a tunnel to port 3001 (section 7).
2. In the Fintava (or Cardex) dashboard, set the webhook URL to the tunnel's
   `https://` address followed by the webhook route: for Fintava,
   `https://<random>.trycloudflare.com/api/hub/webhooks/fintava`.
3. Set the dashboard's webhook secret as `FINTAVA_WEBHOOK_SECRET` (or
   `CARDEX_WEBHOOK_SECRET`) in `.env`, and restart.
4. When the tunnel restarts with a new address, update the dashboard.

Fintava's sandbox retries a webhook hourly for 72 hours until it gets a 200,
so a delivery missed while the tunnel was down arrives later on its own.

**Without a tunnel** (the usual case, DECISIONS R-25), send the endpoint a
delivery yourself: a body in Fintava's documented format, signed with your
local `FINTAVA_WEBHOOK_SECRET` as Fintava signs it (HMAC-SHA512 of the exact
bytes, hex). With the secret in your shell:

```bash
BODY='{"event":"account_funded","data":{"reference":"LOCAL-1","amount":"100.00","status":"success"}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha512 -hmac "$FINTAVA_WEBHOOK_SECRET" -hex | sed 's/^.* //')
curl -sS -X POST http://localhost:3001/api/hub/webhooks/fintava \
  -H 'Content-Type: application/json' -H "x-fintava-signature: $SIG" --data "$BODY"
```

It answers 200 with `outcome: "recorded"` the first time and `"duplicate"`
after; the row is in `FintavaWebhookEvent`. The test
`src/fintava/webhook/tests/fintava-webhook.contract.spec.ts` sends every
documented event this way.

## 9. What differs from the server

Know these before trusting a local result:

- **Email is not sent.** Codes are in `.local/logs/wawu-id.log`. Set
  `RESEND_API_KEY` in `wawu-id/.env` to send real mail.
- **Flutterwave (the web's current payments).** With
  `FLUTTERWAVE_SECRET_KEY` empty, the Hub's existing Flutterwave paths
  (content unlocks, credits, paid DMs and the rest) use the mock adapter
  already in this repo, which approves every charge without any money
  moving. A Flutterwave payment that "succeeds" locally proves nothing. Put a
  Flutterwave **test** key (`FLWSECK_TEST-...`) in `.env` to use their
  sandbox. The server refuses to start without a real key.
- **Uploads are rejected.** No object storage is configured (`STORAGE_*`),
  and the Hub logs that at startup. Set the `STORAGE_*` values to an
  S3-compatible test bucket to test uploads. This page does not cover that.
- **Admin routes answer 401** until `ADMIN_JWT_SECRET` and
  `ADMIN_JWT_REFRESH_SECRET` are set (README, "Admin surface"), then
  `npm run admin:seed` creates the first admin.
- **The legal brief** needs `GEMINI_API_KEY`; without one it refuses.

## 10. Reset and troubleshooting

**Start again from empty.** Stop the stack, then drop only your local
databases (the names in your `.env` files, if you changed them with
`HUB_DB`/`ID_DB`) and run `up.sh` again:

```bash
scripts/local/down.sh
dropdb -h localhost -U postgres wawu_hub_local
dropdb -h localhost -U postgres wawu_id_local
scripts/local/up.sh
```

**Regenerating a `.env`.** Delete one or both and run `up.sh`. A file written
next to a surviving one copies what must match from it: the shared service
key, both ports, and the Postgres server with its user and password (unless
you give `LOCAL_PG_URL` on that run, which wins). So deleting only
`wawu-id/.env` or only `wawu-backend/.env` is safe. What it cannot recover is
the deleted file's database name if you had changed it: pass `HUB_DB` /
`ID_DB` again on that run. To go back to every
default, delete both. The keypair in `wawu-id/keys/` is reused unless you
delete it too.

| Symptom | Cause |
| --- | --- |
| `Port 3001 (Hub API) is already in use` (or 3002, `wawu-id`) | Another copy is running: `scripts/local/down.sh`. Something else owns the port: stop it, or move ours with `HUB_PORT=<free port>` / `ID_PORT=<free port>` (section 4, "Settings"). |
| `DATABASE_URL on "<host>", not this machine` | A `.env` from elsewhere is in place. Rerun with `LOCAL_PG_URL=...` to point it at local Postgres, or delete both `.env` files and rerun. |
| `id-migrate failed` (it runs first) or `hub-migrate failed`, `P1000` in its log | Postgres refused the user or password. Rerun with the right one: `LOCAL_PG_URL=postgresql://USER:PASSWORD@localhost:5432 scripts/local/up.sh`. It rewrites both `.env` files. |
| `id-migrate failed` or `hub-migrate failed`, `P1001` in its log | Postgres is not running, or the host or port is wrong. Start it, or rerun with the right `LOCAL_PG_URL`. |
| `WAWU_ID_INTERNAL_SERVICE_KEY ... differ` | The two `.env` files were edited apart. Set the same value in both, or delete both and rerun. |
| Every authenticated call is 401 | The Hub checks tokens against `WAWU_ID_JWKS_URL`. It must be the running `wawu-id`'s port, and the token must come from that `wawu-id`. `up.sh` checks the port. |
| `EMAIL_NOT_VERIFIED` on login | Confirm the email first (section 6). |
| Web app: "blocked by CORS policy" | Add the web app's origin to `CORS_ORIGIN` (section 7). |

## Nothing here changes production

The scripts live in `scripts/local/`, write only gitignored files (`.env`,
`.local/`, `wawu-id/.env`, `wawu-id/keys/`), and are not used by `deploy/`
or `.github/`. The server's settings stay in `/etc/wawu/*.env` on the droplet
(`deploy/README.md`).
