# ADS-SWAP builder report

Branch `wmt/ADS-SWAP`, based on origin/main c3fd797 (merge-base checked). Head sha: see the last commit on the branch (this report is part of it). Not verified by me; a checker must.

## Files

| File | Lines |
| --- | --- |
| `scripts/ops/ads-swap-1116.ts` (builds to `dist/scripts/ops/ads-swap-1116.js`; `npm run build` and `ls dist/scripts/ops/` show it) | 608 |
| `.github/workflows/ads-swap-1116.yml` | 83 |
| `src/admin/ads/tests/ads-swap-1116.contract.spec.ts` | 499 |
| `src/admin/ads/admin-ads.service.ts` | 2 lines: `export` added to `snapshotOf` and `diff`, nothing else |

No migration, no fenced file, no protected route touched.

## Field changes, and where I read them

- End = `AdminAdsService.transition(id,'end')` (`admin-ads.service.ts` ~786-830) and `ACTION_FROM.end` in `ad-campaign-state.ts`: `updateMany where {id, status: <status read>} data {status:'ended'}`, then an `AdminAdAudit` row `{action:'ended', previousStatus:<old>, newStatus:'ended', changes:{status:{from,to}}}`. Nothing else changes. The command does exactly this per campaign.
- Create then schedule = `create()` (~533-600) then `transition('schedule')`: a `draft` campaign with its creative and audit `{created, null -> draft, changes: diff(null, snapshotOf(...))}`, then `updateMany draft -> onAirStatus(startsAt, now)` (that is `live`, since startsAt is now) and audit `{scheduled, draft -> live, changes:{status}}`. The command does the same, in the same transaction. Creative: `ctaDestination link`, `ctaLabel "Register now"`, `ctaUrl` copied, `artworkLandscapeUrl` = what `putAdArtwork` returned (`artworkUrl`, the bare address, as `uploadArtwork` hands back), `artworkUrl` and `artworkPortraitUrl` null, `placement = derivedPlacement(landscape)` (`explore_slider`). The `AdCampaign_window`, weight, advertiser, cta, pictures and shapes CHECKs hold (the spec writes through them).
- Order: `startsAt` identical, `createdAt` = base+0, +1, +2 ms, fixed ids, so `AD_TIE_BREAK` gives 1, 2, 3.

## Who the audit rows name

`AdminAdAudit` stores `adminId`, `adminEmail`, `adminRole` as snapshots with no foreign key, and the command has no admin. I did not invent one: `adminId = "ops:ads-swap-1116"` (matches no `AdminUser`), `adminEmail = "ops-command@wawu.invalid"` (cannot exist), `adminRole = superadmin` (the enum has no "system" value; superadmin is the role that stands for someone with server access). Owner: say so if you want a different marker.

## Locking and the phrase

Phrase: `SWAP ADS: END <n> CAMPAIGNS <first 8 hex of sha256 of the sorted ids>`. In the transaction: `LOCK TABLE "AdCampaign" IN SHARE ROW EXCLUSIVE MODE` (blocks writes by others, serving reads go on; I added it because a row lock cannot stop a new booking), then `SELECT ... FOR UPDATE` on the campaigns being ended, then the current set is read again and the phrase recomputed. A difference refuses and rolls back. The end date is also re-checked against the transaction's clock.

## Workflow quoting

Inputs never appear inside a script: `apply`, `confirm`, `link`, `ends` go through `env:` (`APPLY`, `CONFIRM`, `LINK`, `ENDS`). The script reads them only as `"$VAR"`, base64-encodes each on the runner (`printf '%s' "$1" | base64 -w0`), and sends only `A-Za-z0-9+/=` inside single quotes. The droplet runs `--confirm "$(printf %s '<b64>' | base64 -d)"`: the value reaches `node` as one argument and an expansion result is never parsed again, so spaces, quotes, `$`, `;`, backticks and newlines stay data. I tested the exact construction locally with a confirm containing `"`, `'`, `$(touch /tmp/PWNED)`, backticks, `;` and a newline, and a link with a space and `$(id)`: node got the exact strings and the file was not created. Concurrency group `ads-swap-1116`, no cancel. The Load SSH key step is word for word; the run step keeps resign's `ssh ... set -euo pipefail; cd; source env` shape. Not triggered.

## Spec: `src/admin/ads/tests/ads-swap-1116.contract.spec.ts` (7 passed)

