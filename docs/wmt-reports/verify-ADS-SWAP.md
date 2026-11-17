VERDICT: merge

# ADS-SWAP verification (checker report)

Tested `origin/wmt/ADS-SWAP` at e7bd4e01 (merge-base with origin/main is c3fd797, confirmed). Built with `npm run build`, ran the built `node dist/scripts/ops/ads-swap-1116.js` against a local stack (`scripts/dev/stack.sh up --name adsv`, real Postgres, `scripts/dev/storage-standin.cjs`). No live provider, no `.env`, no key file opened. Adverts were seeded through the real admin routes over HTTP (create, schedule, pause, end, a draft). Attack scripts are not committed.

Short version: the data written is right (field for field what the routes write), the app serves it right, rollbacks and quoting hold. One real gap: the confirmation phrase does not bind what the new adverts copy (link, end, weight) and does not notice pause, resume or an edit in between. The brief asked for those to be refused. That is a medium, so: fix.

## Findings

### M1 (medium). The phrase ignores pause, resume and edits; the copied link, end and weight can differ from what the lead read in the dry run

Steps (stack, one live advert weight 5 link `https://example.com/live2`, one paused, one scheduled):
1. Dry run. It prints `will take: link https://example.com/live2; ... weight 5 ... (copied from campaign <live>)` and phrase `SWAP ADS: END 3 CAMPAIGNS 0dc0b882`.
2. By the admin routes: `POST /admin/ads/<live>/pause`, `PATCH /admin/ads/<live> {weight:8, creative:{ctaUrl:"https://example.com/CHANGED"}}` (200), `POST .../resume`.
3. `--apply --confirm "SWAP ADS: END 3 CAMPAIGNS 0dc0b882"` is accepted. It prints `will take: link https://example.com/CHANGED; ... weight 8` and ends 3, creates 3. The three new adverts have weight 8 and the changed link.

Cause: `phraseFor` hashes only the sorted campaign ids (`scripts/ops/ads-swap-1116.ts:137`). Pause and resume do not change the id set; an edit does not either. `taken` (link, end, weight, source) is computed from the read made before the transaction and is not part of the phrase and not re-read in it.
Brief item 3 says a phrase from an older dry run after an advert was booked, ended, paused or resumed in between must be refused. Booked and ended are refused (below); paused/resumed and edited are not.
Fix direction: put status, weight, endsAt, ctaUrl of every current advert (and the chosen source) into the hashed text, and compute `taken` again inside the transaction after the lock and compare.

### L1 (low). The source of link, end and weight can be a paused advert, and there is no `--weight`

Seeded: live advert weight 5, paused advert weight 9 (end 20 days out), scheduled weight 2. Dry run: `will take: link https://example.com/paused2; end <paused's end>; weight 9; (copied from campaign <the paused one>)`. A paused advert beats the live one, as the builder disclosed. The dry run names the campaign and lists its status on the line above, so the lead can see it, and `--link` and `--ends` override two of three. Weight cannot be overridden. Suggest: say "(paused)" in the "copied from" line, add `--weight`, or skip paused when a live source exists.

### L2 (low). A second run is not always "does nothing"

With the three present, a newer advert booked after (weight 7) is current; the dry run says `Will end: 1` with a fresh phrase, and an apply with that phrase would end it. That needs a new dry run and its phrase, so it is deliberate, but the owner's order "a second run does nothing" holds only when nothing else is current. The old phrase no longer matches, so a re-triggered workflow with the old phrase is refused. Worth one line in the owner's runbook.

### L3 (low). A refused or lost race leaves three orphan pictures in the bucket

Two applies at the same moment: one swapped, the other printed `REFUSED: the current campaigns changed...` (exit 1) after uploading its 3 pictures (storage keys 55 -> 55+3 after the pair). Database untouched. The command says so and calls them harmless; they are, but the brief's "nothing uploaded" holds only for the refusals made before the upload (wrong, stale, spaced or wrong-case phrase: no upload, keys unchanged).

### L4 (low). Failure text is raw Prisma text, cut at 200 characters

A forced failure on the third insert prints `Invalid \`tx.adCampaign.create()\` invocation in /home/user/.../dist/scripts/ops/ads-swap-1116.js:294:53 ... . The transaction was rolled back; nothing was changed.` Exit 2, rollback correct. No secret printed, but the line is cut mid-code and shows a server path.

