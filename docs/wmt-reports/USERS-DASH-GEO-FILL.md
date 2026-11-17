# USERS-DASH (R-142) and GEO-FILL (R-143)

Branch `wmt/USERS-DASH`, from `origin/main` c3fd797. No pull request opened. This repo has no place for builder reports (`.pipeline/` holds a 22 Aug build record only), so this is the default path.

## What changed

New files unless marked.

**WAWU ID read (shared)**
- `src/identity-users/wawu-id-users.client.ts`: `WawuIdUsersClient.byIds(ids)` and `.search(q, cursor, limit)` call `POST /internal/users/list`. Same base URL, `X-Service-Key`, 3 s read bound and `wawuIdExchange` as `WawuIdClient`; nothing added to env. It is a new class, not a method on `WawuIdClient`, because `src/common/**` is fenced. Any failure (down, slow, route not live, odd answer) is `null`, never a throw. It logs a status only, never a name, email, phone or `q`.
- `src/identity-users/identity-users.module.ts`.

**GEO-FILL**
- `src/geo-fill/geo-fill.service.ts`: `run()` (the one function), `scheduled()`, a `@Cron('23 2 * * *')` daily run and a run 90 s after start.
- `src/geo-fill/geo-fill.controller.ts`: `POST /admin/geo/fill-countries`, superadmin only. `geo-fill.module.ts`.
- `src/geo/profile-location.service.ts:98-150` (edit): `derived(claims)` (WAWU ID country first, else phone, the order `me()` uses), `noteSignedIn()` and `recordIfMissing()`. `me()` is untouched.
- `src/user-profile/user-profile.service.ts:44-52,114-118` (edit): `getMe` calls `noteSignedIn` (point 3).
- `src/app.module.ts:12-13,248-250` (edit): the two module lines.

**USERS-DASH**
- `src/admin/users/`: controller, service, DTO, view types, module.
- `contract/openapi.json`: regenerated with `npm run contract:build`; 137 lines added, none removed.

## Routes

### `POST /api/hub/admin/geo/fill-countries` (superadmin; support, finance, reviewer get 403)
Request: no body.
```
200 { "statusCode": 200, "message": "OK", "data": { "checked": 248, "filled": 181, "alreadyChosen": 24, "unknown": 43 } }
```
(Example numbers.) `checked = filled + alreadyChosen + unknown`. `alreadyChosen` is every account that already has any country (one a person chose, or one recorded earlier); those are never read or written. `unknown` is an account with no country that WAWU ID does not know, or that gives none. If WAWU ID cannot be reached the run stops at that batch, keeps what it filled, and answers 502.

### `GET /api/hub/admin/users?q=&page=&perPage=` (superadmin, support; finance and reviewer 403)
Request: `GET /api/hub/admin/users?q=ada&page=1&perPage=20`. `q` is 2 to 120 characters; `page` and `perPage` as on every admin list (`perPage` up to 100).
```
200
{ "statusCode": 200, "message": "OK",
  "data": [ { "wawuId": "…", "firstName": "Ada", "lastName": "Eze", "handle": "ada",
              "email": "ada@example.com", "phone": "+2348031230001",
              "countryCode": "NG", "countryName": "Nigeria", "countrySource": "profile",
              "accountType": "creator", "joinedAt": "2026-11-01T09:00:00.000Z",
              "tickHeld": true, "walletOpened": true, "suspended": false } ],
  "pagination": { "currentPage": 1, "nextPage": null, "perPage": 20, "total": 1 },
  "contactUnavailable": false }
```
`contactUnavailable` is always present. It is `true` when WAWU ID could not be reached; then the four contact fields are null and the Hub fields are still filled. A person WAWU ID has no row for has null contact fields and `contactUnavailable` stays false. The shared interceptor keeps only four paging fields and `src/common/**` is fenced, so the handler writes the same envelope itself (`@Res()`) with the extra key.