1. parses its flags and refuses unknown ones
2. dry run writes and uploads nothing, lists the current campaigns and prints the phrase
3. refuses without the phrase or with a wrong one, and writes nothing
4. refuses when there is no link to copy and none given, and when the end is in the past (also bad `--link`, bad `--ends`)
5. refuses, and writes nothing, when a campaign is booked between the dry run and the apply
6. apply ends scheduled, live and paused, leaves draft and ended alone, and makes the three (rows, audit rows, order through `servableCampaigns`: 1,2,3 in Explore, 1 first on Today, none in TGIF, link/end/weight copied, no AdEvent or AdDailyTotal change, 3 objects in storage)
7. a second run finds the three and does nothing

Real `StorageService` (via `StorageModule`) against `scripts/dev/storage-standin.cjs`; real Postgres from `scripts/dev/stack.sh up --name adsw`; no mocks. Run with `npm run test:contract -- src/admin/ads/tests/ads-swap-1116`. Also green: `admin-ads.contract` (208 tests). `npx tsc --noEmit` clean, eslint clean on my files, `python3 scripts/gates/run.py` passed (0 fail), `check_baseline.py` ok.

## Real dry run (built `dist`, stack database, two seeded current campaigns)

```
DRY RUN (nothing is written or uploaded)
Current campaigns (scheduled, live or paused): 2
1. a0000000-0000-4000-8000-000000000001 | Old Brand One | Old headline one | live | explore_slider (shows in explore_slider, today_slot)
   window 2026-11-13T23:14:47.691Z to 2026-12-06T23:14:47.691Z; weight 5; a tap: link https://example.com/old-one; pictures: landscape 11111111-1111-4111-8111-111111111111.png
2. a0000000-0000-4000-8000-000000000002 | Old Brand Two | Old headline two | paused | explore_slider (shows in explore_slider, today_slot)
   window 2026-11-13T23:14:47.691Z to 2026-11-26T23:14:47.691Z; weight 2; a tap: nothing (shown only); pictures: landscape 22222222-2222-4222-8222-222222222222.png
The new campaigns will take: link https://example.com/old-one; end 2026-12-06T23:14:47.691Z; weight 5; start now (copied from campaign a0000000-0000-4000-8000-000000000001).
   new 1. WAWU with SOUEAST | Drive. | Gifted to one creator. | picture 1-drive-car.png (266230 bytes) | landscape only: shows in explore_slider and today_slot, never tgif_card
   new 2. WAWU | 5 DJI Osmo Pocket 3. | Shoot your next big thing. | picture 2-dji-osmo-pocket-3.png (175401 bytes) | landscape only: shows in explore_slider and today_slot, never tgif_card
   new 3. WAWU with VERGIO | 4 Gaming Systems. | Built to create. | picture 3-gaming-systems.png (223600 bytes) | landscape only: shows in explore_slider and today_slot, never tgif_card
Will end: 2
Confirmation phrase: SWAP ADS: END 2 CAMPAIGNS 89320a95
Dry run only. To swap: add --apply --confirm "<the phrase above>".
```
`--apply` without `--confirm` printed `REFUSED: --apply needs --confirm ...` and exit 1. The stack is down; I did not run the apply by CLI (the spec covers it).

## Unsure or not done

- The link source is read literally: the first current campaign in `AD_TIE_BREAK` order, in its window, landscape, link. That includes a **paused** one, as written in the order. If the heaviest in-window link ad is paused it wins over a live one. The dry run names the campaign the link came from; read it before applying, or pass `--link`.
- `--ends` takes only the admin API's UTC form (`2026-12-31T23:59:59Z`, with the Z), because I reused `parseUtcInstant`.
- No `--link` and no source campaign: weight falls to the minimum (1).
- If the three exist but others are current, a run ends the others and creates nothing. If only some of the three exist, it refuses.
- Pictures: the readback prints the object key's last part. A storage failure on upload 2 or 3 leaves earlier uploads in the bucket (printed as harmless); the database is untouched.
- The command boots `StorageModule` (so PlansModule and PlanSettingsModule come with it): the real service needs them. On the stack it printed the "storage not configured" warning in a dry run; apply needs `STORAGE_*` from `/etc/wawu/hub-api.env`, which resign-content-urls also uses.
- The post-apply "served now" count uses a no-viewer, nobody-blocked stand-in for the block list (it is only read for old `event` cards, and none can be live after the swap).
- I started Postgres and set its local test password in this sandbox to bring the stack up; no repo change. Once I ran bare `npx jest --runInBand --forceExit <path>` (the same flags as the script) to list test names.
- The checker should confirm the deploy rsync carries `scripts/ops/ads-1116/*.png` (it excludes only `.git`, `node_modules`, `dist`, `dist-seed`, `generated`, `.env`).