### L5 (low). The builder's spec is not safe on a shared dirty database

`npm run test:contract -- src/admin/ads/tests/ads-swap-1116` failed once on my stack (`Served now in explore_slider: 3` expected, got 4) because my own live adverts were in the database; the command's read-back counts every served advert while the spec scopes the command to its own ids with `onlyIds`. After ending my leftovers it passed 7 of 7. Fine in CI on a fresh database; the spec's last assertion is brittle.

## What held (with numbers)

1. Rows: passed.
   - End: three twins (live, paused, scheduled) ended by `POST /admin/ads/:id/end`, compared with the three ended by the command. Campaign columns (all but id and times) equal; creative rows equal on every column but ids and times; `AdminAdAudit` `ended` rows equal on every column but id, seq, time and the admin snapshot (`action ended`, `previousStatus`, `newStatus ended`, `changes {status:{from,to}}`).
   - New: three route twins made with "create then schedule" with the same values. Campaign and creative columns equal (placement `explore_slider`, status `live`, `ctaDestination link`, `ctaLabel Register now`, `artworkUrl`/`artworkPortraitUrl` null, landscape address in the same bare shape). `created` and `scheduled` audit rows equal except the picture id, the milliseconds of `startsAt` (the command keeps ms, my twin was cut to seconds) and the admin snapshot (`ops:ads-swap-1116`, `ops-command@wawu.invalid`, `superadmin`). All CHECKs hold (inserts succeeded). createdAt +0/+1/+2 ms gives the order.
   - Draft and ended rows: 24 rows (campaign, creative, audit) dumped before and after, byte-identical. `AdEvent` rows identical. Per-table row count and md5 of all 258 tables before/after: only `AdCampaign` +3 (8 -> 11), `AdCreative` +3, `AdminAdAudit` +9 (21 -> 30) moved, plus `CommunityNoticeCursor`, which the running Hub's own once-a-minute job advances (checked: it moved with no command running). The apply took 1.1 s.
2. App: passed. `GET /ads?placement=explore_slider` gave Drive., 5 DJI Osmo Pocket 3., 4 Gaming Systems. in that order; `today_slot` gave Drive.; `tgif_card` gave `data: []`. Each card: `ctaLabel` Register now, `ctaDestination link`, `ctaUrl` the copied link, picture fetched (200, image/png) with sha256 equal to the file in `scripts/ops/ads-1116/` (266230, 175401, 223600 bytes). `POST /ads/:id/events` with `view` and `tap` on each of the three: 200 `accepted:true`, rows counted.
3. Phrase and race:
   - Wrong, trailing space, leading space, other case, doubled space, `nope`: all REFUSED, exit 1, snapshots identical, storage keys unchanged (9 -> 9).
   - Advert booked after the dry run: refused, nothing uploaded (25 -> 25 keys). An advert ended by route after the dry run: refused. (Paused/resumed/edited: not refused, see M1.)
   - Two applies at once: one exit 0 (three adverts, 3 live), the other exit 1; exactly 3 new adverts, 3 `created` audit rows for the first.
   - Admin routes racing: a loop of create/schedule/end (60 rounds) run during the apply. Route latency max 76 ms, no 5xx, no deadlock, no lock wait over 100 ms in the Postgres log (`log_lock_waits` on, `deadlock_timeout` 100 ms). Lock hold measured from the server log: `LOCK TABLE` 00:04:58.472 to `COMMIT` .531 = **59 ms** on a successful apply; 5 ms on a refused one. Under a booker that never stops the apply keeps refusing (nothing swapped, safe; the lead re-runs when it is quiet). No advert the owner asked to end was left on air in any run.