### `GET /api/hub/admin/users/counts`
```
200 { "statusCode": 200, "message": "OK", "data": { "total": 248, "creators": 190, "joinedToday": 3, "noCountry": 224 } }
```
`today` is the Lagos day (starts 23:00 UTC the evening before). `noCountry` counts accounts with no ProfileDetails row or an empty country, the same notion the geo counts call `unknown`.

## Decisions and where each flag comes from
- **Joined date:** `UserProfile.createdAt` (the Hub profile has its own). Newest first, ties by id.
- **tickHeld:** the four tick columns on `UserProfile` through `deriveVerificationState`; a lapsed tick is false.
- **walletOpened:** a `FintavaWallet` row of the provider this server runs (`WALLET_PROVIDER`, read with `readWalletProviderName`, filtered with `rowsOf`), the same rule the admin wallets list uses. A Nuvion row does not count on a Fintava server and the reverse.
- **suspended:** a `UserSuspension` row with `liftedAt` null, what `/admin/users/:id/suspension` reads.
- **country, countrySource:** `ProfileDetails`; a country with no source is `profile`, as `me()` reads it.
- **How a search pages:** WAWU ID's matches for `q` are read newest first, 100 a page, up to 5 pages (500 people). The Hub then pages `handle contains q OR id in those matches` with `page` and `perPage`, so `total` is the size of that union and a person with no Hub account never appears. A search matching over 500 people in WAWU ID is cut at the 500 newest (handle matches are never cut). If the search call fails, the handle matches are listed with `contactUnavailable: true`. `q` is passed to WAWU ID as typed, so `08031230001` and `+234 803 123 0001` are WAWU ID's to read.

## How the fill runs by itself
`GeoFillService` (only in `AppModule`, so specs that import other modules never start it): `@Cron` daily at 02:23 server time, plus one run 90 s after the app starts (skipped when `JEST_WORKER_ID` or `NODE_ENV=test`). The scheduled run holds a transaction advisory lock (`geo-fill-countries`), so one server at a time; a server that does not get it does nothing. A failure is logged and never stops the app. It uses the same `run()` as the route.

Safe twice and at once: a write lands only while the row still has no country (`updateMany … countryCode IS NULL`, else an insert the primary key refuses if the row just appeared), so a country someone sets in the meantime is kept.

## Point 3 (record on sign-in)
Done, in `UserProfileService.getMe` (`GET /users/me`, which the web and the app call after sign-in; it is a protected route and its answer is unchanged). Not in a guard. The call is not awaited and cannot throw. It remembers who it checked (up to 50,000 ids, then clears), so a person costs at most one small read per process; a token that gives no country costs no read. Only a person with no country gets `me()` run for them. After a failure the person is looked at again next time.

## Runs
- `npx tsc --noEmit`: clean.
- Lint on the files I changed (`eslint`, no `--fix` on existing files): the source files are clean. The new specs carry the same `no-unsafe-*` errors on supertest bodies that the existing contract specs have (`admin-creators.contract.spec.ts` has 86).
- New specs, three runs each: `src/admin/users` 19, `src/geo-fill` 14, `src/geo/tests/geo-signin-record` 8. 41 of 41 passed on all three runs. They ran against a local Postgres 16 and the repo's mock WAWU ID; the DB was seeded with `npm run db:seed` first.
- Touched areas (`src/geo`, `me`, `user-profile`, `admin/creators`, `admin/geo`, `user-suspension`, `plans/tests/publishing-gate-coverage`, `protected-routes`, plus the new ones): 38 suites, 777 tests, all passed. The protected-routes suite passed.
- `python3 scripts/gates/run.py`: 0 fail, 144 warn, 88 accepted, the same counts as `origin/main`. `check_baseline.py`: passed. Neither the gates, a test, nor the baseline was edited.
- `npm run contract:build`: only additions.
- Not run: the full suite (CI does).

