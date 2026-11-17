VERDICT: merge

Final report, 16 Nov 2026. Branch `wmt/USERS-DASH` d2740153 (merge-base with `origin/main` is c3fd7971, checked). I changed no product code and no existing test. My attack specs and scripts are not committed. Nothing below touched a live service or provider: a local Postgres 16, the repo's mock WAWU ID, and a small fake WAWU ID of my own for `internal/users/list`.

One finding is medium (F1), so the verdict is fix. It is small to fix. The protected route `GET /users/me` is safe: same answer, no error reaches the caller.

## Findings

### F1 MEDIUM: the sign-in recording can replace a country the person just chose
`src/geo/profile-location.service.ts:149` (`noteSignedIn`), `:161` (`recordIfMissing`), `:197` (`me()` upsert).
- `recordIfMissing` reads the stored place (null), calls `me()`, which reads again (null) and then runs an upsert whose `update` branch sets the country unconditionally.
- If the person's own choice (PATCH profile or `/me/location`) lands between `me()`'s read and its upsert, the choice is overwritten with the token's country, source `wawu_id`.
- Reproduced (spec not committed): I made the second `stored()` read return the stale null and wrote `KE / profile` at that moment. Final row: `NG / wawu_id`. The person's choice was lost.
- Why it matters: a chosen country must never be replaced. The window is one database round trip (a few ms), so it is rare. But `noteSignedIn` now runs for every person on their first `GET /users/me` in each process, which is also when new people are in onboarding and choosing a country.
- Not new in kind (`me()` has the same gap on `/me/location`), but this change makes it reachable from the most-called route.
- Fix: write only where there is still no chosen country, as GEO-FILL's `write` (`geo-fill.service.ts`) already does: `updateMany` where the country is null or its source is `wawu_id`/`phone`, else insert and ignore a primary-key clash.