4. Failure: third insert made to fail (a test trigger on the third advertiser): exit 2, all tables identical, old three still live. Connection killed with `pg_terminate_backend` during the creative insert: exit 2, identical, old adverts live. Storage proxy that fails every PUT after the first: exit 2, `The database was not touched`, tables identical (one orphan picture).
5. Link, end, weight: `--link` with `http://`, `127.0.0.1`, `10.0.0.5`, `localhost`, `user:pw@`, a space, `javascript:`: each `CANNOT APPLY` on the dry run and `REFUSED` exit 1 on apply, one message. `checkCtaUrl` (`src/admin/ads/ad-text.ts:242`) is the function the admin DTO decorator `IsCtaUrl` calls (`ad-field-decorators.ts:89,99,102`) and the command imports it, so the rule is the same code, not a copy. `--ends` in the past, `2026-12-31 23:59:59`, no Z, `2026-02-30T00:00:00Z`, empty: refused. `--ends 2099-12-31T23:59:59Z`: accepted, same as `POST /admin/ads` (it accepts 2099 too; no cap in either). No link advert and no `--link`: refused with both reasons (also for nothing current at all). `--link` given, no end source: refused for the end. With no source the weight falls to 1 silently (printed in the dry run).
6. Second run and half states: three exist, nothing else current: `Nothing to do`, exit 0, tables identical. One of three missing: `REFUSED: only 2 of the three...` exit 1. Two missing: `only 1`. Same refusal with `--apply` and any phrase. Three exist plus a newer advert: see L2.
7. Process: the command boots `OpsModule` = ConfigModule, PrismaModule, StorageModule. I walked the module graph: StorageModule, PlansModule, PointsModule, WawuAuthModule, ConfigModule, PassportModule, PlanSettingsModule, IdentityPauseModule, WalletProviderModule, FintavaModule, NuvionModule, PrismaModule (12). **`ScheduleModule` is not in it**, so every `@Cron`/`@Interval` in them (storage sweep every 10 min, nuvion dispatch 30 s and reconcile 1 min, points expiry/hold-sweep/cash-out, wallet-opening, plan-transfer) is inert here. `onModuleInit` there: PrismaService connects; PlanSettingsService does one DB read and an unref'd refresh timer cleared on close; the rest (PlanPurchase, ExtraProducts, PointsPack, PointsShortfall, PointsCashOut, Nuvion add-money handler) only register handlers in memory. No listener (`createApplicationContext`). Hub stopped, then a dry run: `pg` log shows only SELECT/BEGIN/COMMIT (no write statement), all tables identical, exit 0 in 1.1 s by itself, empty stderr. Exit codes: 0 done or nothing to do, 1 every refusal and bad flag, 2 failure. Output greps clean for URLs with keys, `X-Amz`, emails, `+234`, secrets; it prints campaign ids and the public link. Not proved: that a production `/etc/wawu/hub-api.env` boots Fintava/Nuvion modules without a missing key; the stack has stand-in values.
8. Workflow: `workflow_dispatch` only, `apply` default false, no push/schedule trigger. The "Load SSH key" step is identical to `resign-content-urls.yml` (diff empty); same secrets (`DROPLET_SSH_KEY`, `DROPLET_HOST_KEY`, `DROPLET_HOST`). I ran the real run block with `ssh` replaced by `bash -c` and `node` by an argv printer, with confirm/link/ends holding spaces, `'`, `"`, `$(touch /tmp/pwned)`, backticks, `;`, `&&`, a newline, a leading `-`, and `--apply`: every value arrived as one argument, `/tmp/pwned` never created. `apply=false` with confirm or link `--apply`: the command exits 1 with the usage line (a value starting `--` is refused), nothing applied; `--confirm=x` refused as unknown; a confirm holding a newline plus `--apply` is one argument, dry run, exit 0, 116 ended rows before and after. (A trailing newline in a value is dropped by `$(...)`; harmless.)
9. Shipping: `deploy.yml` rsync excludes only `.git`, `node_modules`, `dist`, `dist-seed`, `generated`, `mock-wawu-id/node_modules`, `.env`, so `scripts/ops/ads-1116/*.png` (tracked, not git-ignored) go to `/srv/wawu/hub-api`; `deploy.sh` runs `npm run build` (`nest build`), which produced `dist/scripts/ops/ads-swap-1116.js` here. `process.cwd()` is the picture root; the workflow `cd`s to `/srv/wawu/hub-api`. Run from `/tmp` or from `dist/`: `REFUSED: the picture scripts/ops/ads-1116/1-drive-car.png is missing under /tmp. Run this from the repo root (the deploy puts it at /srv/wawu/hub-api).` exit 1. `python3 scripts/ci/check_deploy_in_sync.py`: IN-SYNC OK. Not run: a deploy.
10. Nothing else moved: `git diff c3fd797 origin/wmt/ADS-SWAP --stat` = the 8 files listed in the brief (workflow, builder report, 3 PNG, script, `admin-ads.service.ts` 2 lines, spec). The service diff is only the two `export` words. `npx tsc --noEmit`: clean (needs more heap than the default on this box). `ads-swap-1116.contract` 7/7 (on a clean database, see L5); `admin-ads.contract` 208/208. `python3 scripts/gates/run.py`: 0 fail, 144 warn, 88 accepted, PASSED; `check_baseline.py`: ok (125 entries). Protected-routes suite: 236/244 here, the same 8 failing on origin/main (end of this file).

