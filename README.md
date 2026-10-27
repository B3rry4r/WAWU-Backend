# WAWU Hub API

NestJS + Prisma backend for the WAWU creator content marketplace.

**Run it on your own machine** (with `wawu-id`, seeded accounts, and the phone
pointed at it): [`docs/LOCAL.md`](docs/LOCAL.md). One command:
`scripts/local/up.sh`.

## Running the tests

**The contract suite is not parallel-safe. Always run it with `--runInBand`.**

```bash
npm run test:contract
```

That script is the supported entry point. It pins `--runInBand --forceExit` and
defaults the three environment variables the suite needs:

| Variable | Default |
| --- | --- |
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public` |
| `WAWU_ID_JWKS_URL` | `http://localhost:4001/.well-known/jwks.json` |
| `WAWU_ID_BASE_URL` | `http://localhost:4001` |

Each is overridable by exporting it first. Port 4001 is the local
`mock-wawu-id` service (`node mock-wawu-id/server.js`); the specs reuse an
already-running instance and spawn one only if the port is cold. Note that the
committed `.env` points `WAWU_ID_*` at the **real** WAWU ID on :3002 — that is
why the variables have to be set explicitly for a test run, and why
`WAWU_ID_INTERNAL_SERVICE_KEY` from `.env` must not leak into a spec that talks
to the mock (`verification-submission` pins its own; see the comment there).

### Why not parallel

Running bare `jest` (parallel, the default) fails a handful of tests, and **a
different handful on each run** — the counts and the names are not stable. The
cause is not a flake in any one spec: most specs share the same three seeded
accounts from `prisma/seed.ts` and the single `CreatorState` / `CreditsState`
rows that hang off them. In parallel, workers interleave reads and writes on
those rows, so one spec's balance decrement or slot claim lands in the middle
of another's assertion.

Fixing that properly means giving every spec its own identities. Two specs now
do —`src/community/tests/community.contract.spec.ts` registers throwaway WAWU
IDs and tears them down in `afterAll`, and
`src/creator-state/tests/creator-state.contract.spec.ts` owns its rows under
fixture UUIDs — and that pattern is what any newly isolated spec should copy.
Until the rest follow, `--runInBand` is the only way to get a comparable
number, and a parallel run's failures should not be read as regressions.

### Branch checks, and the deploy's tests (DEPLOY-FAST)

GitHub runs the whole suite on every `wmt/**` push, in 3 shards of
`npx jest --runInBand --forceExit --shard=N/3` (about 20 minutes), plus the
`netns` job. The deploy (`.github/workflows/deploy.yml`) runs those same two
jobs, `suite` and `netns`, after a merge to main, and only then deploys.
`scripts/ci/check_deploy_in_sync.py` (job `deploy-test-in-sync`) fails when a
test step differs between the two files, and proves on every run that it would
catch a dropped or changed step, a missing shard or a removed guard.

The deploy skips its tests only for a tree a branch has already passed. Its
first job, `decide` (`scripts/ci/decide_skip_tests.py`), looks at the commit
being deployed and at its second parent when it is a merge with the same tree
(the branch already contained main). If, on that exact commit, the newest push
run of Branch checks (every job), Gates and Protected routes all succeeded, the
tests are skipped; if anything else is true or cannot be read, they run. The
migrate, build, restart and smoke test steps always run. The job log and
summary name the decision and the run ids. To prove it without deploying, run
the workflow by hand from a branch with `dry_run` on (`force_tests` runs the
tests even when the decision is to skip them): the deploy job never runs for a
dry run, or for any ref but main.

### Test hygiene rules

A spec must leave `wawu_hub_test` exactly as it found it. Two ways to comply,
in order of preference:

1. **Own your fixtures.** Create rows under UUIDs nothing else touches and
   delete them in `afterAll`. Prefer this.
2. **Snapshot and restore.** If an assertion genuinely needs a seeded row
   (`content-piece` needs the seeded creator's own content for its `scope=mine`
   assertions), snapshot the row in `beforeAll` and write it back in
   `afterAll`.

Deleting the rows you created is not always enough: claiming an upload slot
increments `CreatorState.slotsUsed`, and deleting the ContentPiece does not
give the slot back. That leak is what made `CreatorState › slotsTotal` pass or
fail depending on suite order.

Watch foreign-key directions when tearing down — `Purchase -> ContentPiece` is
`onDelete: Restrict`, not `Cascade`, so purchases must be deleted first.

### Resetting the database

Some tables (`Purchase`, `CreditPurchase`, `Comment`) still accumulate rows
across runs from specs that have not been isolated yet. Nothing asserts on
their totals today, so this is untidy rather than breaking, but to get back to
a clean baseline:

```bash
npm run test:db:clean     # non-destructive: removes only test-generated rows
```

A full reset is `npx prisma migrate reset` against `wawu_hub_test` — that drops
every table, so check `DATABASE_URL` first. Note that re-seeding alone does
**not** repair a mutated seed row: `prisma/seed.ts` upserts with `update: {}`,
so an existing row is left exactly as the last test run left it.

## Local test stack

One command starts and stops a whole local stack, so nobody builds one by hand.
Full suites run in GitHub (OPS-CI) on every push to `wmt/**`, not locally: use a
stack to run a single spec, or to drive the Hub, the web or the app in a browser.

```bash
scripts/dev/stack.sh up --name <n> --ports <a>-<b> [--with id,web,mobile] \
    [--web <path>] [--id <path>] [--mobile <path>] [--rebuild] [--scratch <dir>]
scripts/dev/stack.sh status --name <n>
scripts/dev/stack.sh down   --name <n>
```

| Service | Port | Always? | What it is |
| --- | --- | --- | --- |
| Hub | `a` | yes | built from this checkout, database `<n>_wawu_hub_test`, migrations applied |
| wawu-id | `a+1` | `--with id` | the real identity service from `--id`, database `<n>_wawu_id_test` |
| web | `a+2` | `--with web` | production build of `--web` (`VERCEL_ENV=production`, so `/join` only), pointed at this Hub |
| mobile | `a+3` | `--with mobile` | web export of `--mobile` with its own Metro cache, then a grep that only this stack's ports are baked in |
| Nuvion stand-in | `b-1` | yes | `scripts/dev/nuvion-standin.cjs`: the wallet provider the Hub runs on (see below) |
| mock WAWU ID | `b` | yes | the mock the contract suite uses (`mock-wawu-id/`), on the last port of the range |

- The Hub signs people in through wawu-id when `id` is on, and through the mock
  otherwise. Payments use the repo's own Flutterwave mock (no key is set).
  The Hub always runs `WALLET_PROVIDER=nuvion` (there is no Fintava option);
  Fintava's settings point at a closed port on this machine and nothing uses
  them. `scripts/dev/block-net.cjs` is preloaded into the Hub and wawu-id and
  refuses any request to a host that is not this machine, so nothing reaches a
  real provider or a wawuafrica.com host.
- The range must hold every port asked for, the Nuvion stand-in one below the
  last, and end above them, for example `--ports 6531-6535 --with id,web` (Hub
  6531, id 6532, web 6533, stand-in 6534, mock 6535) or `--ports 6537-6539`
  (Hub 6537, stand-in 6538, mock 6539). `status` names the provider and the
  stand-in's port.
- Names are lower case letters, digits and `_` (agents use their brief's prefix,
  for example `ostk1`). Each name has its own databases, logs and PIDs.
- Logs go to `<scratch>/<n>/logs/`, PIDs to `<scratch>/<n>/pids`. `<scratch>` is
  `--scratch`, else `$STACK_SCRATCH`, else `${TMPDIR:-/tmp}/wawu-stack`; give
  `status` and `down` the same one. `up` prints one summary: each service, URL,
  PID and `UP`, or the last 15 lines of the log that failed. Whatever started
  stays up after a failure; `down` stops it.