### F2 LOW: `q` wildcards `%` and `_` match handles
`src/admin/users/admin-users.service.ts:107` (`contains: q`). Prisma does not escape them. With 6 accounts, `q=%%`, `q=__` and `q=%_%` each returned all 6 (total 6). No SQL injection: `x' OR '1'='1` matched nothing by handle. The leak is only that a pattern matches more handles than the text says. Admin only, shows nothing the plain list does not. Fix: escape `%`, `_` and `\` in `q` for the handle match.

### F3 LOW: a search that matches over 500 people is cut silently, and `total` says 500
Fake WAWU ID with 600 matches, all with Hub accounts: `total: 500`, 5 search calls, `contactUnavailable: false`. The page does not say anything was left out, so a support person reads 500 as the whole answer. It is documented in the service comment and the builder's report. The owner may accept it; if so, the dashboard should show "500 or more". Suggest adding a `truncated: true` beside `contactUnavailable`.

### F4 LOW: paging is by offset, so new sign-ups cause repeats
30 accounts, `perPage=10`, 5 newer accounts added after page 1: the walk saw 35 rows, 30 unique, 5 repeats, 0 missed. Every admin list in this repo pages by offset, so this is the house style, not a regression. Nobody is skipped.

### F5 LOW: the first `GET /users/me` of each new person is a few ms slower
300 distinct new people, three runs each, 300 sequential calls per run (ms):

| | p50 | p95 | mean |
|---|---|---|---|
| main | 2.66 / 2.71 / 2.76 | 3.60 / 3.82 / 4.18 | 2.80 / 2.86 / 2.93 |
| branch | 6.49 / 4.30 / 4.44 | 10.78 / 7.34 / 7.25 | 7.02 / 4.74 / 4.78 |

The same person called 300 times (the steady state) is the same: main p50 3.76-3.85 / p95 5.4-6.2; branch p50 3.83-3.96 / p95 5.3-5.7. The extra is the background read and write sharing one process and one local database; against a remote database the cost on the request itself should be smaller, but I could not measure that. It is once per person per process.

### F6 LOW: the lock transaction can outlive its 15 minutes
`geo-fill.service.ts:117`. With 5,000 accounts the scheduled run took 15.1 s (about 3 ms an account, serial writes), so 15 minutes is about 300,000 accounts: not a risk at 224 or at 10,000. If it ever did time out, Prisma would reject the transaction while `run()` kept going without the lock; writes stay safe because each one is conditional. Note only.

## What held

**V1, the diff.** Existing files only gain lines: `src/app.module.ts` +5/-0, `src/geo/profile-location.service.ts` +54/-0, `src/user-profile/user-profile.service.ts` +8/-0, `contract/openapi.json` +137/-0. `me()` is unchanged. No existing test edited; the only new file under an existing test folder is `geo-signin-record.contract.spec.ts`. No `prisma/schema.prisma`, `src/common/**` or guard change. No em-dash in new product strings.

**V2, `GET /users/me`.**
- Answer byte for byte as on `origin/main` for 7 kinds of person: no profile row, profile with a GH claim, a chosen KE country, an unknown country, a bad phone, a creator profile, and seeded creator-pro; first call and second call. The only difference was the `createdAt` of rows my harness made in each run.
- Database read failing, database write failing: both 200, no unhandled rejection, and the next call recorded the country (`NG`).
- Malformed claims straight into `noteSignedIn` (null, undefined, `{}`, numbers, objects, a 100 KB country, a 5,000 character phone, an array, a string): none threw, no unhandled rejection.
- 200 requests at once for one new person: all 200, 1 upsert, 3 reads in total.
- Remembered set at 50,000: the next person cleared it (size 1), request 200 in 9-31 ms. After the clear, every person is looked at again once (one read for a person with a country claim); harmless.
- A person who chose a country (no race): 0 upserts.
- Two instances: each keeps its own set, so each may write once for the same new person; both write the same value. Not run as two processes against one person.
- Protected routes suite (`scripts/protected-routes/run.sh origin/wmt/USERS-DASH`, lock from main): all 244 required tests passed, exit 0.

**V3, roles** (status codes, each of 3 routes):

| | superadmin | support | finance | reviewer | WAWU ID user token | no token | expired admin token | garbage |
|---|---|---|---|---|---|---|---|---|
| GET `/admin/users`, `/admin/users/counts` | 200 | 200 | 403 | 403 | 401 | 401 | 401 | 401 |
| POST `/admin/geo/fill-countries` | 200 | 403 | 403 | 403 | 401 | 401 | 401 | 401 |

**V4, personal data.**
- Debug logging on, a fake WAWU ID answering 500, nonsense (not JSON), `{hello}`, `items` not an array, and null rows, plus a search with `q = sup3rsecret-q@leak.test`: 9 log lines, all of the form "WAWU ID users list failed (HTTP 500)", "did not answer (SyntaxError)", "answered in an unknown shape", "(WawuIdTimeoutException)". No email, phone, name or `q` in any log line. No leak in any response body.
- Every table in `public` (row count and md5 of all rows) before and after a list, 7 failure modes, a slow call, 12 `q` shapes, and a counts call: nothing changed.
- 2,500 accounts filled by the real app: the fake WAWU ID's emails and phones appear in neither app log (0 matches in both) nor in `ProfileDetails` rows.

**V5, the list.**
- WAWU ID down (500), nonsense, odd shape, `data`-wrapped: always HTTP 200. Down, nonsense, odd shape and `items` not an array give `contactUnavailable: true` with the Hub fields still filled; `data`-wrapped is read as normal (`false`).
- Slow WAWU ID (4.5 s): 200, `contactUnavailable: true`, 3,018 ms (the 3 s bound holds). A search with a slow WAWU ID waits for the bound twice (once for the search, once for the page's contacts), so about 6 s; I did not time it.
- `q`: 1 character 400, 121 characters 400, 120 characters 200, spaces only 400, one backslash 400, `q` twice 400, `perPage=101` 400, `page=0` 400, `page=99999999999` 400.
- Lagos day start: `22:59:59.999Z` gives 23:00 the day before; `23:00:00.000Z` gives 23:00 that day; `00:00Z` gives 23:00 the day before. Correct.
- Order, each flag from its true source (tick lapsed vs held, the other provider's wallet not counted, a lifted suspension, a person with no WAWU ID row), phone written `0803...`: covered by the builder's specs, which I ran (19 of 19 pass). Whether the real WAWU ID matches a phone is WAWU ID's, as the builder said.

**V6, the fill.**
- 450 accounts in three batches: WAWU ID called with 200, 200 and 2 ids (the 2 are old seeded accounts with no country). Answer `checked 453, filled 300, alreadyChosen 51, unknown 102`: 300+51+102 = 453. 200 got `GH / wawu_id` (the claim wins over the phone's NG), 100 got `NG / phone`, 50 chosen `KE` were kept and never changed. Second run: `filled 0`, `alreadyChosen 351`, `unknown 102`, nothing changed.
- An account with a saved region and no country lost the region when it was filled.
- Two presses at once, 250 accounts: one answered filled 250, the other filled 0; 250 rows, none written twice; each answer's numbers add up.
- Accounts that got a chosen country during the run (inserted, and upserted, between the id read and the write): both kept `KE / profile`; the answer counted them `alreadyChosen`.
- WAWU ID failing on the second batch: 502 with the usual error body, 198 accounts filled (the first batch of 200 less 2 seeded accounts WAWU ID did not know) and kept.
- Started the whole app (`node dist/src/main.js`) twice at once on ports 4101 and 4102, 2,500 accounts with no country: at 10:31:05, 97 s after start (90 s plus boot), instance 1 logged "Country fill: checked 2503, filled 2500, already had one 1, unknown 2." Instance 2 logged nothing: it did not get the lock. 2,500 rows `wawu_id / GH`.
- The cron job `geo-fill-countries` is registered (62 jobs in the registry, next run 17 Nov 02:23 UTC); calling its tick filled 2,462 of 2,500 accounts in 6 s, then I closed the app (so the line "Country fill" did not appear that time).
- A failing run does not stop the app: the builder's spec for this passes (a failing scheduled run logs one error line and the app stays up); I saw the error line with a stack in the spec output, and it contains only the 502 message.
- Lock with 5,000 accounts: the run took 15.1 s. The lock connection sat `idle in transaction` for the whole run, with one advisory lock held. A `count(*)` on `UserProfile` made every 400 ms for 2.4 s answered in 2 to 20 ms, so nothing was blocked. A second `scheduled()` call in the same process returned at once (in-process flag).

**V7, contract and gates.**
- `npm run contract:build`: tree clean afterwards (`git status` empty).
- `python3 scripts/gates/run.py`: 9 gates, 0 fail, 144 warn, 88 accepted. Same on `origin/main` (0 / 144 / 88). `check_baseline.py`: passed, 125 entries, every one with an owner and a reason.
- `npx tsc --noEmit`: exit 0 (needs `NODE_OPTIONS=--max-old-space-size=6000` on this 15 GB machine; the default heap aborts).
- Affected contract suites (`src/admin/users`, `src/geo-fill`, `src/geo`, `src/user-profile`, `src/admin/creators`, `src/admin/geo`, `src/protected-routes`): 24 suites, 624 tests, all passed.
- What CI will run (`.github/workflows/branch-checks.yml`, `gates.yml`, `protected-routes.yml`): `tsc --noEmit`, the whole jest suite in 3 shards, the netns test, `contract:build` with a diff check, the gates, and the protected-route check against the base lock. I did not run the full suite or the netns test.

## Passes

| Pass | Result |
|---|---|
| V1 diff | passed |
| V2 `GET /users/me` | passed on the answer and the errors; F1 (medium) and F5 (low) are found in the same path |
| V3 roles | passed |
| V4 personal data | passed |
| V9 (the rest of the list: fill, schedule, gates, contract) | passed, with F2, F3, F4, F6 low |

## What I could not prove
- Anything about the real WAWU ID `POST /internal/users/list`: it is not live. I used my own fake following the contract in the brief. Phone and email search, the `q` length it accepts, and its real speed are untested.
- Two separate processes both seeing the same new person at `GET /users/me` (I reasoned from the code, not ran it).
- `/users/me` timing against a remote database; mine is local, where the process and the database share one machine.
- The full jest suite in three shards, and `test:netns`.
- Behaviour with the 224 real accounts; I used 2,500 to 5,000 test accounts.

## Re-check of fix round 1

16 Nov 2026, `wmt/USERS-DASH` 9bfc5a58 (fix commit 6b533867). The diff against d2740153 is 7 files: `contract/openapi.json` (2 lines), `admin-users-view.type.ts`, `admin-users.controller.ts`, `admin-users.service.ts`, `profile-location.service.ts`, and two new specs. Nothing else moved. Verdict is now merge: F1, F2 and F3 are closed, and I found no new fault.

**F1 closed.** `recordIfMissing` now writes with `updateMany ... countryCode IS NULL`, else an insert that a primary-key clash (P2002) turns into "someone got there first". It no longer calls `me()`; `me()` is untouched. Attacks (local, real database):
- First-ever row: written `NG / wawu_id`.
- Row with a null country and a saved region: written, region dropped (as the fill does).
- Chosen country already there: no write, `KE` kept.
- The gap, row exists: the read made to return a stale "none" while `KE / profile` (with region `NA`) already existed: no write, `KE / profile / NA` kept.
- The gap, first-ever row: the choice created between the read and the write: the insert hit P2002, answered false, `KE / profile` kept.
- 40 rounds of the recording and a real choice at the same moment on a new person: all 40 ended on the choice (`KE`); 40 more rounds with 3 recordings against one choice: none overwritten.
- A failing write: no throw, no unhandled rejection.
- `GET /users/me`: same 7 people as before, answers byte for byte the same as `origin/main` once the row-creation time and the token's issue/expiry times are set aside. New-person timing as in F5 (p50 4.0 ms, p95 6.9 ms against main 2.7 / 3.6-4.2), same-person calls unchanged (p50 3.7, p95 5.3). `GET /me/location` is the same code (`me()` unchanged); the builder's specs and the affected suites pass.

**F2 closed.** Handles `zz8ab_cd`, `zz8abXcd`, `zz8a%b`, `zz8aXXb`, `zz8back\slash`, `zz8backXslash`: `b_c` finds only `zz8ab_cd`; `a%b` only `zz8a%b`; `k\s` only `zz8back\slash`; `%%`, `__` and two backslashes find nothing; a quote string finds nothing. Plain `zz8ab` and `ZZ8AB` (upper case) still find both `zz8ab...` handles. The other search behaviour is unchanged.

**F3 closed.** `truncated` is in the list answer beside `contactUnavailable`, always present. WAWU ID matches of 0, 99, 100, 499 and 500: `truncated: false`; 501 and 600: `truncated: true`, `total` 500. WAWU ID down: `truncated: false`, `contactUnavailable: true`. A list with no `q`: `truncated: false`. `npm run contract:build` leaves no diff (the tree shows only my two symlinks).

**Nothing else moved.**
- `npx tsc --noEmit`: exit 0.
- Gates: 0 fail, 144 warn, 88 accepted (same as before); `check_baseline.py` passed.
- Affected suites (`src/admin/users`, `src/geo-fill`, `src/geo`, `src/user-profile`, `src/admin/creators`, `src/admin/geo`): 24 suites, 383 tests, all passed.
- Protected routes (`scripts/protected-routes/run.sh origin/wmt/USERS-DASH`, lock from main): all 244 required tests passed.

F4 (offset paging repeats), F5 (first call a few ms slower), and F6 (15 minute lock) are as before and low; none blocks the merge. Not re-run: the full suite and the netns test (CI runs them).