## Could not prove

- The real Fintava/Nuvion-free production boot of `OpsModule` with `/etc/wawu/hub-api.env`, and real object storage (signed address shape, `STORAGE_*`). Only the stand-in.
- How the admin dashboard shows audit rows whose `adminId` matches no admin (code reads the snapshot columns; I did not open the dashboard).
- The GitHub-hosted run itself (not triggered, as ordered); the quoting was tested with a local stand-in for ssh.
- The new picture addresses on production: the app is given a signed address as for every advert; checked only against the stand-in.

## Protected routes

`scripts/protected-routes/run.sh --fresh origin/wmt/ADS-SWAP` on a fresh database: 236 of 244 required tests passed, 8 failed (`GET /professionals/:id`, `PATCH /professionals/applications/:id/listing`, `POST /admin/professionals/:id/approve`, `POST /admin/professionals/:id/unlist`, `POST /admin/verification/:id/approve`, `POST /admin/verification/ticks/:wawuUserId/grant`, `.../revoke`, `POST /verification/purchase/verify`). The same run against `origin/main` (c3fd797 lineage) fails the identical 8 with the identical 236/244, so they come from this sandbox (the mock WAWU ID or seed) and not from this branch; none is an ads route. No ads route is in the protected list's failures. I could not make those 8 pass here, so I cannot say they are green on a CI machine.

---

# Re-check of fix round 1 (`wmt/ADS-SWAP` at 9f7c19ff)

First line is now `VERDICT: merge`; the first-round text above is kept as history (M1 and L1 to L5 below say where each stands). Built 9f7c19ff, ran the built `node dist/scripts/ops/ads-swap-1116.js` on a rebuilt local stack (real Postgres, storage stand-in), adverts seeded and attacked through the admin routes. `git diff e7bd4e01 9f7c19ff --stat` = the command, the spec and the builder report only; the workflow and the two `export` words are untouched.

## M1: closed, with one exception (new L6)

With a dry run's phrase in hand, then one change, then `--apply --confirm <that phrase>`: each REFUSED (exit 1), nothing written (table checksums taken after the change and after the apply identical):

| In between | Result |
| --- | --- |
| pause | refused |
| pause, PATCH weight 8 and link, resume (my first-round attack) | refused |
| PATCH weight (paused advert) | refused |
| PATCH link | refused |
| PATCH end date | refused |
| PATCH start date | refused |
| a new booking (create + schedule) | refused, no upload (storage keys unchanged) |
| end by route | refused |
| same phrase, different `--link` / `--ends` / `--weight` than the dry run | refused (3 runs) |
| **pause, then resume, nothing else** | **not refused: applied** (see L6) |

Recomputed inside the transaction: read the code (`takeFrom(again, opts, nowTx)` and `phraseFor(again, takenNow)` after `LOCK TABLE` and `FOR UPDATE`) and proved it. A second session held `LOCK TABLE "AdCampaign" IN ROW EXCLUSIVE MODE`, so the command passed its first read and its 3 uploads and waited at its own lock; the second session then set the source advert's weight to 42 and committed. The command got the lock, re-read, and printed `REFUSED: what the dry run showed has changed...`, exit 1, only the holder's own UPDATE changed the table, no new advert.

Nothing changed in between: the apply works. Exit 0, `AdCampaign` +3, `AdCreative` +3, `AdminAdAudit` +9, three adverts live weight 5, same end, `explore_slider`. Served order over HTTP as before: Explore Drive., 5 DJI Osmo Pocket 3., 4 Gaming Systems.; Today 1 (Drive.); TGIF `[]`; each picture sha256 equal to the file (266230, 175401, 223600 bytes); `view` and `tap` accepted on each. Read-back lines: `Served now in explore_slider: 3`, today 3, tgif 0. Second run: `Nothing to do`, exit 0, no change. Two applies at once: exactly one swap (`AdCampaign` +3, `AdminAdAudit` +9 once); the other printed `Nothing to do` (it read after the winner committed); the earlier simultaneous race (first round) refused the loser, which still holds by the in-transaction check above.