- `. <scratch>/<n>/env.sh` points one spec at the stack (`DATABASE_URL` and the
  mock WAWU ID's URLs), e.g. `npm run test:contract -- <spec>`.
- `up` refuses to start when `free -g` shows under 5 GB available
  (`STACK_MIN_FREE_GB`) or when any port of the range is already listening
  (it names the process holding it), and changes nothing.
- A service is `UP` only when its own process (or a child of it) is the listener
  on its port. A port that answers because another stack holds it does not count:
  `up` prints the service as `FAILED`, a `why:` line and the last lines of its log,
  and exits non-zero; `status` says `NOT OURS` for it. Check it with
  `scripts/dev/stack-selftest.sh [base-port]` (default `7850`; it uses eight ports
  from the base, needs no database and ends with `EXIT 0` or `EXIT 1`).
- `down` stops every recorded PID and its children, confirms the ports are
  closed with a connect test and drops the databases. Running it twice is safe.
- `--id`, `--web` and `--mobile` take a checkout of your own (a worktree): the
  stack builds inside it (`dist/`, `.next/`), and one web checkout serves one
  stack at a time. If a checkout has no `node_modules`, `up` links the folder in
  `STACK_NM_HUB`, `STACK_NM_ID`, `STACK_NM_WEB` or `STACK_NM_MOBILE` when its
  lockfile is the same, and runs `npm ci` otherwise. `dist/` is rebuilt only when
  the source is newer (`--rebuild` forces it), so do not rebuild the Hub checkout
  while a stack from it is running.
- `STACK_NUVION_LIVENESS=on` turns the hosted selfie on in the Hub (`NUVION_HOSTED_LIVENESS=on`, with the app's return
  address `https://wawuafrica.com/selfie` as the only one it may hand on; nothing is ever sent to it). Left unset it is
  off and the opening does not wait for a selfie. See "Nuvion on the stack".
- `STACK_STORAGE_ENDPOINT` (with `STACK_STORAGE_PATH_STYLE=true` for a path-style
  stand-in) points the Hub's object storage at a stand-in on this machine, for a
  spec that must see the Hub's own storage calls. Left unset, storage is a name
  the network guard refuses.
- `SIGNUP_VERIFY_CHANNEL=email` is set on wawu-id by `stack.sh` (R-72, SWEEP-FLOWS B1), so the sign-up code is mailed and a
  fresh stack can sign someone up. `STACK_SIGNUP_VERIFY_CHANNEL=phone` turns the texted path back on for a test. wawu-id's own
  default is not changed here (production sets it). With no mail transport (next line) the code is not delivered anywhere a
  person can read it, so pair it with the mail stand-in.
- `STACK_RESEND_API_KEY` (any text, with `RESEND_BASE_URL` set in the same shell)
  gives wawu-id a mail transport; `node scripts/dev/mail-standin.cjs <port> <file>`
  is a stand-in for it that records each mail it is given. Left unset, wawu-id has
  no transport and an email route answers 503 (FIX-53, the data-export email).

### AI voice and storage on the stack (AITOOLS-01)

The AI voice tools call a voice provider whose key is the owner's and is on no
build machine, so a stack runs them against a local stand-in. `stack.sh` does
not start it: run `node scripts/dev/voice-standin.cjs <port>` (it answers the
provider's one call, `POST /v1/text-to-speech/<voice>`; a script containing
`[[fail]]`, `[[reject]]`, `[[html]]` or `[[slow:1500]]` makes it fail, refuse,
answer with a web page or wait) and export `AI_VOICE_BASE_URL=http://127.0.0.1:<port>`,
`AI_VOICE_API_KEY=standin-key` and `AI_VOICE_VOICES` (a JSON list of `{ id, name,
description, providerVoiceId }` with provider voice ids `stand-in-ada` and
`stand-in-tunde`) in the shell that runs `stack.sh up`. A finished job stores its
audio, so also run `node scripts/dev/storage-standin.cjs <port> stack-bucket` and
set `STACK_STORAGE_ENDPOINT=http://127.0.0.1:<port>` with
`STACK_STORAGE_PATH_STYLE=true`. Keep both ports outside the stack's range.
Without these the tool is listed `enabled: false` and a job is refused.

Since AITOOLS-03 it also answers `POST /v1/sound-generation` (Sound effect) and
`POST /v1/music` (Music track) with silent MP3 frames of the asked length
(`GET /__standin/state` lists each call's `sfx` and `music` options), with the
same four markers in the prompt. A track call has its own timeout,
`AI_VOICE_MUSIC_TIMEOUT_MS` (default 600000). It is made with `node:http(s)`,
not `fetch`, because Node's `fetch` ends a call that has sent no answer in 300
seconds whatever the setting says; here the setting is the real wait, headers
and body. Sound effect and Music track need only `AI_VOICE_BASE_URL` and
`AI_VOICE_API_KEY` to be listed (they use no voice); VoiceOver and Quick voice
also need `AI_VOICE_VOICES`. The track call sends the same
`user-agent` as `fetch` and follows up to 3 redirects as `fetch` does (307 and
308 repeat the POST; 301, 302 and 303 become a GET); a fourth fails like any
other 3xx answer. A job the provider refuses keeps the provider's HTTP status
in the server log only (`ai job <id> ... answered 402`), never on the job (its
`providerRef` holds a provider job id and is never written by a failure) and
never shown to the person.

Captions and Clean audio (AITOOLS-04) take the person's own file and need only
`AI_VOICE_BASE_URL` and `AI_VOICE_API_KEY`. The two file calls are made with
`node:http(s)` and wait up to `AI_VOICE_FILE_TIMEOUT_MS` (default 600000, from the
longest file the plan allows, not from a measured run); `AI_VOICE_TRANSCRIBE_MODEL`
(default `scribe_v2`) names the speech to text model. The stand-in answers
`/v1/speech-to-text`, `/v1/audio-isolation` and their `DELETE` routes, and reads
its failure markers (`[[fail]]`, `[[reject]]`, `[[status:n]]`, `[[html]]`,
`[[slow:n]]`, `[[reported:secs]]`, `[[iso-type:type]]`) from the file's bytes.
`docs/contract/PLANS.md` section "Captions and Clean audio" says the rest.

Dubbing (AITOOLS-05) needs the same two settings. The stand-in answers
`POST /v1/dubbing/project`, `GET /v1/dubbing/project/{id}/language/{id}`,
`GET` and `DELETE /v1/dubbing/project/{id}` and the two signed links of a finished
dub (`/__standin/dub-out/<project>/audio` and `/subtitles`, FLAC and WebVTT, fetched
with no key). A dub completes after `--dub-delay-ms` (default 0) or the file's
`[[dub-delay:ms]]`; the file's other markers are `[[dub-failed]]`, `[[dub-stale]]`,
`[[dub-stuck]]` (never finishes), `[[dub-nolang]]`, `[[dub-noaudio]]`, `[[dub-nosubs]]`,
`[[dub-outfail]]`, `[[dub-notflac]]`, `[[dub-badvtt]]`, `[[dub-bytes:n]]` and the
copy markers above. On the stack the Hub follows a dub every 15 seconds
(`AiDubService`); `docs/contract/PLANS.md` section "Dubbing" says the rest.

Since AITOOLS-02 the stand-in answers from one route table (a later tool adds its
route and its markers there) and keeps the `model_id` of each speech call in
`GET /__standin/state` (`models`, `lastModel`), so a spec can see that Quick voice
ran on the faster model (`AI_VOICE_QUICK_MODEL`, default `eleven_flash_v2_5`)
while VoiceOver ran on `AI_VOICE_MODEL`. Quick voice is listed only when the
voice settings above are set.

The same stand-in serves the Voice Intro (VOICE-01): "hear your name" is the
text-to-speech call with the first listed voice, and a Voice Intro in a
person's own voice is `POST /v1/voices/add` (the sample as a multipart file,
answering a one-run voice id), the same text-to-speech call with that id, then
`DELETE /v1/voices/<id>`. A recording containing `[[sample-reject]]` or
`[[sample-fail]]` makes the voice call refuse or fail; the script markers above
work as before. The recording is a `voice/sample` upload, so the storage
stand-in is needed for a Voice Intro on a stack too.

### Nuvion on the stack (STACK-NUV)

The Hub's Nuvion adapter accepts only Nuvion's two real hosts, so the stack gives
it the sandbox host and `scripts/dev/nuvion-redirect.cjs` (preloaded after
`block-net.cjs`) sends every request to that one host to the stand-in on
`127.0.0.1`. Nuvion's production host stays refused. The stand-in answers what the
adapter calls, in the shapes of the in-process double (`test/nuvion/`): entities,
documents, the onboarding submission (approved after about a second), the naira
account and its account details (active with a ten-digit number), accounts and
balances, book transfers to a `nuvion_ban` (also WAWU's operational account),
bank sends (bank list, name check, counterparties, payment details, transfers),
an account's month statement (`GET /accounts/{id}/statements`, FIX-67: built from the
transfers it records, so `npm run money:check` can read every wallet on a stack; its
spec is `src/nuvion/tests/nuvion-standin-statements.spec.ts`),
and the webhooks the Hub expects, signed with a test secret the stack sets
(`x-nuvion-event-signature`, HMAC-SHA256 of `timestamp.body`). A transfer is
`pending`, debits the payer at once and settles after 1.5 s (`outflows.completed`).
The Hub reads webhooks on a 30 second tick, so opening a wallet (three webhooks in
a row) takes about two minutes. The Nuvion fees are the stack's own
(`STACK_NUVION_FEE_BOOK`, `STACK_NUVION_FEE_BANK`, `STACK_NUVION_FEE_INFLOW`, kobo;
defaults 0, 2500, 0), given to the Hub and charged by the stand-in alike. The Hub
also gets `NUVION_WALLET_BANK_NAME=Nuvion` (FIX-P5), as production does, so
`GET /about` answers `bankName: "Nuvion"` and the app draws "Powered by Nuvion". The
stand-in's log is `<scratch>/<n>/logs/nuvion.log`.

```bash
# 1. A person with an approved, funded wallet, through the Hub's own routes. Prints one JSON line:
#    token, userId, accountNumber, pin, balanceKobo (the Hub's and the stand-in's). --token for a stack with --with id.
node scripts/dev/nuvion-tool.cjs seed --name <n> --scratch <dir> [--amount-kobo 5000000] [--pin 4829]
# 2. A signed webhook from the stand-in to the Hub: money in, or move a transfer on.
node scripts/dev/nuvion-tool.cjs fire --name <n> --scratch <dir> --inflow <account number> --amount-kobo 250000
#    also: --settle <transfer id> --status failed|reversed|successful   --event <name> --transfer-id <id>   --state
```

Two more switches, for the app's walks (ME-13 L3, FIX-47 L2):

```bash
# A purchase waits: while the hold is on, a book transfer into WAWU's operational account (a tier, ticket or DM
# payment) stays pending and the payer is debited at once. "Paid, still confirming" (M15) is then on the person's
# Verification page. Release it (the signed outflows.completed webhook goes to the Hub; the Hub reads webhooks on
# its 30 second tick), or fail it: status failed|reversed. `narration` holds only the transfers whose narration contains it.
curl -s -X POST http://127.0.0.1:<stand-in port>/__standin/hold    -H 'content-type: application/json' -d '{"on":true}'
curl -s -X POST http://127.0.0.1:<stand-in port>/__standin/release -H 'content-type: application/json' -d '{}'
# The hosted selfie: start the stack with STACK_NUVION_LIVENESS=on (the Hub gets NUVION_HOSTED_LIVENESS=on and the app's
# return address as the one it may hand on). The stand-in answers /kyc/liveness/sessions and serves the page its https
# address opens, GET /capture/<id> (buttons: take the selfie, face does not match, camera problem). The address is
# https://verify.example.invalid/capture/<id> (STANDIN_SELFIE_ORIGIN): a browser on the machine sends that origin to the
# stand-in's port. GET /__standin/liveness lists the sessions; POST /__standin/liveness/<id>/finish decides one by hand.
```

Their spec is `src/nuvion/tests/nuvion-standin-hold-selfie.spec.ts` (the hold and release through the signed webhook,
and the hosted selfie read through the Hub's own liveness area).

`fire --state` (or `GET <stand-in>/__standin/state`) lists the stand-in's accounts,
transfers and webhooks sent; `GET /__standin/account/<id, number or ban>` reads one
balance, to compare with `GET /api/hub/money/wallet/balance`. The Hub never sees a
control route.

`scripts/dev/quiet.sh <name> -- <command...>` runs any command with its full
output in `<scratch>/logs/<name>.log`, appends `EXIT <code>`, prints the last 15
lines and, on failure, up to 20 lines matching `FAIL`, `Error`, `✕` or `failed`.
It exits with the command's code.

## Protected route suite (MONEY-01, V3)

Nothing the live web app or the admin dashboard uses may change behaviour while
this backend grows. This suite is the tripwire, and V3 in the mobile repo's
`docs/WORKFLOW.md` is "run it before and after".

**What is protected.** `.pipeline/protected-registry.json`, section
`protectedRoutes`: every Hub route that `wawuafrica` (web) and `wawu-dashboard`
call today, read from each repo's `origin/main` (commits in
`protectedRoutes.sources`). 235 routes: 169 from the web, 72 from the dashboard,
6 from both, in 241 entries: six routes whose answer branches on state the
caller already has (GET /credits, /settings/notifications, /settings/privacy,
/creator/state, /users/me, POST /learn/courses/:id/enrol) have a second entry
with a `variant` that pins the other branch. Each entry carries its callers (file:line, or the dashboard's route
key), its auth (`public`, `user-optional`, `user`, `creator`, `admin` plus the
guards and admin roles), a probe, and the status and response shape that probe
got from `main` when the list was locked (`protectedRoutes.lock`).

**What a run proves**, one test per route, in the registry's order
(`src/protected-routes/protected-routes.regression.spec.ts`, generated from the
registry; nothing route-specific is written in it):

1. the route is still mounted with the same guards and admin roles;
2. the auth contract holds on the wire: no token and a malformed token are 401
   on user routes, an admin token is 401 on user routes and a WAWU ID token is
   401 on admin routes, a plain user is 403 on creator routes, an admin outside
   the route's roles is 403;
3. the probe gets the locked status and a body of the locked shape.

"Shape" (`test/protected-routes/shape.ts`) is structure, never values: a key
that disappeared or was renamed fails, a key that appeared fails (a widened
response goes to the owner, WORKFLOW section 9), a type that changed fails, a
list that became an object fails. `null` where a value was recorded passes, and
an array recorded empty accepts any elements, because those depend on the data
a run happens to see. Message text and headers are not pinned.

The probes are a scenario, not isolated calls: five WAWU IDs are registered
fresh in the mock (one never used, for "new account" variants), four admins
(one per role) are created, one seeded account is read for the seeded course
enrolment, a creator uploads,
submits KYC, an admin approves it, a buyer unlocks, tips and DMs, and so on.
Later probes read ids earlier ones captured, so **read the first failure**: the
ones after it may only be its echo.

**Running it on this checkout.** Postgres with a migrated, seeded test database,
and the mock WAWU ID (the suite starts one if the port is free):

```bash
npm run test:protected
```

It also runs inside `npm run test:contract` and deploy.yml's `npx jest` step,
like every other spec, but there it is the branch's own copy of the suite and
lock. **What enforces V3 in CI is `.github/workflows/protected-routes.yml`**
(`permissions: contents: read`, no persisted credentials). It checks out the
BASE branch and runs the base's `scripts/protected-routes/ci-check.sh`,
`run.sh`, `lock-diff.py` and suite against the pull request's head commit.
`run.sh` writes its own jest config and fails unless every locked entry ran
and passed. A pull request that changes the lock or any checker file (`src/`,
`test/`, `scripts/protected-routes`, the workflow), measured from its merge
base, is checked against the base's lock, and its lock diff goes in the job
summary. A line the pull request adds outside the checker (Markdown aside)
that names `test/protected-routes`, `src/protected-routes`, `compareShape` or
`protected-registry` fails the check.
That holds until the owner applies `relock-approved` after its latest push:
only the run that label triggers counts it, and a later push needs it again.
The pull request that introduces the suite is checked against its own lock
(the base has none).

**What this does and does not stop.** It catches accidental changes to a
protected route's shape, auth or status, and accidental or casual edits to the
lock and the checker. It does not block deliberate tampering: the pull
request's own code still runs during the check, so a seed script
(`npm run db:seed`), `prisma.config.ts`, or app code loaded into the same
process can rewrite or patch the checker before it runs. The reference
tripwire above catches the plain versions of those; an obfuscated one is caught
only by review of the diff, which is where deliberate tampering is visible.

**For the owner (repository settings, not code):** make the "Protected route
suite against the base branch's checker and lock" check required on `main`.
Add CODEOWNERS entries, with required review, for `.github/`,
`scripts/protected-routes/`, `test/protected-routes/`, `src/protected-routes/`
and `.pipeline/protected-registry.json`. On `pull_request` GitHub runs the
workflow file from the pull request, so those two settings are what protect
the workflow itself.

**Running it against any branch (V3).** The code comes from the ref you name;
the suite and the lock come from `PROTECTED_LOCK_REF` (default `origin/main`),
so an edit to a branch's own copy of the lock is not what it is checked
against (deliberate tampering aside: see above). Nothing is checked
out: the ref is exported with `git archive` into a temporary directory.

```bash
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/wawu_hub_protected_test?schema=public
export WAWU_ID_BASE_URL=http://localhost:4001

scripts/protected-routes/run.sh --fresh origin/main     # before: main, on a new database
scripts/protected-routes/run.sh --fresh wmt/MONEY-06    # after: the task branch
```

`--fresh` drops, recreates, migrates and seeds the database first; without it
the branch's migrations are applied to the database as it is. Either way
`run.sh` refuses, before it touches anything, a `DATABASE_URL` whose host is
not this machine or whose name does not contain `test` or `protected`. With no ref it runs this checkout. Until
MONEY-01 is merged, `origin/main` has no lock: use
`PROTECTED_LOCK_REF=wmt/MONEY-01`. Exit code 0 is green.

**The environment is pinned** (`test/protected-routes/harness.ts`), so a
developer's `.env` cannot change an answer, and the process is sealed from the
internet. Third-party credentials are dummies, and the providers this backend
calls over `fetch` are answered by canned doubles in
`test/protected-routes/providers.ts`, shaped like each provider's real response
as the code reads it: Flutterwave (checkout verify, bills, payout subaccounts,
transfers, banks, hosted links), WellaHealth (plans, enrolment) and Gemini (the
legal intake brief). Object storage needs no double: presigning is local. So
every route is locked on its success answer except one: a NEW enrolment
(POST /learn/courses/:id/enrol) is refused for everybody on main, because its
free-course slots still come from the removed creator subscription; it is
locked on that 403, and its `already enrolled` variant locks the success shape.
A payment verify sends `flwtx-<amount>-<txRef>` as the transaction id, which
the double answers as a successful payment of that amount. Two switches fill
the operator queues: the biller refuses customer `08000000000`, WellaHealth
refuses phone `08000000000`. Under jest `NODE_ENV` is `test`, so the five
modules with a Mock Flutterwave adapter use it, as in CI; the wallet gateway is
overridden to the production client against the double, because the mock's
balance only ever comes from a funding cron that does not run here.

**When it goes red.** A red run stops the task and goes to the owner (WORKFLOW
section 9). The failure names the route, what was sent, the status and body
that came back, and each shape difference. `PROTECTED_ROUTES_TRACE=<file>`
writes every probe's request and response as JSON lines.

**When a client starts calling a new route**, or stops calling one:

```bash
npm run protected:callers -- --web ../wawuafrica --dashboard ../wawu-dashboard
```

reads both clients at `origin/main` and lists every call that is not protected
and every protected route nobody calls any more (exit 1 if there are any). A new
route gets an entry with a probe, and the list is re-locked.

**Re-locking** (`npm run protected:lock`) re-records every expectation from what
the code answers now and rewrites `protectedRoutes.lock`. It is how the list was
made against `main`, and it is an owner decision, never the way to turn a red
run green. A registry edited without re-locking fails the first test (the lock
is a sha256 of the setup steps and every route).

## Admin surface (`/api/hub/admin/*`)

The admin dashboard authenticates against this backend's **own** `AdminUser`
table. It does not go through WAWU ID, and it shares no configuration with the
user flow.

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `POST /api/hub/admin/auth/login` | none | `{ email, password }` -> `{ accessToken, refreshToken, expiresIn, admin }`. Rate limited to 5/min. |
| `POST /api/hub/admin/auth/refresh` | none | `{ refreshToken }` -> a fresh pair. An access token is rejected here. |
| `GET /api/hub/admin/auth/me` | admin | The signed-in admin. |
| `GET /api/hub/admin/auth/admins` | admin, `superadmin` only | The admin roster. |

Roles are `superadmin`, `reviewer`, `support`, `finance`. A handler declares
what it needs with `@AdminRoles(...)` and `@UseGuards(AdminAuthGuard,
AdminRolesGuard)`; a handler with no `@AdminRoles` is open to every **active**
admin. `superadmin` is not implicitly allowed everywhere -- each handler names
the roles it accepts.

**Why admin tokens cannot be confused with user tokens.** Admin tokens are
HS256, signed with a secret this backend owns; WAWU ID tokens are RS256,
verified against WAWU ID's JWKS. Each verifier pins its own algorithm, so
neither token can satisfy the other regardless of the claims it carries. That
is deliberate rather than decorative: the Hub enforces neither `iss` nor `aud`
on user tokens today, so a claim-based separation would be worth nothing here.
Access and refresh tokens also use separate secrets and audiences. The
verified admin lands on `req.admin`, never `req.user`, so no existing guard,
service or `@CurrentUser()` call site can observe one.
`src/admin/auth/tests/admin-auth.contract.spec.ts` asserts the rejection in
both directions, including for a WAWU ID *refresh* token.

Revocation has no session table: bump `AdminUser.tokenVersion` and every
outstanding access and refresh token for that admin stops working on the next
request.

### Ads (`/api/hub/admin/ads`, task ADS-06)

Ads are booked by the WAWU team and invoiced by hand (R-15), so these routes
are where staff create, edit, schedule, pause, resume, end and report on
sponsored cards. Same admin auth as above; reads are open to every admin role,
writes to `superadmin` and `reviewer`.

| Route | Notes |
| --- | --- |
| `GET /admin/ads` | Filters `status`, `placement`, `artwork=missing` (campaigns saved before ADS-07 with no picture, not ended, each also flagged `needsArtwork`), `phase` (`upcoming`, `running`, `over`), `from` and `to` (campaigns whose window overlaps the range); `sort` `latest` or `soonest` by window start, ties by id; `page` and `perPage` like the other admin lists. |
| `GET /admin/ads/report` | Campaigns in a range counted by status, placement and phase, how many serving would show right now per placement, and `delivery` (views, taps, skips, ctr) overall, `deliveryByStatus` and `deliveryByPlacement` for those campaigns over the range's UTC days. |
| `POST /admin/ads` | A draft with its card. Nothing is served until it is scheduled. The card needs `artworkUrl` (R-59): without it the answer is 422 "Add artwork before you save this campaign" (`reason.code` `artwork_required`). Placements: `tgif_card`, `today_slot`, `explore_slider`. |
| `GET /admin/ads/:id` | Campaign, card, its event, overlapping bookings on the placement and the whole audit history. |
| `GET /admin/ads/:id/report` | Window, how much of it has run, what was done to it, and `delivery` plus `days` (`{ day, views, taps, skips }`, oldest first, empty days omitted) over `from` and `to`; `range` echoes what they became. |
| `PATCH /admin/ads/:id` | Edit a draft or a paused campaign; the audit row records each changed field's before and after. A save that would leave the campaign with no artwork (clearing it, or a campaign saved before ADS-07 that still has none) is the same 422. |
| `DELETE /admin/ads/:id` | A draft only. Its audit rows stay. |
| `POST /admin/ads/:id/schedule`, `/pause`, `/resume`, `/end` | The state machine in `src/admin/ads/ad-campaign-state.ts`. An illegal move, or a repeat, is a 409 whose `reason` names the code and the statuses allowed. `schedule` and `resume` refuse a campaign with no artwork (R-59): the same 422 "Add artwork before you save this campaign" (`reason.code` `artwork_required`), nothing changed; `pause` and `end` are never refused for it. |

`GET /ads?placement=` serves a campaign only when it has artwork. `tgif_card` and
`today_slot` answer one card (or `data: null`); `explore_slider` (ADS-07)
answers a list of every live card for the Explore slider, heaviest first, or
`data: []`, and the app interleaves it with events. Views, taps and skips are
counted by `POST /ads/:id/events` the same way for all three.

Every change runs in one transaction that locks the campaign row, so two
requests for one campaign take turns: one outcome, one audit row
(`AdminAdAudit`), and a 409 for the loser. Serving reads `status` on every
request with no cache, so a pause is in force before its response is sent.
Nothing moves a campaign to `live` or `ended` on a timer: serving checks the
window itself. Times are UTC, written `2026-10-18T09:00:00Z`; the picture is an
`https` link the admin supplies (there is no admin upload route). Text is
checked by Unicode category and capped by `src/ads/ads-text-limits.ts`
(provisional).

**Views, taps and skips** are ADS-05's counts, read through `AdsCountsService`
(`AdminAdsModule` imports `AdsEventsModule`; nothing is recounted). Every
campaign view (list row, detail, write response, report) has
`delivery { views, taps, skips, ctr }`: `ctr` is taps over views as a fraction,
`null` when there are no views, and a campaign with nothing counted is zeros,
not an error. The list reads every row's counts in one grouped query. `from`
and `to` are UTC instants with `to` exclusive; for counts they become the UTC
days with any part inside them (the day of `from` through the day of the last
millisecond before `to`, both inclusive), so a `to` at exactly midnight leaves
that day out. On the list and the summary the same `from` and `to` also choose
which campaigns (window overlap). **For the dashboard (ADS-02):** a campaign's
page calls `GET /admin/ads/:id/report?from=&to=` and draws `delivery` and
`days`; the table calls `GET /admin/ads?...` and reads `delivery` on each row;
the overview calls `GET /admin/ads/report`. Counts survive a pause or an end.
A counted campaign cannot be deleted (end it instead).

### Plan settings (`/api/hub/admin/plan-settings`, task TIER-06)

The launch figures (tier prices and lengths, the add-5-products price, the
points cash rate, expiry and daily cap, packs, AI tool costs, the referral
ladder, the event pass lines and date, and a few figures from other rulings)
are admin settings, not code (R-65). `GET` lists every setting with its value,
its default, the screens that print it and a provisional note where the owner
did not name the figure. `PATCH` takes `{ "settings": { "<key>": <value> } }`:
a `null` puts a setting back to its default, zero and negative figures are
refused, a request is all or nothing, and each setting that changed writes one
`AdminOpsAudit` row (superadmin and finance change; support reads).

`PLANS_CONFIG` is the live plan: the defaults (`src/plans/plans.config.json`
and `src/plan-settings/plan-settings.defaults.json`) with the saved rows
(`PlanSetting`) laid over them, kept in memory. The saving process reloads at
once; another Hub process picks the change up within 15 seconds. A task that
needs a setting reads it with `PlanSettingsService.number(key)`, `.text(key)`
or `.value(key)`. 85/15 is not a setting. Dollar prices are not settings yet.

What a person is shown is what they get. A points cash-out carries the
`quoteToken` of its quote (`GET /points/convert/quote`) in the body and is paid
at that quote or not at all: a changed rate, minimum, cap or cash is `409
quote_changed` with the new quote in `reason.pointsQuote`. A tier purchase's
goods (products, bonus points, days, bump points, expiry) are the payment's
`terms`: the quote token is bound to them and the payment keeps them from the
claim, so a plan changed while a payment confirms changes nothing already
bought. The cash rate may never exceed the price per point of any way points
are sold (a pack, the checkout offer, the shortfall rate): a change that would
is a 400 naming both settings, whichever of them is changed. Saves take turns
(one advisory lock), so each audit row's old value is true.

### Environment

| Variable | Required | Notes |
| --- | --- | --- |
| `ADMIN_JWT_SECRET` | yes | HS256 secret for admin **access** tokens. Min 32 chars. Unset = every admin route 401s (fails closed). |
| `ADMIN_JWT_REFRESH_SECRET` | yes | Separate secret for admin **refresh** tokens. Never the same value. |
| `ADMIN_JWT_ACCESS_TTL` | no | Default `30m`. |
| `ADMIN_JWT_REFRESH_TTL` | no | Default `7d`. |
| `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` / `ADMIN_SEED_NAME` | seed only | Read only by `npm run admin:seed`. No defaults; password must be >= 12 chars. |

### Creating the first superadmin

```bash
ADMIN_SEED_EMAIL=ops@wawu.africa \
ADMIN_SEED_PASSWORD='<a real password>' \
ADMIN_SEED_NAME='Ada Operator' \
npm run admin:seed
```

Idempotent: an existing admin with that email is left untouched. Pass
`ADMIN_SEED_RESET_PASSWORD=true` to re-hash the password and revoke that
admin's outstanding tokens.

## Payments

### Flutterwave webhook (required — not optional)

```
POST /api/hub/webhooks/flutterwave
```

Every money flow in this backend — tips, paid content unlocks, credit packs,
creator subscriptions and upgrades, paid DMs, CAC applications, WAWUPay bills,
WAWUCare plans and both WAWU Legal payment stages — used to be confirmed
**only** by the customer's browser POSTing to a `/verify` endpoint after the
Flutterwave modal closed. Close the tab, drop off Wi-Fi, or crash on the
redirect and the customer is charged while the system grants nothing. This
endpoint is the provider-driven half of that confirmation, and it is what
stops purchases getting stranded in `pending`.

- **Auth**: no JWT and no user. The only credential is the `verif-hash`
  header, which Flutterwave sets to the *verbatim* value of the "Secret hash"
  field on the dashboard. `FlutterwaveSignatureGuard` compares it to
  `FLUTTERWAVE_SECRET_HASH` in constant time and **fails closed** — if the env
  var is unset the endpoint answers 401 rather than accepting everything.
- **Trust**: the payload is never evidence. Its `amount`, `status` and
  `currency` are logged, not believed. Settlement is delegated to the same
  `/verify` service methods the browser calls, each of which re-verifies the
  transaction against Flutterwave and compares the amount Flutterwave reports
  to the amount this server stored (`PendingCharge.expectedAmount`,
  `Purchase.amount`, `CreditPurchase.amount`, …). A ₦1 payment cannot buy an
  ₦18,999 tier through this door either.
- **Exactly-once**: `PaymentWebhookReceipt.deliveryKey` (`<event>:<tx_ref>`) is
  unique, and the insert is the claim — a duplicate delivery loses it and
  never reaches settlement. The webhook racing the browser's `/verify` is
  caught one layer down, by conditional writes in each settle path.
- **Status codes are the retry contract**: `200` handled (settled, refused,
  duplicate, unmatched or ignored — do not redeliver); `401` signature missing
  or wrong (never processed); `5xx` we could not finish, please redeliver.

### Deploy checklist

1. Set `FLUTTERWAVE_SECRET_KEY` to a real key. The app **refuses to boot** in
   production without one, because the mock adapter approves every charge for
   free (`src/common/flutterwave/require-payment-config.ts`).
2. Set `FLUTTERWAVE_SECRET_HASH` to a strong random value.
3. In the Flutterwave dashboard → **Settings → Webhooks**, paste the *same*
   value into "Secret hash" and set the webhook URL to
   `https://<host>/api/hub/webhooks/flutterwave`. Skipping this leaves the
   backend dependent on the browser again — silently.
4. Confirm the URL is reachable without auth from outside your VPC and is not
   behind the JWT-protected path or a WAF rule that strips `verif-hash`.
5. Run `npx prisma migrate deploy` so `PaymentWebhookReceipt` exists.
6. `PaymentWebhookReceipt` is the operator's audit trail: rows with status
   `unmatched`, `rejected` or `failed` are the reconciliation queue. It is
   readable at `GET /api/hub/admin/payments/receipts?status=unresolved`
   (superadmin/finance), and a stuck charge is re-run through the REAL
   verification path with
   `POST /api/hub/admin/payments/receipts/:id/reverify`. There is deliberately
   no "mark as paid": settlement always re-asks Flutterwave and compares the
   answer against `PendingCharge.expectedAmount`.
7. Other required env vars: `DATABASE_URL`, `HUB_API_PORT`, `CORS_ORIGIN`
   (mandatory in production), `WAWU_ID_JWKS_URL`, `WAWU_ID_BASE_URL`,
   `WAWU_ID_INTERNAL_SERVICE_KEY`, `FLUTTERWAVE_PUBLIC_KEY`.

### Fintava webhook (MONEY-07)

```
POST /api/hub/webhooks/fintava
```

Fintava (the naira wallets, beside Flutterwave, which is unchanged) posts
here when money arrives or a transfer settles or is reversed. OPS-10
registers `https://<host>/api/hub/webhooks/fintava` in Fintava's live
dashboard and puts the dashboard's webhook secret in
`FINTAVA_WEBHOOK_SECRET`.

- **Auth**: no JWT. `FintavaSignatureGuard` checks `x-fintava-signature`,
  the HMAC-SHA512 of the raw body under `FINTAVA_WEBHOOK_SECRET`, in
  constant time, and fails closed (401) when the secret is unset. The raw
  bytes exist because the app is created with `rawBody: true`
  (`src/hub-app-options.ts`).
- **Exactly once**: Fintava sends no event id and no timestamp, so each
  delivery is stored in `FintavaWebhookEvent` under the unique key
  `bodySha256`, the SHA-256 of the exact bytes it signed (MONEY-08 round 3),
  with an `ON CONFLICT DO NOTHING` insert. A retry, a replay or two copies at
  once leave one row and answer `duplicate`.
- **Not kept for ever** (FIX-20): a daily job clears the raw body and the
  parsed copy of a finished delivery after `WEBHOOK_RETENTION_DAYS` (90 by
  default; `.env.example`). The row stays with its hash, so a delivery sent
  again after clearing is still a `duplicate`. A pending, failed or
  unrecognised delivery keeps its body. Nuvion's `NuvionWebhookEvent` follows
  the same rule. See `docs/contract/CONVENTIONS.md`, section 21.
- **Records only**: no money moves and no balance changes here. Rows are
  `pending` for the ledger (MONEY-10) and the pending sweep (MONEY-08);
  an event nobody documents is `unrecognised`.
- **Status codes**: `200` recorded or duplicate; `400` no JSON body; `401`
  signature missing or wrong, or no secret; `503` not stored, resend.
- Run `npx prisma migrate deploy` so `FintavaWebhookEvent` exists.

### The nightly check against the wallet provider (MONEY-16)

Once a night (`MONEY_CHECK_TIME`, Lagos, default 02:30) the Hub compares its
ledger with the wallet provider's own record: every wallet's debits and
balance, WAWU's own account, the money held for payers and payees, and WAWU's
charge on each send. It lists what a person has to look at (a payment or a
hold in review, money owed to a deleted payee) and has the report emailed
through WAWU ID to the accounts in `MONEY_CHECK_RECIPIENT_WAWU_IDS`. It only
reads and reports. No route; the cron runs where `ScheduleModule.forRoot()` is
loaded, and a run is claimed in the database (`MoneyCheckRun`), so any number
of Hub processes make one run a night.

- **By hand**: `npm run build`, then `npm run money:check` with the Hub's
  environment (`-- --night=YYYY-MM-DD`, `-- --again`). It prints one line and
  exits 0 when the run finished (or had), 2 otherwise.
- **Reading a night**: `MoneyCheckRun.report` (kobo as text, references only).
  The verdict is `clean` only when every comparison was made and nothing was
  found. What the provider's adapter cannot answer is `not_checked`, never clean.
- **On Nuvion** (FIX-67): a statement line states which way it went, so credits are
  compared with the ledger's `in` rows and debits with its `out` rows; WAWU's fee,
  which Nuvion moves as a transfer of its own (`<send>-fee`), is matched to its send;
  and WAWU's account is compared with its ledger from the opening balance the
  provider's statement states.
- The settings are in `.env.example`; what it does and does not compare is in
  `docs/contract/CONVENTIONS.md` section 19.
- Run `npx prisma migrate deploy` so `MoneyCheckRun` exists.

## Buying through the app stores (IAP-01, R-86)

Points packs, WAWU Credits packs, tiers (ticks) and community passes are bought in the
app with Google Play Billing and Apple In-App Purchase. The wallet routes for the same
things are unchanged and stay for the website.

| Route | What |
|---|---|
| `GET /store/products?platform=android\|ios` | the products on sale in one store, from the admin-edited product map (no price: the app shows the store's own), and the signed-in person's `accountToken` |
| `POST /store/purchases` | `{ platform, productId, purchaseToken \| transactionId, communityId? }`: the Hub asks the store's own server, then grants once per store transaction |
| `POST /webhooks/google-play` | Pub/Sub push, the bearer token is checked (Google-signed, this endpoint's audience, the subscription's service account) |
| `POST /webhooks/app-store` | App Store Server Notifications V2, the signed payload and its certificate chain checked against `APPLE_ROOT_CERTIFICATES` |
| `admin/store/products`, `platforms`, `purchases`, `refunds` | superadmin and finance |

Nothing is asked of a store until its settings exist; every store route then answers
`store_not_configured` (503). Settings (none are committed):

| Setting | For |
|---|---|
| `GOOGLE_PLAY_PACKAGE_NAME`, `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` (the JSON, or that JSON in base64) | Google Play: asking about a purchase, consuming and acknowledging |
| `GOOGLE_PLAY_PUBSUB_AUDIENCE`, `GOOGLE_PLAY_PUBSUB_SERVICE_ACCOUNT_EMAIL` | Google Play notifications: the push endpoint's URL and the push subscription's service account |
| `APPLE_BUNDLE_ID`, `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (the `.p8` text), `APPLE_ENVIRONMENT` (`Production` or `Sandbox`), `APPLE_ROOT_CERTIFICATES` (Apple's root certificates, PEM), `APPLE_APP_ID` (the app's Apple id, needed in Production) | App Store |
| `STORE_FEE_BPS_ANDROID`, `STORE_FEE_BPS_IOS` | the store's cut in basis points, 1500 (15%) when unset; an admin can override it per store |

A purchase is bound to the person who made it. Each person has one stable random
`accountToken` (a UUID the Hub makes, never their user id), answered by `GET /store/products`.
The app hands it to Google Play Billing as `obfuscatedAccountIdAndroid` and to StoreKit as
`appAccountToken` when it starts a purchase; the store returns it on every answer about that
purchase, and the Hub refuses (`store_purchase_taken`, 409) a purchase that carries another
person's token. A purchase that carries none is refused (`store_account_token_missing`, 422):
always for a tier (the one subscription), and for anything bought once (a pack, a pass) on or
after `STORE_ACCOUNT_TOKEN_REQUIRED_FROM` (an ISO date, 25 Oct 2026 when unset); a purchase
before that date may carry none. A tier also belongs to whoever bought it first, whatever the
order id (`StoreSubscription`, unique per platform and Google purchase token or Apple
`originalTransactionId`), and the stores' notices follow that holder.

The grant is the wallet paths' own code (`PointsService.grant`, `TierGrantService`,
`addCreditsWithLot`, `grantPassPeriod`), run in one short transaction keyed by
`(platform, storeTransactionId)`. A refund or revocation takes back what is unspent. The
creator's 85/15 on credits and passes is worked on WAWU's net after the store's share.

The upload pack, "Add 5 more products" (IAP-03, R-65), is the fifth product kind,
`extra_products`: a pack bought and consumed like points and credits, with
`grants: { extraProducts: n }` (the plan's count, 5, when the admin sends none; stored as
a number). One purchase adds `n` to the person's tier row (`MakerTier.extraProducts`) and
writes a `MakerExtraProducts` row keyed `store:<purchase id>`, as the wallet's
`extra_products` payment does; a refund or revocation takes them back, never below none.
A tier that has ended still takes the pack (the store has been paid; it counts again with
the next tier). A person who has never held a tier is refused before the store is asked
(`store_purchase_invalid`, 422). `grants.extraProducts` is present on this kind only.

A community pass is a ONE-TIME 30-day purchase for one room, not a subscription (IAP-03
round 2, Default (lead), owner may override): Google and Apple let an account hold a given
subscription product only once, so one subscription per price point could not cover two rooms.
The store type is a Google Play consumable in-app product and an App Store non-renewing
subscription, one product per price point (suggested ids `wawu.pass.30.a`, `wawu.pass.30.b`,
and so on, each with its `referenceKobo` in `admin/store/products` and `grants: { days: 30 }`).
Each verified purchase grants its days to the room named in it, stacking from the later of now
and the room's current end (`grantPassPeriod`); the host is credited per purchase (85% of the
net); renewing is buying again; a refund or revocation takes back that purchase's period and
its host credit. The store transaction is bound to the person AND the room it first granted:
the same person naming another room for it is refused (`store_purchase_other_room`, 409), and
the pass reminder (3 days before the end) reaches store passes too. `GET /communities/{id}/pass`
no longer answers `cancelInStore` (nothing renews).

## Verification: two ticks, not a ladder

There is no five-rung ladder any more. There are exactly **two** verifications,
they are **independent** of each other, and neither outranks the other, because
one person may hold more than one role.

| Verification | Price | Tick | What it unlocks |
| --- | --- | --- | --- |
| Creator | NGN 4,999 / year | purple | the tick everywhere; hosting events |
| Professional | NGN 9,999 / year | green | the tick everywhere; hosting events |

Both are annual, both are paid, and both are server-authoritative.

### The wire shape

Every place a user appears on the wire carries the same object: the public
profile, creator discovery, professional listings, search hits, comment
authors, DM counterparties, community message senders and an event's host.

```ts
interface TickState { verified: boolean; expiresAt: string | null }
interface VerificationState { creator: TickState; professional: TickState }
```

`verified` is computed **server-side** from the expiry. A client never compares
dates to decide whether to draw a tick. `expiresAt === null` with
`verified === true` is a perpetual, admin-granted tick (the accounts
grandfathered off the old ladder); `expiresAt === null` with
`verified === false` simply means never verified. Both ticks render when both
are held, and nothing anywhere picks a winner.

### Where it is decided

One function: `deriveVerificationState()` in
`src/common/verification/verification-state.ts`. Every read path calls it,
through `VerificationStateService` for the batched reads. Nothing compares the
stored dates anywhere else.

### Storage, and who owns the truth

**WAWU ID owns it.** Every grant and every revoke PATCHes
`/internal/users/:userId/verification` there FIRST, then mirrors onto four
nullable columns on this backend's `UserProfile`
(`creator_verified_at`, `creator_verified_until`, `professional_verified_at`,
`professional_verified_until`). If identity rejects the call nothing has been
granted here and the payment is simply re-verifiable.

The mirror exists so a page of creator cards renders its ticks from one query.
`WawuIdClient.lookupPublicIdentities` deliberately degrades to an empty map
when identity is unreachable, which would otherwise strip every tick on the
page without an error.

`VerificationTier`, `VerificationSubmission.tier` and
`AdminVerificationAudit.tier` are all still there and still work. The ladder's
review queue has rows in it that predate this change, and a half-reviewed queue
that cannot be finished is worse than one write path too many. Nothing grants a
tick through them. Dropping them is a separate migration once nothing reads
them at all.

### Endpoints

| Endpoint | Auth | Notes |
| --- | --- | --- |
| `GET /api/hub/verification/pricing` | user | Both prices, in naira, by the year. |
| `GET /api/hub/verification/me` | user | The caller's ticks, the prices, and which they may buy. |
| `POST /api/hub/verification/purchase` | user | `{ kind }` -> a Flutterwave inline config. |
| `POST /api/hub/verification/purchase/verify` | user | `{ transaction_id, tx_ref }` -> the granted tick. |
| `POST /api/hub/admin/verification/ticks/:wawuUserId/grant` | admin (superadmin, reviewer) | `{ kind, until? }`. Omitting `until` grants a perpetual tick. |
| `POST /api/hub/admin/verification/ticks/:wawuUserId/revoke` | admin (superadmin, reviewer) | `{ kind }`. Clears both dates. |

Payment runs through the SAME `FLUTTERWAVE_CLIENT` the content unlock uses,
exported from `ContentPieceModule`, rather than a sixth hand-copied adapter
pair. Init writes a `VerificationPurchase` row keyed by its `tx_ref`; nothing
is granted until a server-side verify has confirmed the amount and the
reference with Flutterwave.

### Prices are configured, not compiled in

`PlatformSettings.creatorVerificationPriceNgn` and
`.professionalVerificationPriceNgn`, read only by
`src/common/verification/verification-pricing.ts`, which also holds the
defaults for the case where that row does not exist yet. This is the first
reader `PlatformSettings` has ever had.

### Hosting an event is verified-only

Enforced on the write in `EventService`, on both create and edit, not by hiding
a button. A buyer can never host, because a buyer account can buy neither tick.
An unverified creator and an unverified professional cannot host either: having
the right account type is not having the tick.

The refusal is never a bare 403. `AllExceptionsFilter` carries a `reason`
object through to the caller when a thrower attaches one:

```json
{
  "statusCode": 403,
  "message": "Only verified accounts can host an event. ...",
  "data": null,
  "reason": {
    "code": "verification_required",
    "message": "...",
    "steps": ["...", "...", "..."],
    "purchasable": [
      { "kind": "creator", "priceNgn": 4999, "currency": "NGN", "termMonths": 12 }
    ]
  }
}
```

`code` is what the client branches on; `message` and `steps` are read by a
person, so the app can render "here is what you need to do" instead of a wall.
An exception without a `reason` produces exactly the envelope this filter has
always produced.

## Phone push (INBOX-03)

`POST` and `DELETE /api/hub/push-tokens` register a phone; a sender behind
`NotificationService` pushes each notification the service wrote, through Expo,
when the person's Z3 switch allows. Routes, payload, the per-kind decisions and
how two instances stay safe are in [`docs/contract/PUSH.md`](docs/contract/PUSH.md).

It is **off unless `PUSH_ENABLED=true`**. `EXPO_ACCESS_TOKEN` (only for an Expo
project with enhanced push security) and `EXPO_PUSH_BASE_URL` (default
`https://exp.host`) are optional; both are listed in `deploy/README.md` and
`.env.example`. Android needs the owner's FCM credentials uploaded to Expo.

## Money in (WALLET-10, WALLET-39)

Every credit to a person's wallet is a completed `in` row in the ledger
(`src/money/ledger/`) of one of four categories: a bank transfer in (`top_up`;
Fintava's `account_funded` through the ledger sweep, Nuvion's
`inflows.completed` through NUV-04's handler), money from another person
(`transfer`), earnings landing (`earning`: WALLET-16's settlement, a released
hold, a points cash-out) and a refund (`refund`). A sweep in every Hub
(`src/money/money-in-notice/`, every 10 seconds) turns each such row into one
`money_in` notification ("You received ₦5,000 from Tolu B.", "in earnings", "a
refund of ...", "by bank transfer"), which the push sender above then sends to
the person's phones. It reads the ledger, never the webhook event, and never
calls the provider; a server tells only the rows of the provider it runs. A
writer of a new `in` row needs no hook: its category is in
`MONEY_IN_CATEGORIES` and its words in `money-in-sources.ts`.

The notification carries the ledger row's id as its `transaction` target (the
id `GET /money/transactions/{id}` answers), in `GET /me/notifications` and in
the push's `data`. Its text names the amount and where it came from, never a
whole account number.

Exactly once: the notification and its mark (`MoneyInNotice`, primary key the
ledger row) are written in one transaction with the row locked, so a replayed
delivery, a credit delivered twice or out of order, two Hubs and a stop
between the row and the push all end in one notification. With the person's
"Money in" switch (Z3) off, only the mark is written (`muted`): nothing is
sent and nothing waits. `MONEY_IN_NOTICE_WINDOW_HOURS` (default 72, in
`.env.example`) bounds how far back a pass reads.

A credit that was told and is then reversed in the ledger (`reversed`) is
followed by one `money_in_reversed` notification ("The ₦5,000 you received
from Tolu B. was reversed."), written with the mark's `correctedAt` in one
transaction, up to 30 days after the credit. A credit nobody was told about
(`muted`, `before`) is not corrected. The list always carries the correction;
"Money in" off silences only its push.

## Blocking and data export (SETTINGS-04)

**A block hides people from each other, both ways.** `BlockedAccountService`
is the one place that knows: `hiddenFrom(viewer)` is every account the viewer
blocked or who blocked the viewer (empty for a signed-out reader), and
`assertVisible(viewer, owner, notFound)` answers a hidden owner's profile,
piece, room or event with the same 404 an unknown id gets, so the answer never
says who blocked whom. It is applied to search (content, creators,
suggestions, closest), Explore, the public profile and a creator's shelf, the
feed (ranked and newest first), a single piece, comments, rooms and their
messages, the professionals directory, events and the EVG score. Someone who
already bought a piece keeps it, and someone already in a room keeps the room.
The wallet recipient search (WALLET-08) filters with `hiddenFrom`. Chat
enforces it in its own service (INBOX-06). A signed-out reader sees everyone.

**Data export.** `POST /settings/privacy/export` records a request (asking
again while one is pending returns that one). `DataExportFulfilmentService`
sweeps pending requests every minute and asks WAWU ID to email a signed link
(`POST /internal/users/:id/data-export`, built in wawu-id by FIX-53; the mock in
`mock-wawu-id` records it in `GET /internal/mail-outbox`). `GET /settings/privacy/export/download?token=`
builds the file when the link is opened, from `data-export-sections.ts`: every
section names its fields, nothing is exported by default, and
`data-export-map.spec.ts` fails when a table the account purge deletes is in
neither the export nor the excluded list. The link expires after 72 hours
(`EXPORT_LINK_HOURS`), is signed with a key derived from `ADMIN_JWT_SECRET`,
and stops working when the request row is deleted with the account. Set
`HUB_PUBLIC_URL` (`.env.example`) for the address inside the link.

## `WAWU_ADMIN_KEY` is retired

It used to gate six operator surfaces — `legal/ops`, `services/ops/applications`,
`bills/ops`, `care/ops`, `PATCH /learn/playbook` and the `learn/guides` writes —
as a single shared static secret with no identity and no role model. All six now
sit behind `AdminAuthGuard` + `AdminRolesGuard` (`src/admin/auth/`), so every
operator action names a real admin and every handler declares which roles may
reach it. Setting `WAWU_ADMIN_KEY` grants access to nothing; `AdminKeyGuard` is
kept only because WAWUAfrica-Dashboard's `scripts/generate-ops-contract.mjs`
parses the file. Configure `ADMIN_JWT_SECRET` / `ADMIN_JWT_REFRESH_SECRET`
instead (see `.env.example`) and create the first admin with `npm run admin:seed`.

**Callers must send the admin's own bearer token.** WAWUAfrica-Dashboard's
`src/app/api/ops/[key]/route.ts` already verifies the caller's admin session
against `GET /api/hub/admin/auth/me` and then swaps in the shared key on the
upstream hop; it needs to forward that same `Authorization` header instead.

---

<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="120" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg" alt="Donate us"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow" alt="Follow us on Twitter"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Project setup

```bash
$ npm install
```

## Compile and run the project

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Run tests

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```

## Deployment

When you're ready to deploy your NestJS application to production, there are some key steps you can take to ensure it runs as efficiently as possible. Check out the [deployment documentation](https://docs.nestjs.com/deployment) for more information.

If you are looking for a cloud-based platform to deploy your NestJS application, check out [Mau](https://mau.nestjs.com), our official platform for deploying NestJS applications on AWS. Mau makes deployment straightforward and fast, requiring just a few simple steps:

```bash
$ npm install -g @nestjs/mau
$ mau deploy
```

With Mau, you can deploy your application in just a few clicks, allowing you to focus on building features rather than managing infrastructure.

## Resources

Check out a few resources that may come in handy when working with NestJS:

- Visit the [NestJS Documentation](https://docs.nestjs.com) to learn more about the framework.
- For questions and support, please visit our [Discord channel](https://discord.gg/G7Qnnhy).
- To dive deeper and get more hands-on experience, check out our official video [courses](https://courses.nestjs.com/).
- Deploy your application to AWS with the help of [NestJS Mau](https://mau.nestjs.com) in just a few clicks.
- Visualize your application graph and interact with the NestJS application in real-time using [NestJS Devtools](https://devtools.nestjs.com).
- Need help with your project (part-time to full-time)? Check out our official [enterprise support](https://enterprise.nestjs.com).
- To stay in the loop and get updates, follow us on [X](https://x.com/nestframework) and [LinkedIn](https://linkedin.com/company/nestjs).
- Looking for a job, or have a job to offer? Check out our official [Jobs board](https://jobs.nestjs.com).

## Support

Nest is an MIT-licensed open source project. It can grow thanks to the sponsors and support by the amazing backers. If you'd like to join them, please [read more here](https://docs.nestjs.com/support).

## Stay in touch

- Author - [Kamil Myśliwiec](https://twitter.com/kammysliwiec)
- Website - [https://nestjs.com](https://nestjs.com/)
- Twitter - [@nestframework](https://twitter.com/nestframework)

## License

Nest is [MIT licensed](https://github.com/nestjs/nest/blob/master/LICENSE).