## Tests added (new files only)
- `admin-users.contract.spec.ts`: roles (including a WAWU ID token and no token), list order and every field, each flag, a person with no WAWU ID row, WAWU ID down (200, nothing logged), paging, `q` under 2 characters, `q` by handle, by name, by whole email, by a phone written `08031230001` and `+234 803 123 0001`, a person only in WAWU ID, search paging, counts (including the Lagos day boundary).
- `geo-fill.contract.spec.ts`: roles; the answer shape; a chosen country kept and never sent to WAWU ID; `wawu_id` before `phone`; unknown left alone; a stale region dropped; run twice changes nothing; two at once; 450 accounts in three batches of 200, 200 and the rest; WAWU ID down is 502 with nothing written; the scheduled run never throws and takes the lock.
- `geo-signin-record.contract.spec.ts`: records the token's country with its source, phone fallback, a chosen country kept, once per person per process, no read when the token has no country, a failure never throws and is retried next time, and `GET /users/me` end to end (answer unchanged, a failed record does not fail the request).
- `src/identity-users/tests/wawu-id-users-stand-in.ts`: the stand-in for WAWU ID's list route, used with `overrideProvider`, the way other specs stand in for WAWU ID.

## What I could not prove
- The real `POST /internal/users/list` is not live yet. I coded to the contract in the brief; the client also accepts the answer wrapped in `data`, like `internal/users/lookup`. Nothing was called live. Whether the live route's `q` matches a phone as the brief says is WAWU ID's to prove.
- The startup run and the daily `@Cron` fire only in a real app boot; specs call `scheduled()` and `run()` directly. I did not boot the whole app.
- Behaviour with the real 224 accounts is untested. Each batch is one WAWU ID call (3 s bound) and a write per account, so a first run of about 250 accounts is two calls.
- The advisory lock is held inside one long transaction (up to 15 minutes allowed) while the run uses other connections; I did not load-test it.
- Fenced files I touched, as the brief allowed: `src/app.module.ts` (two module lines) and `contract/openapi.json` (regenerated). The lead records the SHARED-CHANGES row. I did not touch `prisma/schema.prisma`, `src/common/**` or any guard.

## Fix round 1

Commit 6b53386, on top of d274015. F4, F5 and F6 left as they are (on record).

- **F1 (medium), closed.** `src/geo/profile-location.service.ts:163-172` `recordIfMissing` no longer calls `me()`. It reads the place, takes the country and source from `derived()`, and writes through `writeWhereNone` (`:183`): `updateMany` where `countryCode IS NULL`, else an insert whose primary-key clash (P2002) means someone got there first. A country set after the read is never replaced. I kept the guard at "country is null" and not "or source is `wawu_id`/`phone`", because this path only runs for a person with none, so a derived country that appears in the gap is left as it is (the same result, with no region cleared). `me()` is unchanged. Test, new file `src/geo/tests/geo-signin-gap.contract.spec.ts`: the verifier's case (a `KE / profile` choice written between the read and the write, with and without a row at the read) survives as `KE / profile`, and the normal case still records.
- **F2 (low), closed.** `src/admin/users/admin-users.service.ts:33-35` `escapeLike`, used at `:114`: `%`, `_` and a backslash in `q` are plain text in the handle match. Test, new file `src/admin/users/tests/admin-users-fix1.contract.spec.ts`: `%%`, `__`, `%_%` and `\\` match nothing; `_under_` matches only the handle that holds an underscore; `fixone_plain` does not match `fixone-plain`; ordinary text still matches.
- **F3 (low), closed.** `truncated` is always present beside `contactUnavailable`: `src/admin/users/admin-users.service.ts:94,110,189` (true when the fifth WAWU ID page still had a cursor), `admin-users-view.type.ts:40`, the envelope in `admin-users.controller.ts:39-52`, and `contract/openapi.json`. Same test file: a stand-in with 600 matches gives `truncated: true` and `total: 500`; exactly 500 matches and a plain list give false.

Runs: `npx tsc --noEmit` clean. The users, fill and sign-in specs (53 tests) passed three times in a row. Protected-routes, `src/geo`, `src/me`, `src/user-profile` and `src/admin/creators`: 680 passed. Gates: 0 fail, 144 warn, 88 accepted (same as before); baseline check passed. `npm run contract:build`: one line changed, and it is the summary text of my own `GET /admin/users` (it now names `truncated`); nothing for any existing route changed.