### L6 (low, new): pause then resume is not refused

The phrase hashes id, status, weight, window, place, tap and link. Pause followed by resume returns every one of those to what the dry run showed, so the phrase matches and the apply goes through. Result is exactly what the dry run promised (same source, link, end, weight), so nothing wrong is written; but you listed it as must-refuse and it is not. To refuse it the phrase would also have to bind something that a pause/resume moves (`updatedAt` or the count of audit rows of each current advert). I rate it low (no wrong data) and did not hold the verdict for it; your call.

## L1: closed

- Live (on air, w5, link) beats a heavier paused one (w9): `copied from campaign <live>, which is live and on air`, weight 5.
- Only a paused advert with a link left: weight 9 taken and the line says `copied from campaign <id>, which is PAUSED (no live or scheduled advert had a link to copy)`.
- `--weight`: `0`, `101`, `1.5`, `-3`, `abc`, empty, ` 5` give `CANNOT APPLY: --weight must be a whole number from 1 to 100.`; `1`, `100` and `007` (read as 7) are accepted. Range is `AD_WEIGHT_MIN`/`AD_WEIGHT_MAX` from `ads-limits`, as the admin DTO uses.
- Note, not a finding: a `scheduled` advert whose start is still in the future is not "in its window", so it is not used as the source; with a live one absent a paused one then wins over it. The brief said "live or scheduled"; the code means on air now. Say so if you wanted future-start scheduled adverts to count.

## L4: partly closed (low, still open at boot)

The command's own failure lines are now plain and carry no path or source: third insert failed by a trigger: `FAILED: the swap could not be written (PrismaClientKnownRequestError P2039). The transaction was rolled back; nothing was changed.` exit 2; storage failing on upload 2: `FAILED: a picture could not be uploaded (S3ServiceException)...` exit 2; boot failure: `FAILED: the command could not finish (PrismaClientKnownRequestError P1001). Nothing was changed.` exit 2.
Still open: with the database unreachable at boot, `PlanSettingsService` (a module the command pulls in) prints its own Nest `WARN ... Could not reload the plan settings` with the Prisma message, which includes `/home/user/.../dist/src/plan-settings/plan-settings.service.js:129:72` and a few lines of source. Not the command's code, no secret or password in it (host and port only); it shows only when the database cannot be reached. Low.

## L5: closed

`ads-swap-1116.contract` 13 of 13 passed with three other live/paused/scheduled adverts in the database (the case that failed in round one). The read-back count is now filtered to the spec's own ids when `onlyIds` is set; the command's own run (no `onlyIds`) still counts every served advert.

## Storage that fails on purpose

Only one test does it (`a failure prints a plain sentence...`, spec lines ~503-517, which passes `storage: { putAdArtwork: () => Promise.reject(boom) }` as a dependency). Every other test takes `moduleRef.get(StorageService)` (the real service on the stand-in). The command (`main()`) takes `app.get(StorageService, { strict: false })` from the real `StorageModule`; nothing in the command file stubs or fakes it. Passed.

## Nothing else moved

`npx tsc --noEmit` clean; `ads-swap-1116.contract` 13/13; `admin-ads.contract` 208/208 on a clean database (it showed 4 failures once while my own test adverts were still on air in the shared database; that spec is untouched by the branch, and it passes once they are ended); gates `0 fail, 144 warn, 88 accepted, PASSED`; `check_baseline.py` ok (125). Protected-routes suite not re-run (no route or fenced file changed, the diff is the command, its spec and a report).

## Still not proved

Production boot with the real env file, real object storage, the dashboard's rendering of the audit marker, the hosted workflow run.

---

# Re-check of fix round 2 (`wmt/ADS-SWAP-2` at 642547f3, from main 2960831f)

First line stays `VERDICT: merge`. Built 642547f3 and ran the built command against a rebuilt local stack (real Postgres, storage stand-in), adverts seeded and attacked through the admin routes.

## 1. The live case: passed

