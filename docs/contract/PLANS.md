# The maker plan: prices, tiers and the billing currency

Task TIER-01, 8 Oct 2026 (R-43, R-44). How the plan's figures are kept, how a
person's billing currency is decided and fixed, and what `GET /plans` and
`GET /me/tier` answer. The money routes' own rules are in
[`CONVENTIONS.md`](CONVENTIONS.md); this page adds what a second currency
needs.

## 1. One config file

Every price, product count, points amount, expiry, cost and cap of the
owner's 5 Oct plan (Developer Brief v2.0, section 2) is in
`src/plans/plans.config.json`, and nowhere else. The figures in it are the
owner's example values until the owner sends final prices (R-43): the file's
`provisional` object and the `PROVISIONAL(...)` markers in
`src/plans/plans-config.ts` say so, one per value (`PLAN-PRICES` for the whole
file; `PLAN-CASHOUT-MINIMUM` and `PLAN-BOUGHT-POINTS-DAYS`, the two values the
brief does not give; `PLAN-ENDING-DAYS`, VF14's window). A spec keeps the two
lists equal.

- **Units.** Money is whole minor units: `kobo` for people billed in naira,
  `cents` for people billed in dollars (`"price": { "kobo": ..., "cents":
  ... }`). The brief writes naira and dollars; each figure here is the brief's
  times 100. Points are whole points; a pack and the checkout offer give a
  different number of points per currency (`"points": { "NGN": ..., "USD":
  ... }`).
- **Checked at boot.** The server reads the file once when it starts
  (`PLANS_CONFIG`, a provider of `PlansModule`) and checks all of it: a file
  that is not JSON, or a field that is missing, unknown (a misspelling), of
  the wrong kind or out of range, stops the server with
  `plans.config.json: <field> <problem>. Fix the file and restart.`, for
  example `tiers[1].price.kobo must be a whole number of 1 or more (it is
  3000.5)`. A key written twice in one object stops it too
  (`tiers[0].price.kobo is written twice`: `JSON.parse` would keep the
  second). No whole number may exceed 2,147,483,647, the most an INTEGER
  column holds (counts and points are copied into such columns), and
  `action_points` must price exactly the brief's twelve actions. Ids must be
  unique; a tier's `event_pass` must be listed in
  `event_passes`; `preselected_tier` and every key of `referral.base_points`
  must name a tier; referral levels and milestones must rise.
- **Changing a figure** is editing the file and restarting (a deploy rsyncs
  the source, so the server reads the new file). No code changes.
- **Nothing else writes a figure.** `src/plans/tests/plans-figures.spec.ts`
  fails when a number from the config is written as a literal in the plan's
  code (`src/plans/`, and any folder a later task adds to
  `FIGURE_FREE_DIRS`), or when any string in `src/` writes a plan price as
  money (`₦` or `$`) or a plan points amount as points.

## 2. The billing currency

A person is billed in `NGN` or `USD` (the `BillingCurrency` enum).

1. Once fixed, the fixed one (`PersonBilling`, one row per person).
2. Not fixed yet: `NGN` for a person with a naira wallet (a `FintavaWallet`
   row, the table the wallet gate reads).
3. Otherwise the country code the token's `phone` is written with: `+234`
   (also `00234`, or `234` and ten digits) is `NGN`, any other code is `USD`.
4. A phone with no country code (`0803...`, `(803) 555-0100`), no phone, or a
   `phone` claim that is not text: the token's `country` claim decides
   (`Nigeria`, `NG` or `NGA`, any case, is `NGN`; anything else or nothing is
   `USD`). Lead ruling N1, 8 Oct 2026: WAWU ID's web sign-up keeps the phone
   as typed and the dial code apart, so ten local digits cannot be read as
   Nigerian on their own.

**Fixed at the first purchase, never changed by a route.**
`BillingCurrencyService.fixAtFirstPurchase({ wawuUserId, phone, country,
purchaseRef }, tx)` is called by the purchase (TIER-03; POINTS-02 for a first purchase of
points) inside the transaction that records it. It inserts only when there is
no row (`ON CONFLICT DO NOTHING`) and answers the currency that holds, so a
repeated confirmation or two first purchases at once leave one currency, and a
purchase that rolls back fixes nothing. The purchase prices in the currency it
answers. Run it at READ COMMITTED (what every transaction in `src/` uses): at
REPEATABLE READ or SERIALIZABLE the losers of a race get Prisma `P2034`
instead, and the purchase must then be retried. No method and no route updates the row (a spec checks every write to
the table in `src/`); the owner's rule is "do not switch without support",
which is a person at WAWU changing it by hand, recorded as `fixedBy:
support`.

## 3. `GET /plans`

Signed in, `Cache-Control: no-store` (the answer is the caller's own). The plan in the caller's billing currency only: `currency`,
`currencyFixed`, `tiers`, `extraProducts`, `packs`, `checkoutBump`, `actions`
and `caps`. Every amount is `priceMinor`: whole minor units of `currency`
(kobo for `NGN`, cents for `USD`). The answer never holds the other
currency's figures: one price per item, picked by `priceIn` in
`plans-config.ts`. `tiers[].preselected` marks the tier VF5 shows selected
(Founding Maker in the example file). Referral and cash-out figures are in
the config for REF-01 and POINTS-04 and are not in this answer.

## 4. `GET /me/tier` (VF14)

Signed in, the caller's own only, `Cache-Control: no-store`. In the contract
`tier`, `eventPass` and `tier.badge` are `allOf` + `nullable` (they answer
null), and every number in both answers is `integer`
(`scripts/enrich-contract.js`, `src/plans` in both of its folder lists;
`plans-contract-shape.spec.ts` checks). `state` is:

| state | when |
|---|---|
| `none` | no tier was ever bought (no `MakerTier` row) |
| `active` | `activeUntil` is more than `tier_ending_days` days away |
| `ending` | still active, ending within `tier_ending_days` days |
| `ended` | `activeUntil` has passed; published products stay up, new publishing waits for a renewal (TIER-02) |

With `tier` (`id`, and `name` and `badge` from the config; both null if the
config no longer names that tier), `activeFrom`, `activeUntil`,
`productsAllowed` (the tier's products when bought plus `extraProducts`),
`productsUsed` (products published now, the count the publishing gate checks),
`pointsIncluded`, `firstVoiceIntroIncluded` and `eventPass` (the highest pass
the person holds, in the order of the config's `event_passes`).

## 5. What the tables hold

| Table | One row per | Written by |
|---|---|---|
| `PersonBilling` | person, once their currency is fixed | `fixAtFirstPurchase` (TIER-03) |
| `MakerTier` | person who ever held a tier | `TierGrantService` (JOIN-03's claim now; TIER-03's purchases call the same service), TIER-04 (extra products) |
| `EventPass` | grant that issued a pass (`purchaseRef` unique) | `TierGrantService` |

`MakerTier` copies what the tier gave when it was bought
(`productsIncluded`, `pointsIncluded`), so a later change to the config never
takes away what a person paid for. `MakerTierService` is the one reader: GET
/me/tier, the publishing gate (TIER-02, `hasActiveTier`) and the purchases ask
it. All three tables are in the account purge (OWNED) and the data export
(without payment references).

## 6. Publishing needs a tier (TIER-02)

Task TIER-02, R-43: "Anyone can sign up, build a profile and draft products
free. Publishing, or uploading any file, needs an active tier, and published
products never exceed the tier's products plus any extra products bought."

**What a person may publish** (`PublishingAllowanceService.of`, the one place
that answers it; the gate, `GET /me/tier` `productsUsed`, `GET /creator/state`
`slotsTotal`, `GET /uploads/allowance` and the admin creator, KYC and content
screens all read it):

| they hold | products allowed | storage for content |
|---|---|---|
| a running tier (`active` or `ending`) | the tier's products plus `extraProducts` | 10 GB |
| a verification tick that has not ended | 25 (the tick-era cap, kept for people who paid before tiers) | 10 GB |
| both | the larger of the two, not the sum | 10 GB |
| neither (never had a tier, the tier ended, the tick lapsed) | 0: `tier_required` | 1 GB (nothing can be uploaded) |

An ended tier or a lapsed tick only stops the next publish or file. Nothing
published is unpublished or hidden, and it still counts in `productsUsed`.
Storage for a person on a tier is R-7's with-a-tick figure: tiers replace
the tick and nothing in the plan sizes storage (Default (agent), owner may
override).

**What counts.** A product is a content piece waiting for review or live
(`CreatorState.slotsUsed`, the counter every publish claims against with a
conditional update, so two publishes at once cannot pass the limit). A draft
does not count. A piece that is removed (`DELETE /content/:id`), turned down
or taken down gives its place back; sending a turned-down piece again takes
one. Removal is the unpublish: there is no route that turns a live piece back
into a draft, because a draft holds no file. A piece gives its place back
once, however many requests remove it at the same moment: the removal changes
the row conditionally on the status it read, only the request that changed it
frees the place, and the others answer `404`, as a repeat removal does. A
person's counter row is made insert-or-nothing before the first claim, so two
first publishes sent together both succeed.

**The refusal.** `402`, the contract's one error shape (CONVENTIONS section
3), `reason.code`:

- `tier_required`: no running tier and no tick that has not ended.
  `tierState` is `none` or `ended`.
- `product_limit_reached`: every product they may have is published. The
  `message` names only the ways on that the answer carries: both ("Add more
  products or move up a tier") while a higher tier and extra products are
  offered, one of them when only that one is, and the limit alone ("You've
  used all 25 of your product places.") for a tick holder at the tick-era cap,
  where nothing can be bought. The number is the allowance.

`reason` is flat: `code`, `message`, `tierState`, `productsUsed`,
`productsAllowed`, and the offers `currency`, `tiers`, `extraProducts` (absent
only when the Hub could not read the plan at that moment; the app then shows
`message` alone). The
offers are the figures `GET /plans` answers, in the person's billing currency
only: for `tier_required` every tier; for `product_limit_reached` the tiers
that allow more products than the one they hold (none when they hold the top
one, or only a tick), and `extraProducts` (`count`, `priceMinor`) while they
hold a running tier, else `null`. The routes' interceptor
(`PublishingOffersInterceptor`) adds them, because only the route knows whose
token, and so whose currency, asked.

**The routes** (`publishing-gate-coverage.spec.ts` holds this list to the
code):

| Route | Asks |
|---|---|
| `POST /content` | a way to publish, then a free place |
| `POST /content/:id/resubmit` | the same (it takes a place) |
| `PATCH /content/:id` | a way to publish, when the body carries `previewAsset` or `fullAsset` (the piece has its place already) |
| `POST /uploads/presign` | the same as `POST /content`, when `folder` is `content/preview` or `content/full`. Every other folder (an avatar, a cover, an identity or professional document, a banner, a chat or community picture, a featured work) is not a product and is never asked |
| `POST /product-drafts/:id/publish` | the same as `POST /content` |

Not gated, and why: `PUT /content/:id/media` and `/preview` take links to
files `POST /uploads/presign` already accepted; events (E21's tier is its own
task); featured works and the professional listing are profile content, not
products; the shop has no creator route (R-2); learn guides are written by
admins.

**Drafts** (`src/content-piece/product-draft.*`, creator accounts, free, no
tier asked): `POST /product-drafts` (a title; everything else optional),
`GET /product-drafts`, `GET`, `PATCH` and `DELETE /product-drafts/:id`, and
`POST /product-drafts/:id/publish` (the two file links). A draft has no
file, holds no place and is shown to nobody else. `missing` lists what
publishing still needs (`contentType`, `description`, `category`,
`accessType`, and `price` for a paid product). Publishing asks the gate first
(so Publish opens the offers), then finishes the draft check
(`400 draft_incomplete`), then creates the piece and deletes the draft in one
transaction. A person keeps at most `PRODUCT_DRAFTS_MAX` drafts
(`PROVISIONAL(PRODUCT-DRAFTS-MAX)`; `409 draft_limit_reached`), counted under
a per-person lock, so drafts sent together cannot pass it.

## 7. Granting a tier (JOIN-03)

`TierGrantService.grant(tx, { wawuUserId, tierId, sourceRef, days?, now? })`
(`src/plans/tier-grant.service.ts`, exported by `PlansModule`) is the one place
a tier is granted. Inside the caller's transaction it writes the tier and its
dates on `MakerTier` (copying products and bonus points from the config), the
`EventPass` (its `purchaseRef` is `sourceRef`), the first-Voice-Intro flag, and
the bonus points as one `tier_bonus` lot through `PointsService.grant`
(`sourceRef` again), last. One person's grants run one at a time (a transaction
advisory lock on `tier:<wawuUserId>`), and a `sourceRef` grants once: asked
again it finds its own pass and writes nothing (`granted: false`).

Default (agent), owner may override: a person with no tier, or whose tier ended,
gets the tier from the moment of the grant for `days` days (the tier's own days
when omitted); a person whose tier has not ended keeps it, whichever tier it
is, and the days are added to its current end. Upgrades, downgrades and the
price are a purchase's rules (TIER-03) and sit on top.

JOIN-03's `POST /waitlist/claims` calls it with `sourceRef` `join:<registration
id>` and the offer's `tier_days`. It proves the caller holds the registration's
phone or email as WAWU ID proved it: the access token's `phoneVerified` and
`emailVerified` (BACKEND_GAPS G-634 in the mobile repo; WAWU ID sends neither
until that change merges, and until then every claim answers
`contact_not_verified`). WAWU ID's `phoneVerified` is true only while the number
the sign-up code was texted to is still the account's phone, so a number written
later through WAWU ID's internal phone-change routes is not vouched for.

A claim is idempotent for its own claimer (round 2): the answer it gave
(`offerName`, `days`, `extended`, `pointsGranted`, `pointsExpireAt`) is kept on
the registration (`claimResult`, written in the claim's own transaction), and
the same account sending the same code again is answered with it as a 200 (the
`tier` read fresh, as `GET /me/tier` answers) with nothing granted a second
time. Any other account is told `already_claimed`. A row claimed before the
answer was kept has none, and answers its claimer `claimed_by_you` (409).

The answer also carries `claimedAt` (ISO 8601, round 3): when the code was
claimed, read from the registration's own stamp, so a repeat says the time of
the first claim and never its own. The plan the answer shows can have begun or
ended since; the app tells the person what is true from `claimedAt` and `tier`
(a plan that has ended is not "ready"). The field is additive and always
present on a 200.