## Fix round 1

Source diff without the spec: `scripts/ops/ads-swap-1116.ts` only, 122 insertions and 51 deletions. No other source file changed; no new `export` in the ads code (the weight rule is the DTO's own `AD_WEIGHT_MIN` and `AD_WEIGHT_MAX` from `src/ads/ads-limits.ts`, already exported). Head sha: the last commit on `wmt/ADS-SWAP` (this section is part of it).

- **M1** `scripts/ops/ads-swap-1116.ts` `phraseFor` (line 158), used at the dry run and again in the transaction (~465). The phrase hashes, for every current advert in id order, `id|status|weight|startsAt|endsAt|placement|ctaDestination|ctaUrl`, then `source|<source id or none>`, then `new|<link>|<end>|<weight>` (the values the three take after the flags; `new|none` when the three already exist). Text shape: `SWAP ADS: END <n> CAMPAIGNS <8 hex>`. In the transaction, after the lock, the adverts are read again and the source and the taken values are worked out from that read (`takeFrom(again, opts, nowTx)`), never from the earlier one; any difference refuses with "what the dry run showed has changed (an advert was booked, ended, paused, resumed or edited)". Problems found in that re-read (a bad end, say) refuse too. Specs: paused between; weight, ctaUrl and endsAt edited between (each restored after); same phrase with a different `--weight`, `--link` or `--ends` (refused before any upload); a booking between (existing test).
- **L1** `sourceOf` (243): first ON AIR (live or scheduled) advert in `AD_TIE_BREAK` order that is in its window, landscape and `link`; only if none, the first paused one that fits. The line reads `copied from campaign <id>, which is live and on air` (or `scheduled and on air`, or `which is PAUSED (no live or scheduled advert had a link to copy)`). `--weight <n>`: `parseWeight` (259), a whole number from `AD_WEIGHT_MIN` to `AD_WEIGHT_MAX`, as the admin DTO checks it; flag parsing at 615. Specs: a heavier paused advert (weight 9) no longer beats the live one (7); with only a paused one the line says PAUSED; `--weight` 0, 101, x, 2.5, -1 and empty are refused, 12 is shown.
- **L4** `errorWords` (348): a failure prints one sentence, the error's class name and its code if it has one, and that the database was not touched or the transaction was rolled back. No message text, no path. The upload failure and the top-level handler use it too. Spec: a failing upload carrying a path and SQL text in its message prints only `(Error P2002)`. (That one test gives the command a storage whose call fails, to provoke the failure; every other test uses the real service.)
- **L5** the read-back counts only the command's own scope when the test hook `onlyIds` is set (line ~607); the spec now seeds a live advert outside that scope before the apply and still sees `Served now in explore_slider: 3`.
- **L2 and L3**: left as built; one line of the header comment (line 43) records both.

Results: `npm run test:contract -- src/admin/ads/tests/ads-swap-1116` 13 passed (7 before, 6 new); `admin-ads.contract` 208 passed (it needs a database without extra live adverts; the first run failed 4 only because my seeded demo adverts were in it, and passed after I removed them); `npx tsc --noEmit` clean; eslint clean on both files; gates 0 fail, baseline ok.

Fresh dry run (built `dist`, stack database; two current adverts: live weight 5 and a paused one of weight 9, both with links):
```
DRY RUN (nothing is written or uploaded)
Current campaigns (scheduled, live or paused): 2
1. a0000000-0000-4000-8000-000000000002 | Old Brand Two | Old headline two | paused | explore_slider (shows in explore_slider, today_slot)
   window 2026-11-14T00:27:38.867Z to 2026-11-27T00:27:38.867Z; weight 9; a tap: link https://example.com/old-two; pictures: landscape 22222222-2222-4222-8222-222222222222.png
2. a0000000-0000-4000-8000-000000000001 | Old Brand One | Old headline one | live | explore_slider (shows in explore_slider, today_slot)
   window 2026-11-14T00:27:38.867Z to 2026-12-07T00:27:38.867Z; weight 5; a tap: link https://example.com/old-one; pictures: landscape 11111111-1111-4111-8111-111111111111.png
The new campaigns will take: link https://example.com/old-one; end 2026-12-07T00:27:38.867Z; weight 5; start now (copied from campaign a0000000-0000-4000-8000-000000000001, which is live and on air).
   new 1. ... new 3. (the three, as before)
Will end: 2
Confirmation phrase: SWAP ADS: END 2 CAMPAIGNS 2beff277
Dry run only. To swap: add --apply --confirm "<the phrase above>".
```
`--weight 0` printed `CANNOT APPLY: --weight must be a whole number from 1 to 100.` The stack is down.

## Fix round 2

Branch `wmt/ADS-SWAP-2` from origin/main 2960831 (it holds `scripts/ops/ads-swap-1116.ts`). Head sha: the last commit on the branch (this section is part of it). Source diff against origin/main without the spec: `scripts/ops/ads-swap-1116.ts`, 45 insertions and 20 deletions. Changed only that file, its spec and this report; the workflow, pictures, ads code and fenced files are untouched. `contract/openapi.json` did not change after `npm run contract:build` (0 unmatched routes; nothing to commit).

Changes in `scripts/ops/ads-swap-1116.ts`:
1. Source (`sourceOf`, ~248): the first advert ON AIR (live or scheduled) in its window that shows in Explore or Today, WHATEVER its tap, in `AD_TIE_BREAK` order; only when none is on air, the first paused one that fits. The "PAUSED" line now reads "(no live or scheduled advert is on air)".
2. Tap copied (`takeFrom`, ~274; new `tap` field on `Taken`, 149): `link` gives link + its address + "Register now"; `none` gives `none`; `event` is not copied: `CANNOT APPLY: the campaign to copy from opens an event ... Give --link.` (315), and `--apply` refuses. No source and no `--link` still refuses, now saying "no current campaign to copy from".
3. Creation (~515-537): a `none` card is stored as `resolveCta` leaves it: `ctaLabel` null, `ctaUrl` null, `ctaDestinationId` null. A `link` card is as before.
4. `--link` still overrides the tap whatever the source (`tap` becomes `link`); `--ends` and `--weight` as before.
5. Dry run wording (~425): `The new campaigns will take: a tap does nothing (shown only); end ...; weight ...; start now (copied from campaign <id>, which is live and on air).` The read-back says `no button, a tap does nothing` (617).
6. Phrase (181): the `new|` part is now `new|<none or link>|<link>|<end>|<weight>`, so a different tap or `--link` is refused; everything from round 1 is still read again inside the transaction.

Spec (17 tests pass, 4 new): the live-server case (four `none` adverts, weights 40, 30, 20, 10, landscape and portrait, same window ending 2027-01-29T05:14:58Z: all four ended, three new `none` adverts weight 40 with that end; Explore serves 1, 2, 3, Today 1, TGIF none; cards carry no `ctaLabel` or `ctaUrl`; campaign, creative and audit rows equal a twin made by `AdminAdsService.create` with `ctaDestination none` then `schedule`, apart from ids, times and the picture key; a view is counted once and repeated taps count once a day, because `ads-events.service.ts` applies one rule to every card kind and does not refuse a tap on a `none` card); `--link` over a `none` source gives `link` + "Register now"; an `event` source is refused without `--link` and accepted with it in the dry run; the phrase binds the tap (a later `--link`, or the source's tap changing between the dry run and the transaction, is refused). The earlier "no link to copy" test now uses an event source and an empty scope.

Checks: `npm run build` ok (dist holds the script); ads-swap spec 17/17; `admin-ads.contract` 208/208; `npx tsc --noEmit` clean; eslint clean on both files; gates 0 fail, baseline ok; `contract:build` no change.

Dry run of the built command on the local stack seeded with the four-advert case (weights 40, 30, 20, 10, all `none`, landscape and portrait):
```
DRY RUN (nothing is written or uploaded)
Current campaigns (scheduled, live or paused): 4
1. b0000001-... | Old Brand 1 | Old headline 1 | live | explore_slider (shows in explore_slider, today_slot, tgif_card)
   window ... to 2027-01-29T05:14:58.000Z; weight 40; a tap: nothing (shown only); pictures: landscape ..., portrait ...
2. b0000002-... weight 30 ...   3. b0000003-... weight 20 ...   4. b0000004-... weight 10 ... (all live, none)
The new campaigns will take: a tap does nothing (shown only); end 2027-01-29T05:14:58.000Z; weight 40; start now (copied from campaign b0000001-0000-4000-8000-000000000000, which is live and on air).
   new 1. WAWU with SOUEAST | Drive. | ... new 2. WAWU | 5 DJI Osmo Pocket 3. | ... new 3. WAWU with VERGIO | 4 Gaming Systems. | ...
Will end: 4
Confirmation phrase: SWAP ADS: END 4 CAMPAIGNS 0fc216e2
Dry run only. To swap: add --apply --confirm "<the phrase above>".
```
(Long lines shortened here; the full output printed no `CANNOT APPLY`.)