Seeded through `POST /admin/ads` + schedule: four live adverts, `ctaDestination none`, landscape and portrait pictures, weights 40, 30, 20, 10, same window (ends 2027-01-29T05:14:58Z). Dry run: source is the weight 40 advert, `a tap does nothing (shown only); end 2027-01-29T05:14:58.000Z; weight 40; ... which is live and on air`, `Will end: 4`, no CANNOT APPLY.
Apply with its phrase: exit 0, `AdCampaign` +3 (4 -> 7 rows), `AdCreative` +3, `AdminAdAudit` +9... (4 `ended` + 6 new = 10 rows; table checksums: only those three tables moved).
- The four ended: each has one `ended` audit row `{previousStatus live, newStatus ended, changes {status:{from live, to ended}}}`; a twin made by the routes and ended by `POST /admin/ads/:id/end` equals the weight 40 one on every campaign column (ex id and times), every creative column (ex picture keys), and the `ended` audit row.
- The three new: twins made by `POST /admin/ads` with `ctaDestination: none` (landscape only) + schedule: campaign and creative columns equal (ex id, times, picture key); audit rows (`created`, `scheduled`) equal once the picture key and milliseconds are normalised; `ctaLabel`, `ctaUrl`, `ctaDestinationId` all null, `ctaDestination none`; inserts passed every CHECK.
- Over HTTP, signed-in test account: Explore `["Drive.","5 DJI Osmo Pocket 3.","4 Gaming Systems."]`, Today `["Drive."]`, TGIF `[]`; each card's keys are `id, advertiser, headline, subline, ctaDestination, artworkUrl` (no label, no link); pictures 266230, 175401, 223600 bytes, sha256 equal to the files; `view` and `tap` both answered 200 `accepted:true` and were counted (the events route has no special rule for a `none` card: it counts the tap like any other). Read-back says `no button, a tap does nothing`; `Served now`: Explore 3, Today 3, TGIF 0.

## 2. Sources: passed

- `link` source on air: `link https://example.com/live2 ... live and on air` (as before; "Register now" proved in the `--link` run below).
- `event` source (row set to `event` by SQL): dry run `a tap NOT DECIDED` + `CANNOT APPLY: the campaign to copy from opens an event, and adverts are not tied to events, so its tap is not copied. Give --link.`; `--apply` without `--link` REFUSED, exit 1, nothing changed.
- `--link https://example.com/over` over a `none` source: three `link` adverts, `Register now`, that address (checked in the rows).
- Only a paused advert: used, `which is PAUSED (no live or scheduled advert is on air)`.
- Nothing current and no `--link`: REFUSED, exit 1, both reasons (no source, no end).

## 3. The phrase binds the tap: passed

- Dry run without `--link`, apply with `--link`: refused. Dry run with `--link`, apply without: refused.
- Source changed none -> link by PATCH (pause, PATCH `ctaDestination link`, resume) between: refused.
- Round-1 attacks once each: pause, PATCH weight, PATCH end date, new booking, end by route: each REFUSED, exit 1, the apply changed no table.
- Worked out again inside the transaction: a second session held `LOCK TABLE "AdCampaign" IN ROW EXCLUSIVE MODE`, so the command passed its read and its 3 uploads and waited at its own lock; the second session then turned the `none` source into a `link` card and committed; the command got the lock, re-read, and REFUSED (`what the dry run showed has changed...`), 0 new adverts.
- Still open as in round 1 (L6, low): pause then resume with nothing else in between returns every bound value to what it was, so the phrase still matches. Not re-tested; the code binds the same fields plus the tap. Unchanged by this round.

## 4. Second run, two applies, failed insert: passed

Second run: `Nothing to do`, exit 0, with and without `--apply`. Two applies at once: exit codes 0 and 1; one swap (4 ended, 3 created, 18 audit rows over the three new ids and none doubled); the other `REFUSED`. Third insert failed by a trigger: exit 2, `FAILED: the swap could not be written (PrismaClientKnownRequestError P2039)...`, no table changed, the old adverts still live.

## 5. Nothing else moved: passed

`git diff origin/main origin/wmt/ADS-SWAP-2 --stat`: `scripts/ops/ads-swap-1116.ts`, its spec, the builder report (3 files; no workflow, no `admin-ads.service.ts`). `npm run contract:build` left the tree clean (`contract/openapi.json` unchanged). `npx tsc --noEmit` clean. `ads-swap-1116.contract`: 17 of 17 with three other live adverts in the database. `admin-ads.contract`: 208 of 208 (on a database with no other current adverts, as before). Gates: 0 fail, 144 warn, 88 accepted, PASSED; `check_baseline.py` ok (125).

## Still not proved

The live server itself (real env file, real storage, the four live adverts there); only the local stand-in with a seeded copy of the shape you described.
