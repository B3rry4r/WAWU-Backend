VERDICT: fix
INTERIM

Interim, 16 Nov 2026. Branch `wmt/USERS-DASH` d2740153, merge-base with `origin/main` starts c3fd797 (checked). Verifier session: independent, no product code changed.

## So far
- V1 diff: existing files only gain lines (`app.module.ts` +5, `profile-location.service.ts` +54, `user-profile.service.ts` +8, `contract/openapi.json` +137). `me()` unchanged. No existing test edited. No fenced file touched beyond the two allowed ones.
- V2 `GET /users/me` (protected route): answer is byte for byte the same as `origin/main` for 7 kinds of person (no profile, profile with GH claim, chosen country KE, unknown country, bad phone, creator, seeded creator-pro), first and second call. Only `createdAt` of rows my harness created differs (different run). Database write or read failing: still 200, nothing unhandled, retried next call. Malformed claims (null, undefined, numbers, objects, 100 KB strings): `noteSignedIn` never throws. 200 requests at once for one new person: 1 upsert, 3 reads in total. Set at 50,000: cleared, request 200.
- 41 of 41 builder specs pass here. `npx tsc --noEmit` exit 0 (needs `--max-old-space-size=6000` on this machine).

## Findings so far
- MEDIUM F1: `noteSignedIn` can overwrite a country the person just chose. `recordIfMissing` reads, then `me()` reads again, then `me()` upserts with an unconditional `update` (`src/geo/profile-location.service.ts`, `me()` upsert, about line 195). If the person's own choice lands between that read and the upsert, the choice is replaced by `NG / wawu_id`. Reproduced: choice KE/profile written between `me()`'s read and its upsert, final row `NG / wawu_id`. The window is one database round trip, so it is rare, but it breaks the rule that a chosen country is never replaced, and `noteSignedIn` now runs for every person at first sign-in. Fix: make the write conditional (`updateMany` where country is null or source is `wawu_id`/`phone`, else insert), as GEO-FILL's `write` already does.
- LOW F2: first `GET /users/me` of each new person is a few ms slower (the background write competes in the same process). 300 distinct new people, 3 runs each: main p50 2.7 ms / p95 3.6-4.2 ms; branch p50 4.3-6.5 ms / p95 7.3-10.8 ms. Same person called again: main p50 3.8 / p95 5.4-6.2, branch p50 3.9 / p95 5.3-5.7 (no change).

Full report to follow.
