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
| `MakerTier` | person who ever held a tier | `TierGrantService` (JOIN-03's claim, TIER-03's purchases), TIER-04 (extra products) |
| `EventPass` | grant that issued a pass (`purchaseRef` unique) | `TierGrantService` |
| `MakerPurchase` | paid purchase of a tier from the wallet (key: the wallet payment's id) | `PlanPurchaseService` (TIER-03), in the transaction that grants |

`MakerTier` copies what the tier gave when it was bought
(`productsIncluded`, `pointsIncluded`), so a later change to the config never
takes away what a person paid for. `MakerTierService` is the one reader: GET
/me/tier, the publishing gate (TIER-02, `hasActiveTier`) and the purchases ask
it. All four tables are in the account purge (OWNED) and the data export
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
frees the place, and the others answer `404`, as a repeat removal does. The
admin decisions keep the same rule (round 3): a take-down reads the piece's
status inside its transaction and changes the row only if it is still in that
status, a reject or an approve only if it is still waiting, and a request that
finds the status moved reads again and acts on what is true. So a turned-down
piece that is then taken down returns no second place, and a turned-down piece
the creator sent again, then taken down, returns the place it took. A
person's counter row is made insert-or-nothing before the first claim, so two
first publishes sent together both succeed.

**The refusal.** `402`, the contract's one error shape (CONVENTIONS section
3), `reason.code`:

- `tier_required`: no running tier and no tick that has not ended.
  `tierState` is `none` or `ended`. A person who still has products up (the
  tick or the tier ended) and for whom no tier would leave a place is not told
  to pick one: "You have 12 products up and no plan has room for another.
  Remove some to publish." (with "Your tier has ended." in front when it
  has), and `tiers` is empty (round 4, D7). A person whose tier has ended is
  told to renew it ("Your tier has ended. Renew it to publish or upload
  files. Everything you published stays up.") only when that tier is among
  the `tiers` offered; otherwise the sentence says what would work, with the
  tier's name and the products up from the data: "Your Verify plan has ended.
  You have 5 products up, and a bigger plan has room for them." (round 5,
  D8; renewing a tier that holds no more than the products already up would
  have been refused). The tier that ended is not in the body.
- `product_limit_reached`: every product they may have is published. The
  `message` names only the ways on that the answer carries: both ("Add more
  products or move up a tier") while a higher tier and extra products are
  offered, one of them when only that one is, and the limit alone ("You've
  used all 25 of your product places.") for a tick holder at the tick-era cap,
  where nothing can be bought. The number is the allowance. A person with MORE
  products published than they are now allowed (a tick ended with 25 up, then
  Verify was bought) is told both numbers: "You have 25 products and your plan
  allows 3. To publish another, remove some." with ", or add more places"
  only while an offer in the answer would really let another go up (round 3).

- `identity_paused` (403, S7 round 2): the person's identity check is paused,
  so nothing is published or accepted for a product until it passes. It is
  asked after the tier and before the room. `reason` is `code`, `message`
  (the Hub's sentence: "Publishing is paused until your identity check
  passes." and then what went wrong and what to do, from the wallet's own
  review) and `stage`, the same word as `review.stage` on `GET /money/wallet`
  (`needs_documents`, `rejected`, `stopped`, `expired`). Uploading the ID
  document itself is never refused. No offers.

`reason` is flat: `code`, `message`, `tierState`, `productsUsed`,
`productsAllowed`, and the offers `currency`, `tiers`, `extraProducts` (absent
only when the Hub could not read the plan at that moment; the app then shows
`message` alone). The
offers are the figures `GET /plans` answers, in the person's billing currency
only, and only what would let another product go up: the tiers that, once
bought, leave more places than the person has products published (extras
bought carried over). For `tier_required` that is every tier for someone with
nothing published, and only the tiers big enough for everything they have for
someone who still has products up, often none (round 4, D7; round 3 offered
every tier). For `product_limit_reached`, at the limit, it is the tiers above
the one they hold, and none when they hold the top one or only a tick; above
their allowance, only the tiers big enough for everything they have, often
none. `extraProducts` (`count`, `priceMinor`) while they hold
a running tier and the pack lifts it above what is published, else `null`. The routes' interceptor
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

## 8. Buying, renewing and upgrading a tier from the wallet (TIER-03)

Task TIER-03, R-43, R-44. A person pays for a tier from their wallet
(VF5 to VF7). It is WAWU's own sale, so the price goes into WAWU's own account
at the wallet provider in one debit with no seller split, nothing is held
(R-19 is for money owed to someone else), and the provider's charge is added
on top as on every purchase (R-10). Wallet payments are MONEY-17's; this
section is what a tier adds. Anyone paying needs an open wallet: a person
without one is answered `409 wallet_not_open` before anything else (MONEY-13),
and the PIN is MONEY-09's (five wrong tries lock it).

### The routes

| Route | Does |
|---|---|
| `GET /plans/purchases/quote?kind=&tierId=&bump=` | The pay sheet (VF6) before the PIN. `kind` is `tier` (a first purchase, or after the last one ended), `renew` (the tier held, again) or `upgrade` (to a bigger tier than the one running). `bump=true` adds the checkout bump (extra points, `GET /plans` `checkoutBump`). Answers `PlanPurchaseQuoteView`: the plan priced (`planMinor`, `bumpMinor`, `bumpPoints`), the `paymentKind` and `payment`, the wallet payment's own quote (price, the provider's charge, total, balance, shortfall and the signed `quoteToken`). Nothing is reserved. |
| `POST /plans/purchases` | Pays. Headers `Idempotency-Key` (required) and `X-Transaction-Pin` (or a biometric approval, MONEY-14). Body: `kind`, `tierId`, optional `bump`, `method: "wallet"` or `"transfer"` (below), `expectedTotalKobo` and `quoteToken` from the quote. Answers 201 with a `PlanPurchaseView`. |
| `GET /plans/purchases/{id}` | One purchase as it stands now; `id` is the purchase's id (below). The caller's own only: another person's purchase, a payment of another kind and an id nobody holds are the same `404 not_found`. Reads WAWU's records only. `Cache-Control: no-store`. |

`POST` pays through `POST /money/payments`' own code (quote check, balance
read, limits, the provider's transfer, the sweep that settles a lost answer),
so every answer of that route reaches this one unchanged: `402
insufficient_funds` with `balanceKobo`, `totalKobo` and `shortfallKobo`
(nothing is granted; the key is given back), `409 quote_changed`, `403
limit_reached`, `503 fees_not_set` and the PIN codes. Taps: the same
Idempotency-Key and body answer the first result again
(`Idempotent-Replayed: true`, no PIN checked); under another key a second tap
is `409 payment_in_progress` while the first is going through, and
`409 target_not_payable` ("You already have a plan running") once it has been
granted.

### The purchase (`PlanPurchaseView`)

`id` is the wallet payment's id (`payment.id`): a purchase is identified by its
payment, so a poll needs nothing the app does not already have. `status`:

| `status` | Meaning | `grant` |
|---|---|---|
| `paid` | The provider confirmed the debit and the tier was granted. | what it gave |
| `pending` | The provider has not confirmed the debit yet (`payment.status` `pending`, `statusMessage` "We're still confirming this payment. Don't pay again; we'll let you know."), or it is confirmed and the tier is being opened (`payment.status` `completed`, `payment.delivered` false, "Your payment went through and we're finishing it. Don't pay again."). Poll `GET /plans/purchases/{id}`; the sweep settles it. | null |
| `failed` | The provider refused it; nothing moved (`statusMessage` is the reason). | null |
| `reversed` | The money went back to the buyer; nothing was granted. | null |
| `refunded` | The payment was confirmed but the plan could no longer be granted as quoted (below), so nothing was granted and the price is going back to the buyer's wallet (`statusMessage` "We could not give you this plan, so ₦4,000.00 is on its way back to your wallet. The charge on your first payment is not returned.") or has gone back ("We could not give you this plan, so ₦4,000.00 is back in your wallet. The charge on your first payment is not returned."). The figure is the price the hold holds (the payment's `priceKobo`: the plan's price or the upgrade's difference, plus the bump), in naira with two decimals; the provider's charge on the original payment is not returned (R-10), and WAWU pays the charge on the refund (R-31). The buyer may buy again at once. | null |

The first answer and every replay of its key are the same body: the answer
stored under the key is this view, built when the payment first has an answer
(`WalletPaymentService.presentRoute`), not the bare payment. `grant` (once
paid): `tier` (id, name, badge), `activeFrom`, `activeUntil`, `productsAllowed`,
`bonusPoints` and `bonusPointsExpireAt` (the lot this purchase added; 0 and
null when it added none), `bumpPoints` and `bumpPointsExpireAt` (the bump's
lot), `eventPass` (the pass this purchase issued) and
`firstVoiceIntroIncluded`. The tier's fields are read as the tier stands when
asked (a later renewal moves `activeUntil`); the lots and the pass are this
payment's own, read by its reference. Amounts are `amountMinor` (the plan's
price, or the upgrade's difference, plus the bump's, in the minor unit of
`currency`; never the provider's charge) and the payment's kobo fields.

### Paying by bank transfer (`method: "transfer"`, TIER-05)

VF6 "transfer details shown" and PT4. `POST /plans/purchases` with `method:
"transfer"` takes the same body, headers and checks as `wallet` (the PIN, the
quote token and `expectedTotalKobo`; `409 quote_changed`, `409
target_not_payable`, `503 provider_unreachable` when the balance cannot be
read) and moves no money. It answers 201 with a `PlanTransferOrderView`:

| Field | Meaning |
|---|---|
| `status` | `awaiting_transfer` (the money has not covered the total yet), `pending` (it landed and the wallet payment is being made), `expired` (the time to send ran out), `failed` (it cannot be made any more; `statusMessage` says why). `payment`, `grant` and `paidAt` are null. |
| `transfer` | While `awaiting_transfer`: the person's OWN wallet account (`accountNumber`, `accountName`, `bankName`, `bankCode`; R-42: money in is a transfer into the person's own account number, WAWU has no collection account), `priceKobo`, `bankChargeKobo` (the label is "Bank charge", R-10, R-53), `totalKobo` (price plus Bank charge), `balanceKobo` (the provider's available balance now; null when it did not answer), `amountNeededKobo` (total less balance, never below 0; null when the balance is unknown) and `expiresAt`. |

The purchase is paid from the wallet, once, through the same wallet payment as
`method: "wallet"` (so the grant, the checks and the refund path are the same),
when the provider's available balance covers the total. The Hub looks within
seconds of a credit reaching the wallet (a money-in row of the ledger, WALLET-10)
and again every few minutes; a balance is never a sum of our rows. Rules:

- **One payment per purchase.** Several transfers, one landing twice, a sweep
  and another server finding it together, or a later transfer pay it once.
  Money that arrives after it is paid stays in the wallet.
- **The quote binds.** The order keeps the price, the Bank charge total and
  the goods confirmed with the PIN. If any differs when the money lands (the
  price or the goods were changed in admin settings) the purchase is closed
  (`failed`, "The price or what comes with it changed...") and nothing is taken.
- **The window** is the admin setting `plan.transfer_window_hours` (default 24,
  PROVISIONAL(PLAN-TRANSFER-WINDOW)). After it the purchase is `expired`; the
  money stays in the wallet and nothing is taken. A purchase whose payment was
  already made is never expired: it reads `paid`.
- **Every waiting purchase is looked at.** However many purchases wait, one
  whose money has landed is settled on the next pass, not after the older ones
  expire.
- **A refused payment waits again.** When the wallet payment is refused and
  nothing moved, the purchase stays `awaiting_transfer` (`statusMessage` says
  so) and is tried again later, once, as a payment of its own; if the window
  has run out by then it is `expired`.
- **Oldest first.** One person's waiting purchases are paid oldest first, each
  only while the balance, read again before each, covers its total.
- **One waiting purchase per item.** Asking again for the same item closes the
  first (`failed`, "You started this purchase again..."); paying the item from
  the wallet meanwhile closes it too ("You paid for this another way...").
- **Nothing is taken without the PIN given at checkout**: the order is placed
  behind the PIN, and what is paid later is exactly that quote.

`GET /plans/purchases/{id}` reads the order under the id it was given; once the
wallet payment exists the same id reads a `PlanPurchaseView` with `method:
"transfer"` (`paid`, or `pending` while the provider confirms), and the payment's
own id reads it too.

### What a purchase is paid as

A wallet payment of kind `tier` (the plan alone) or `tier_bump` (the plan and
the checkout bump, one debit, one confirmation, so a person never has the tier
without the points they paid for). The payment's `targetId` carries the terms
and is frozen when the payment is claimed:

| `targetId` | Terms |
|---|---|
| `tier-<tierId>` | a first purchase of `<tierId>` |
| `renew-<tierId>` | the tier held, again |
| `upgrade-<fromTierId>-<tierId>` | from the tier running now to a bigger one |

Tier ids are lower-case letters, digits and `_`, so `-` never appears inside
one. `GET /money/payments/quote?kind=tier&targetId=tier-founding` is the same
quote as `GET /plans/purchases/quote`, which builds the target for the app (an
upgrade's `<fromTierId>` is the tier the person runs now; if it changes
between the quote and the purchase, the quote no longer fits and the answer is
`409 quote_changed`). The payment is priced from the config at the person's
billing currency: a person billed in dollars is refused `409
target_not_payable` ("This isn't priced in naira...") until a dollar wallet
can pay it (NUV-09), so cents are never charged as kobo.

### Rules (Default (agent), owner may override)

- **Price.** The tier's config price; an upgrade pays the DIFFERENCE of the
  two config prices; the bump adds its config price. Nothing here writes a
  figure (`plans-figures.spec.ts` looks).
- **`tier`** only for a person with no tier or an ended one. A running tier
  (`active` or `ending`) is `409 target_not_payable`, "Renew it or upgrade it
  instead".
- **`renew`** only for the tier held, in any state. The new period starts
  where the running one ends; a tier that ended starts again now.
- **`upgrade`** only from a running tier to a tier that costs more. No
  downgrade while a tier runs. The new period starts TODAY for the new tier's
  own days (the old tier's remaining days are not carried over), the unused
  points stay, and the bonus points granted are the difference of the two
  tiers' bonuses, as one lot with the new tier's expiry.
- **Extra products stay.** The extra products a person paid for (TIER-04)
  stay on every new period: a renewal of a running tier, an upgrade, a renewal
  of an ended tier and a first purchase after the tier ended all keep
  `MakerTier.extraProducts`, so `productsAllowed` (the tier's products plus the
  extras) never falls because a plan was bought. Only a first-ever purchase
  starts at none. TIER-02's `tier_required` offers ignore an ended tier's
  extras, so they promise less than a purchase gives (the safe side); TIER-04
  aligns them. Pinned by `plan-purchase-grant.contract.spec.ts`.
- **One plan payment at a time per person.** A payment for another plan (or
  the same plan with or without the bump) that is still confirming, or paid
  and not yet opened, is `409 payment_in_progress` with its `paymentId`. It is
  checked again inside the payment's claim, so of two requests at once at most
  one goes on.

### What is granted, and once

When the provider confirms the debit (in the request, or from the sweep when
the answer was lost, on any server), one transaction at READ COMMITTED
(`fixAtFirstPurchase` needs it) does, in this order:

1. takes the person's tier lock;
2. if the payment is already being paid back (below), it is not granted;
3. inserts the `MakerPurchase` row, whose primary key is the payment's id: if
   it is already there the payment was granted and nothing else happens;
4. fixes the billing currency (`PersonBilling`, `first_purchase`, the payment's
   reference); a person fixed in another currency than the one paid is not
   granted;
5. grants through `TierGrantService` (`grant`; `upgrade` for an upgrade): the
   tier and its dates (`activeFrom` is now, never later), the event pass, the
   first Voice Intro, the bonus points as one lot with its expiry;
6. grants the bump's points as a `bump` lot (expiry: `points.bought_expiry_days`),
   last, as POINTS-01 asks of every caller: after the first points write, the
   transaction writes nothing but points (`plan-purchase-grant.contract.spec.ts`
   reads the statements).

A repeat, a second server, or the request and the sweep together find the row
and write nothing.

### A plan that cannot be granted is paid back (round 2)

A purchase that no longer fits what the person holds when the payment confirms
is NOT granted, and nothing is written for the grant (the transaction rolls
back). It fits not when: the tier an upgrade came from ended while the
payment confirmed (the lost answer, a late webhook) or is no longer the one
held; another tier was granted meanwhile (an event code claimed in the app,
JOIN-03; a change by support); the renewal's tier is not the one held; the
billing currency was fixed another way; or the plans file no longer names the
tier. The whole price then goes back to the payer through MONEY-18's refund
(`WalletHoldService.refund`; CONVENTIONS.md section 18):

- A tier payment is WAWU's own sale and is not a held kind, so it has no
  `WalletHold`. One is written for it only here (`releaseCondition`
  `plan_granted`, the payment's price and shares, the payee null), under the
  person's tier lock, and the refund is asked for at once. Exactly one of the
  two outcomes can happen to a payment: the purchase row (granted) or the hold
  (paid back). A delivery that finds the other's mark does nothing more, and a
  payment already being paid back is never granted later, even if the tier
  would now fit.
- The money moves once, one way: a send from WAWU's account to the payer's
  wallet under our reference `wawu-ref-<hold id>`, which the provider refuses
  to repeat; a lost answer is asked about and never sent again; a payer with
  no wallet or a frozen one waits (MONEY-18). The **price** comes back; the
  provider's charge on the original payment does not (R-10), and the
  provider's charge on the refund move is WAWU's (R-31).
- The delivery then returns normally: the payment is delivered, its claim is
  given up and the buyer may buy again at once (no `payment_in_progress`),
  even while the refund is still on its way. The purchase reads `refunded`.
  `GET /money/holds` lists the hold like any other (its payer reads it).
- Anything else that goes wrong in the delivery (the database, a points
  conflict, a date out of range) still throws: the payment service tries
  again with its backoff and sends it to review after
  `PAYMENT_REVIEW_AFTER_HOURS`, the money in WAWU's account (BACKEND_GAPS
  G-680).

### Not built here

Extra products (TIER-04), the Voice Intro itself, the Founding Maker's badge
number (BACKEND_GAPS G-421) and the dollar wallet path (NUV-09).


---

## 9. Referral points: invite, claim and earn (REF-02)

A person shares `wawu/r/<code>`; someone new uses it; when that person's first
paid tier is granted, the person who invited them earns points (never cash)
after a hold. Code: `src/referrals/`, mounted through `MeModule` (as
`me/points`) and imported by `PlanPurchasesModule` for the hook. Not to be
confused with REF-01's `ReferralCode` (the `/join` registration link, a price
for a community): the two tables never share a row, and a person's code is
never one a `/join` code already uses.

- **`GET /me/referrals`** (RF1, RF3, RF4; `no-store`; the token is the person):
  `link`, `code` (made the first time, from the first name), `brought`,
  `verified` (rewards past the hold), `pending` and `pendingPoints` (in the
  hold), `pointsEarned` (rewards plus milestones; not the balance),
  `multiplier` (what a new reward earns now), `level` (levels reached, 0 before
  the first), `ladder` (`verified`, `multiplier`, `reached` per level),
  `nextMilestone` (`verified`, `points`, `remaining`, or null), `milestones`
  (all, with `reached`, `grantedAt`), `holdDays`, `claimDays`, and the newest
  20 `rewards` (`name`, `tierName`, `basePoints`, `multiplier`, `points`,
  `state` `pending|available|cancelled`, `availableAt`, `settledAt`). The
  reward becoming `available` is how the Hub says points arrived (RF3, RF3a).
- **`POST /me/referrals/claim`** `{ code }` (the code or the link, any case):
  200 `{ code, claimedAt }`. Once per person (the same code again answers the
  first claim; another is `409 referral_already_claimed`), within
  `referral.claim_days` of sign-up (`409 referral_claim_closed` with
  `claimDays`), before any tier was paid (`409 referral_not_new`), never your
  own (`400 referral_own_code`), never the code of someone you invited
  (`409 referral_loop`), `404 referral_code_unknown`. One level only: only the
  person whose code was used can earn from the claim.
- **The reward** (`ReferralReward`, at most one per referral, enforced by a
  unique key): made by `ReferralRewardService.onTierPaid` after the purchase
  commits (and by the job's catch-up for one it missed), for the invited
  person's earliest paid tier: base points of that tier times the multiplier at
  the referrer's `verified` count then, whole points. The figures are copied
  onto the row, so a setting changed during the hold changes nothing pending.
  A referrer with no running tier gets a row already `cancelled`
  (`referrer_no_tier`): "only a referrer with an active tier earns".
- **Paid after the hold** by the minute job (`ReferralSweepService`): under the
  referrer's lock, a reward is `cancelled` when the tier payment was refunded
  (a refund hold written for it, the payment `reversed`, the purchase row gone,
  or `cancelForPurchase(paymentRef)` called by a refund path) or the referrer
  held no tier when the hold ended; otherwise `granted` with a POINTS-01 lot
  (`source` `referral`, `sourceRef` `reward:<id>`, ends after
  `points.expiry_months`), then the milestones the new `verified` count
  reaches, each once per person (`sourceRef` `milestone:<referrer>:<count>`).
  The points are the last writes of the transaction. Nothing waits on a
  provider or any network while a transaction or lock is held.
- **Settings** (TIER-06, `/admin/plan-settings`, read live): `referral.multipliers`,
  `referral.milestones` (launch: 5 verified +500, 10 verified +1,500; the
  25-verified step is off), `referral.hold_days`, `referral.claim_days`,
  `referral.base_points.<tier>`, `points.expiry_months`.
- **Default (agent), owner may override:** `verified` counts rewards past the
  hold (RF1 draws Verified and Pending apart); a code is refused to someone who
  already paid for a tier; a referrer whose tier ended before the hold did
  loses the reward; the claim window runs from the profile's creation.

## 10. Buying a points pack (POINTS-02)

Task POINTS-02, R-43, R-44, R-65. A person buys a points pack (PT4) from their
wallet or by bank transfer, on the routes section 8 describes, with
`kind: "points_pack"` and a `packId` (a `GET /plans` `packs[].id`) in place of
`tierId`. It is WAWU's own sale: one debit into WAWU's own account, no seller
split, nothing held, and the provider's charge on top, shown as the Bank
charge (R-10). The pack's price, its points, how long bought points last and
the Founding bonus are admin settings (TIER-06): `plan.pack.<id>.price_kobo`,
`plan.pack.<id>.points`, `points.expiry_months` and
`plan.tier.<id>.pack_bonus_pct`. None is written in code.

| Route | Does |
|---|---|
| `GET /plans/purchases/quote?kind=points_pack&packId=` | The pay sheet (PT4) before the PIN. Answers a `PointsPackQuoteView`: `packMinor` (the price), `points`, `bonusPercent` and `bonusPoints` (the Founding Maker's extra points; 0 for anyone else), `totalPoints`, `expiryDays`, `paymentKind` (`points_pack`) and `payment`, the wallet payment's own quote. Sending a `tierId` or `bump` with it is `400`; so is a `packId` on a tier kind. A pack the file does not name is `404 target_not_found`. |
| `POST /plans/purchases` | Pays, with the quote's `expectedTotalKobo` and `quoteToken`, `method: "wallet"` or `"transfer"`, `Idempotency-Key` and the PIN, exactly as for a tier. Answers 201 with a `PointsPackPurchaseView`. |
| `GET /plans/purchases/{id}` | The same purchase as it stands now (the app polls it after `pending`). |

`PointsPackPurchaseView` (`kind: "points_pack"`) is one shape from the ask to
the points being added: `id`, `packId`, `method`, `currency`, `amountMinor`
(the price, never the provider's charge), `points` and `bonusPoints` (as
quoted), `status`, `statusMessage`, `payment` (null until the money is taken),
`transfer` (set while `awaiting_transfer`: the same `PlanPurchaseTransferView`
section 8 describes), `grant` and `paidAt`. `status`:
`awaiting_transfer` (bought by transfer, the money has not landed),
`pending` (confirming, or the points are being added, or the money landed and
the wallet is being charged), `paid`, `failed`, `reversed`, `expired`. `grant`
(once `paid`): `points`, `bonusPoints`, `totalPoints` and `expiresAt`.

- **The payment.** Kind `points_pack`, `targetId` `pack-<packId>`. The same
  payment is reachable through `GET /money/payments/quote` and `POST
  /money/payments`.
- **The bonus.** A person whose tier is running (`active` or `ending`) and
  whose tier has `pack_bonus_pct` above 0 gets that percent of the pack's
  points on top, rounded down to a whole point ("Founding shows +10%"). A
  person with no tier, an ended tier or a tier with 0 gets none. The price is
  the pack's: the bonus costs nothing more.
- **The quote binds price and goods.** The pack, its points, the bonus and the
  expiry are the payment's terms. A quote whose price, points, bonus or
  expiry changed since it was given is `409 quote_changed`, before anything
  moves. The payment keeps them from the claim, so a setting changed while it
  confirms, or while a transfer waits, does not change what is added; a
  transfer whose terms changed before the money lands is closed with nothing
  taken.
- **Once.** The lot is keyed (`pack`, the payment's id) in the points
  service: a repeated delivery, a replayed key or two servers add nothing
  more. The lot is the size of `totalPoints` and ends after the bought-points
  expiry; it is added last in a transaction that does nothing but write the
  database, so nothing is held across a provider call. A first purchase also
  fixes the person's billing currency (section 2).
- **By transfer.** TIER-05's order: it waits for the money to reach the
  person's own wallet account and is paid from the wallet, once, when the
  balance covers the total. A pack order and a plan order wait side by side;
  a wallet purchase of the same pack closes a waiting order.
- **Naira only at launch (R-16).** Only naira packs are sold. A person billed
  in dollars is priced from the file's dollar column and refused `409
  target_not_payable` by the payment service until a dollar wallet can pay
  (NUV-09); no dollar pack is drawn or sold.
- **The cash rate counts the bonus.** The rule that stops points being cashed
  out for more than they were sold for (`points.cash_rate_kobo_per_1000`, the
  cheapest sale decides) counts a pack with the largest bonus any tier gives:
  a rate that fits the pack alone but pays more than a Founding buyer paid for
  the same points is refused, naming the percent setting. A change to any
  tier's percent is judged by the same rule.

## 11. Adding more products (TIER-04)

Task TIER-04, R-43, R-44, R-65. A person at their limit adds more products
instead of upgrading (VF13: "You have used 3 of 3. Add 5 more for ₦1,500 or
upgrade"). It rides the routes section 8 describes, with `kind:
"extra_products"` and no `tierId`, `packId` or `bump` (sending one is `400`).
It is WAWU's own sale: one debit into WAWU's own account, no seller split,
nothing held, and the provider's charge on top, shown as the Bank charge
(R-10). How many products one add-on holds and its price are admin settings
(TIER-06, R-65): `plan.extra_products.count` and
`plan.extra_products.price_kobo`. None is written in code.

| Route | Does |
|---|---|
| `GET /plans/purchases/quote?kind=extra_products` | The pay sheet (VF13) before the PIN. Answers an `ExtraProductsQuoteView`: `extraMinor` (the price), `products` (how many it adds), `productsAllowed` (the places the person has now) and `productsAllowedAfter` (with the add-on), `paymentKind` (`extra_products`) and `payment`, the wallet payment's own quote. |
| `POST /plans/purchases` | Pays, with the quote's `expectedTotalKobo` and `quoteToken`, `method: "wallet"` or `"transfer"`, `Idempotency-Key` and the PIN, exactly as for a tier. Answers 201 with an `ExtraProductsPurchaseView`. |
| `GET /plans/purchases/{id}` | The same purchase as it stands now (the app polls it after `pending`). |

`ExtraProductsPurchaseView` (`kind: "extra_products"`) is one shape from the
ask to the products being added: `id`, `method`, `currency`, `amountMinor` (the
price, never the provider's charge), `products` (as quoted), `status`,
`statusMessage`, `payment` (null until the money is taken), `transfer` (set
while `awaiting_transfer`: the same `PlanPurchaseTransferView` section 8
describes), `grant` and `paidAt`. `status`: `awaiting_transfer`, `pending`,
`paid`, `failed`, `reversed`, `expired`, as for a points pack (section 10).
`grant` (once `paid`): `productsAdded` (this purchase), `extraProducts` (all
the extras bought on the account, as they stand now) and `productsAllowed`
(the tier's own plus the extras, as they stand now).

- **The payment.** Kind `extra_products`, `targetId` `extra-products`. The same
  payment is reachable through `GET /money/payments/quote` and `POST
  /money/payments`.
- **Needs a running tier.** A person whose tier is `active` or `ending` can
  buy. With no tier, or an ended one, the quote and the purchase answer `402
  tier_required` (CONVENTIONS section 23) and nothing is taken or kept. A
  person with an open wallet and no tier is told this, not that the wallet is
  missing: the wallet is checked first, as for every purchase.
- **The quote binds price and count.** The number of products is the
  payment's terms. A quote whose price or count changed since it was given is
  `409 quote_changed`, before anything moves. The payment keeps them from the
  claim, so a setting changed while it confirms, or while a transfer waits,
  does not change what is added; a transfer whose price or count changed
  before the money lands is closed with nothing taken.
- **Once.** The purchase row is keyed by the payment's id
  (`MakerExtraProducts`: `products` as quoted, `tierId` the tier held when it
  was paid, the price and the currency): a
  repeated delivery, a replayed key or two servers find it and add nothing
  more. The count is added to the tier row's `extraProducts` last in a
  transaction that does nothing but write the database, under the person's
  tier lock, so nothing is held across a provider call. A second add-on is a
  second purchase and adds the count again.
- **What is bought stays with the account.** `extraProducts` lives on the tier
  row, which a renewal, a new tier bought after the last ended and an upgrade
  leave alone. The publishing gate (section 6) counts it whenever the person
  holds a tier: `productsAllowed` is the tier's own products plus the extras.
  While no tier runs nothing can be published, and the extras wait. A payment
  that confirms after the tier ended is still added (the person paid for it),
  and counts from the next tier.
- **By transfer.** TIER-05's order: it waits for the money to reach the
  person's own wallet account and is paid from the wallet, once, when the
  balance covers the total. If the tier ends while it waits, the order is
  closed with nothing taken (`status: "failed"`, with the sentence in
  `statusMessage`).
- **Naira only at launch (R-16).** A person billed in dollars is priced from
  the file's dollar column and refused `409 target_not_payable` by the payment
  service until a dollar wallet can pay (NUV-09).
- **Default (agent), owner may override.** The add-on can be bought again and
  again, and also when the places it adds would still leave fewer than the
  person has published (the gate's offers leave it out then, section 6; a
  direct call is not refused, and the places count when more is allowed).


## 12. The AI tools catalogue and VoiceOver (AITOOLS-01)

Task AITOOLS-01, R-43, R-61, R-65, R-68. Studio (PT1) lists the AI tools the
Hub can run, each with its points cost before use. VoiceOver (PT2) turns text
into audio. A job costs points (a count, never naira): POINTS-03 holds them
before the voice provider is asked, keeps them when the audio is made and gives
them back when it is not. No route here moves naira. The app draws only the
tools `GET /ai-tools` lists (R-47); each later tool is added to that list with
the code that runs it, one task each.

| Route | Does |
|---|---|
| `GET /ai-tools` | `{ tools, caps }`. A tool: `id` (`voiceover`), `action` (the plan's action id, what `POST /points/quote` takes), `name`, `description`, `unit` (`minute`), `costPointsPerUnit`, `enabled`, `input` (`maxCharacters`, `charactersPerUnit`) and `voices` (`id`, `name`, `description`). `caps` is `GET /plans`'s `caps`: `dailyPoints`, `maxCharactersPerJob`, `maxAudioMinutesPerJob`. Every figure is read from the live settings on each call (R-65). `enabled` is false until a voice provider is set up on the Hub: the tool is listed, and a job is refused. |
| `POST /points/quote` | Unchanged except that the answer now carries `quoteToken`: a signed token for the cost the quote showed (same key as the fee quotes). |
| `POST /ai-tools/voiceover/jobs` | Body `{ text, voiceId, quoteToken }` and an `Idempotency-Key` header (required, 8 to 128 of `[A-Za-z0-9_-]`). Answers `202` with the job `working`. |
| `GET /ai-tools/jobs/{id}` | The job as it stands: `working`, `done` with `audioUrl`, or `failed` with the words "No points were taken" (PT2c). Only the person who ran it reads it; another person's job and one that is not there are the same `404 not_found`. |

`AiJobView`: `id`, `tool`, `state`, `voiceId`, `characters`, `units` (the
minutes it was priced in), `costPoints`, `audioUrl`, `message`, `createdAt`,
`finishedAt`.

- **Minutes from the text.** `units` is the text's characters over
  `charactersPerUnit` (the setting `ai.voiceover_chars_per_minute`,
  PROVISIONAL `AITOOLS-CHARS-PER-MINUTE`, 900), rounded up, at least 1. The cost
  is `costPointsPerUnit` times `units`. The text is trimmed and counted in
  characters (code points).
- **The quote the person saw.** The job runs only when its cost now is exactly
  the cost in `quoteToken` (for this person, this tool, not past the fee
  quotes' time). Anything else is `409 quote_changed` with `costPoints` (what
  it costs now) and nothing held, so a person is never charged a price they
  were not shown.
- **Refused with nothing held.** `422 points_cap_reached` naming the cap
  (`characters_per_job`, `minutes_per_job` or `daily`, with `capLimit`,
  `capUnit`, and for the day's `usedPoints`, `remainingPoints`, `resetsAt`),
  `402 insufficient_points`, `409 quote_changed`, `400 ai_voice_unknown`, `400
  ai_text_empty`, `400 idempotency_key_required`, `503 ai_tool_unavailable`
  ("AI voice tools are not available right now. No points were taken."). A
  refusal leaves the key free to use once the cause is fixed.
- **Idempotency.** The job's id comes from the person and the key, so a retry
  after a lost answer, and two requests at once with one key, share one hold,
  one row and one provider call. The repeat answers the job as it stands, `200`
  with `Idempotent-Replayed: true`; the same key with other words or another
  voice is `409 idempotency_key_reused`. A failed job stays failed under its
  key: "Try again" is a new key and a new job.
- **The points.** The hold is the job's reference `<id>:1` (`purpose
  ai_job`, titled "VoiceOver"). Audio made: the file is stored, then the hold
  is COMMITTED (the deciding step), then the job is `done`. The provider down,
  refusing the text or answering with anything but audio, or the file not
  stored: the hold is RELEASED and the job is `failed`. A late finish and the
  stale-hold sweep (`points.job_max_run_minutes`) cannot both win: the points
  service lets one settle the hold, and the job follows whichever did (a read
  of a `working` job also repairs one whose server died). Two jobs at once
  never take points below zero (the points lock decides).
- **No transaction, connection or lock is held across the provider call.** The
  hold is a short database-only transaction; the provider is asked after the
  answer went out; the commit or release is a second short one.
- **No text is kept.** The job row holds the characters, minutes, cost, state
  and a SHA-256 of the request (salted with the person and key); the words live
  only in the request that runs the job. The audio is a confirmed
  `StorageObject` of the person's (folder `ai/voiceover`, not creator content,
  never counted against the R-7 allowance), removed with their account. The data
  export lists their jobs under `aiToolJobs`.
- **The voice provider** is reached only through `AI_VOICE_PROVIDER`
  (`src/ai-tools/voice/`). Its settings are the owner's and are set on the Hub:
  `AI_VOICE_BASE_URL`, `AI_VOICE_API_KEY`, `AI_VOICE_VOICES` (a JSON list of
  `{ id, name, description, providerVoiceId }`), `AI_VOICE_MODEL` (optional)
  and `AI_VOICE_TIMEOUT_MS` (optional). No host is built in, and a provider's
  name or voice id never reaches a string a person sees (R-68: "AI voice
  tools"). **NOT RUN against the real provider**; built and run against
  `scripts/dev/voice-standin.cjs`, a local stand-in with the same wire shape.
  The fact that unblocks the real run: a provider key set on the Hub.

### The one job pipeline, Quick voice and the job list (AITOOLS-02)

Task AITOOLS-02, R-78, R-79. Every tool Studio lists runs through
`AiJobService.createJob(tool, ...)`: price the request into the tool's units,
check the quote, hold through POINTS-03, record the job, ask the provider after
the answer with nothing held, store, COMMIT, mark done; any failure RELEASES.
A tool is one file under `src/ai-tools/tools/` (id, route segment, plan action,
unit, pricing, input kind, the one provider call, what the job returns) and one
entry in `src/ai-tools/tools/index.ts`. VoiceOver is the first entry and its
route, request, answer and behaviour are AITOOLS-01's. Additive fields only:

| Route | Does |
|---|---|
| `POST /ai-tools/quick-voice/jobs` | Quick voice (R-79): a fast, cheaper read-aloud, the same voices as VoiceOver on the provider's faster model (`AI_VOICE_QUICK_MODEL`, optional, default `eleven_flash_v2_5`). Body `{ text, voiceId, quoteToken }` (a quote for the action `quick_voice_per_min`) and a required `Idempotency-Key`; every refusal is VoiceOver's. Priced by `points.action.quick_voice_per_min` (125 a minute, PROVISIONAL) over `ai.quick_voice_chars_per_minute` (900, PROVISIONAL `AITOOLS-CHARS-PER-MINUTE`). |
| `GET /ai-tools/jobs` | The caller's own jobs of every tool, newest first, in cursor pages (CONVENTIONS section 6): `?cursor&limit` (1 to 100, default 20), answered `{ items: AiJobView[], nextCursor }` (`AiJobPage`). A cursor this list did not give is a plain `400`. Another person's job is never listed. |

- **The catalogue.** A tool is listed only when its code is built and the
  provider can run it (R-47): VoiceOver keeps AITOOLS-01's answer (listed, with
  `enabled: false`, until the provider is set up); Quick voice is not listed
  at all until it can run. Each entry's `input` gains `kind` (`text` now;
  `prompt`, `file` and `chat` come with the tasks that need them), and its
  `id` may be `quick-voice`. Daily, characters and minutes caps count Quick
  voice and VoiceOver together.
- **The result shape.** `AiJobView` gains `outputs`: a list of `{ kind: audio |
  text | subtitles, url?, text? }`, filled once the job is `done` and empty
  before. `audioUrl` stays and is the same link as the `audio` output.
- **The migration** `20261101100000_ai_tool_job_outputs` adds three nullable
  columns to `AiToolJob`: `outputs` (JSON), `providerRef` (text) and `inputRef`
  (text). Rows written before it read back with all three empty and still serve
  their audio by `audioKey`. `rollback.sql` drops the three columns and loses no
  row; it refuses while a row holds an output that is not the job's own audio, a
  provider id or an upload, since only these columns keep them.
- **NOT RUN against the real provider.** Quick voice was built against
  `scripts/dev/voice-standin.cjs`, whose route table answers `model_id` on the
  speech route so a spec can see which model ran.

### Sound effect and Music track (AITOOLS-03)

Task AITOOLS-03, R-78. Two more tools on the one pipeline, one file each under
`src/ai-tools/tools/`, input kind `prompt` (a description in words), one
provider call, one audio file out, a flat price (the board's figures, PROVISIONAL
`DV2-BOARD-FIGURE`). Both are listed only when the provider can run them (R-47).

| Route | Does |
|---|---|
| `POST /ai-tools/sound-effect/jobs` | Sound effect. Body `{ prompt, durationSeconds?, quoteToken }` (a quote for the action `sfx`, units 1) and a required `Idempotency-Key`. `durationSeconds` is 0.5 up to `ai.sfx_max_seconds` (30). Priced by `points.action.sfx` (75 a `use`), flat whatever the length. |
| `POST /ai-tools/music/jobs` | Music track. Body `{ prompt, lengthSeconds?, instrumental?, quoteToken }` (a quote for the action `music_per_track`, units 1) and a required `Idempotency-Key`. `lengthSeconds` is a whole number from 3 up to `ai.music_max_seconds` (300). Priced by `points.action.music_per_track` (500 a `track`), flat whatever the length. One long provider call with its own timeout `AI_VOICE_MUSIC_TIMEOUT_MS` (optional; default 600000, set from the longest track the Hub allows because NO long real run has happened). That setting is the real wait (the call does not use Node's `fetch`, which ends a call with no answer after 300 seconds). |

- **The catalogue.** An entry's `unit` is `use` or `track`; `input.kind` is
  `prompt`, `input.maxCharacters` the description limit (the tool's setting,
  never above `points.max_chars_per_job`), `input.charactersPerUnit` equals it
  (one use or track covers any allowed description), `input.length` is
  `{ field, min, max, whole }` in seconds, `input.instrumental` is true for
  Music track, and `voices` is empty. A job's `voiceId` is empty, `units` is 1.
- **The limits** (admin settings, PROVISIONAL `AITOOLS-LIMITS`):
  `ai.sfx_max_prompt_chars` and `ai.music_max_prompt_chars` (default
  `points.max_chars_per_job`, 5,000), `ai.sfx_max_seconds` 30,
  `ai.music_max_seconds` 300. A description over the setting is `422
  ai_prompt_too_long`, a length over it `422 ai_length_too_long`, each with
  `reason.cap`, `capLimit`, `capUnit` and "No points were taken"; an empty
  description is `400 ai_prompt_empty`. A length over `points.max_audio_min_per_job`
  is `422 points_cap_reached` (`minutes_per_job`). Nothing is held in any of these.
  The daily and characters caps are POINTS-03's, as for VoiceOver.
- **Output.** MP3 in the person's own folders `ai/sound-effect` and `ai/music`
  (confirmed `StorageObject`s of the person, removed with their account; the
  purge table decides both). The description is never stored.
- The stand-in answers `/v1/sound-generation` and `/v1/music` with silent MP3
  frames of the asked length and the same markers. **NOT RUN against the real
  provider.** The provider's Music API is for paid plans and its terms say what
  each plan may be used for (G-AITOOLS-03-1, the owner's to read).

### Captions and Clean audio (AITOOLS-04)

Task AITOOLS-04, R-78. Two more tools on the one pipeline, input kind `file`: the
person's own recording or video goes in, priced by the minute of the file as the
Hub reads it (rounded up, at least 1). Listed only when the provider can run
them (R-47). The costs are `points.action.captions_per_min` (15) and
`points.action.clean_audio_per_min` (400), PROVISIONAL `DV2-BOARD-FIGURE`.

| Route | Does |
|---|---|
| `POST /uploads/presign` | Two new folders: `ai/input-audio` (`audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/aac`) and `ai/input-video` (`video/mp4`, `video/quicktime`, `video/webm`). Private, never counted in the 5 item or storage allowance, cap `ai.input_max_bytes`. The `key` it answers is the file's name for the routes below; the app then PUTs the file and calls `POST /uploads/confirm`. |
| `POST /ai-tools/captions/quote`, `POST /ai-tools/clean-audio/quote` | Body `{ fileKey }`. The Hub opens the file, reads its length itself and answers the `POST /points/quote` shape (with `quoteToken`, `canRun`, `cap`) plus `file: { seconds, minutes }`. The phone sends no length. Holds nothing. |
| `POST /ai-tools/captions/jobs` | Body `{ fileKey, languageCode?, quoteToken }` and a required `Idempotency-Key`. `202`, then poll `GET /ai-tools/jobs/{id}`. A done job's `outputs` hold `{ kind: 'text', text }` (the words) and `{ kind: 'subtitles', text }` (an SRT the Hub builds from the word times); `audioUrl` is null. |
| `POST /ai-tools/clean-audio/jobs` | Body `{ fileKey, quoteToken }` and a required `Idempotency-Key`. A done job's `audioUrl` (and its `audio` output) is the cleaned recording, kept under the person's own folder `ai/clean-audio`. |

- **The catalogue.** `unit` is `minute`, `input.kind` is `file`, `maxCharacters`
  and `charactersPerUnit` are 0 (no text), `voices` is empty, and `input.file` is
  `{ folders: { audio, video }, accepts: { audio[], video[] }, maxBytes,
  maxMinutes, languageCode }` (`maxBytes` is the setting, `maxMinutes` is
  `points.max_audio_min_per_job`). A job's `voiceId` is empty and `characters` 0.
- **Refusals, each with nothing held.** `404 not_found` ("We couldn't find that
  file.") for a key that is not the caller's own landed file in an input folder;
  `422 ai_file_unreadable` ("We couldn't read that file. No points were taken.")
  when the length cannot be read; `422 ai_file_too_large` (`reason.cap`
  `file_bytes`, `capLimit` bytes) over `ai.input_max_bytes`; `422
  points_cap_reached` naming `minutes_per_job` over `points.max_audio_min_per_job`.
  The daily cap is POINTS-03's. A refused request leaves the file where it is.
- **The file is read once, and deleted.** The Hub reads it from storage for the
  one provider run and deletes it when the job ends, done or failed, and when the
  sweep gives a stale job's points back; account deletion removes any that is
  left (the purge table decides all three folders). `AiToolJob.inputRef` keeps
  the key. No log line holds a file's name, bytes or text.
- **The provider keeps nothing.** After a Captions result is kept the Hub deletes
  the provider's transcript; after Clean audio it deletes the provider's history
  item, whose id comes in the `audio-isolation-id` response header (seen on the
  real provider, 24 Oct 2026: it sends no `history-item-id`; the delete route is
  `DELETE /v1/audio-isolation/history/{id}`, 204). Both deletes are tried however
  the job ends. The real provider answers 404 for a copy it has not stored yet
  (transcript: 404 at 89 ms, 200 about 40 s later), so the Hub notes the copy on
  the job row (`providerRef`: `transcript:<id>` or `isolation:<id>`), tries once,
  then four more times over about a minute (2, 6, 15 and 40 seconds, outside the
  job), and leaves the rest to a sweep every minute: a 2xx clears the note; a 404
  clears it only 10 minutes after the answer (before that it may not be stored
  yet); any other answer keeps trying for 24 hours, then logs that the copy was
  never removed.
- **The length the provider reports** (Captions answers `audio_duration_secs`):
  more than 1 minute above the priced minutes fails the job (`failureCode`
  `length_differs`) and every point goes back.
- **Clean audio's answer type** is read from the real response and kept only if
  the Hub serves it (`audio/mpeg`, `audio/wav`, `audio/mp4`, `audio/aac`); else the
  job fails (`output_type`) and releases. What a real run answers is NOT RUN.
- **The result is written to the job row before the points are kept**, so a
  server that dies between the two still shows the words (a transcript lives
  nowhere else).
- **Length reader.** `music-metadata` 7.14.0 (pure JavaScript, no ffmpeg on the
  Hub), run in a worker thread so a person's file cannot stop the Hub. First the
  file's own first bytes must name a container the tools take (WAV, MP3 by frame
  or ID3, ADTS AAC, MP4/M4A/MOV by an `ftyp` box, WebM/Matroska); anything else,
  ASF and DSF included, is refused as `ai_file_unreadable` before any parser sees
  it, and the declared type is never used. The one parser for that container
  runs in a worker with a 15 second hard limit and a memory watchdog, terminated
  on overrun (also refused as unreadable); two workers at most run at once.
  QuickTime is read as MP4. A length that reads 0 (a fragmented MP4) is refused,
  never priced as 0 minutes. Minutes round up after 0.5 s of container padding is
  forgiven (a "1:00" clip is 1 minute). The whole file is read into memory for the
  length (up to `ai.input_max_bytes`); the run does not read it whole: it takes
  the same place behind the read gate as a quote (one place per account, the
  global turns and bytes, charged the file's real length from the store) and
  streams the file to the provider, so a job holds about 64 KB of it, whatever
  its size. A Hub too busy to take the run ends the job `busy` and gives every
  point back. The place and the turn are one deadline of 20 seconds.
- **The provider's copy of a transcript** is deleted on a schedule (a try when
  the job ends, four more over a minute, then every minute) and the note is
  cleared only by two reads of 404, each made with no delete just before it: the
  first at least `ai.copy_confirm_after_minutes` (10) after the job ended, the
  second at least `ai.copy_confirm_gap_minutes` (5) after the first (both
  PROVISIONAL `AITOOLS-COPY-CONFIRM`; an admin may change them). The real
  provider answers a read 404 for about a second after a delete and then shows
  the transcript again, so a 404 seen sooner proves nothing.
- **Settings.** `ai.input_max_bytes` (default 500 MB, the smaller of the provider's
  documented limits; an admin may only lower it; PROVISIONAL `AITOOLS-LIMITS`).
  `AI_VOICE_FILE_TIMEOUT_MS` (default 600000) is the wait of both file calls;
  they are made with `node:http(s)` like the Music call. `AI_VOICE_TRANSCRIBE_MODEL`
  (default `scribe_v2`).
- The stand-in answers `/v1/speech-to-text`, `/v1/audio-isolation` and both
  `DELETE` routes, with failure markers read from the file's bytes. **NOT RUN
  against the real provider.**

## 13. Hosting an event needs a tier (EVENTS-12)

R-43, E21 "Needs a tier". `POST /events`, `PATCH /events/{id}` and
`PUT /events/{id}/tickets` (the host gate, `EventService.assertMayHost`, one
copy) let a person host when they hold:

1. a verification tick that has not ended (either kind), exactly as before, or
2. a tier that is running, that is `GET /me/tier` state `active` or `ending`
   (the publishing gate's own test, `MakerTierService`). Any tier of the plan
   is enough, and so is a tier bought on an account of any type.

A tier whose period has ended stops NEW hosting: a new event, an edit and a
ticket price change. It never touches an event that is already live: a
published event stays public and its tickets keep selling, because buying a
ticket asks nothing of the host's tier. Changing ticket prices on an approved
event still sends it back to review, and the 409 for sold tickets still comes
first (R-40).

The refusal is the contract's one error shape (CONVENTIONS section 3), a
**403** as these routes have always answered a host who may not host, with a
new additive `reason.code`:

```json
{
  "statusCode": 403,
  "message": "Needs a tier. Pick a tier to host an event.",
  "data": null,
  "reason": {
    "code": "tier_required",
    "message": "Needs a tier. Pick a tier to host an event.",
    "tierState": "none",
    "currency": "NGN",
    "lowestTier": { "id": "verify", "name": "Verify", "priceMinor": 100000 }
  }
}
```

- `tierState` is `none` (never had a tier) or `ended` (the message then says
  the tier ended and that events already live keep selling).
- `currency` and `lowestTier` are the cheapest tier on `GET /plans` in the
  person's billing currency: the app prints "From ..." from them and never
  types a price. They are left out only when the Hub could not read the plan
  at that moment.
- An account that is neither a creator nor an approved professional, with no
  tick and no tier, still gets `account_type_required` (with `steps`), as
  before; it names the tier among its steps.
- The old `verification_required` is no longer answered by these routes: the
  tick is not what they ask for any more. The web reads only `reason.code` and
  `message` from the envelope, and a host with a live tick sees no change.

## 14. Hear your name and the Voice Intro (VOICE-01)

Task VOICE-01, R-43, R-66, R-68, R-65. A person hears their name in a studio
voice (VF3) and makes a Voice Intro in their own AI voice from a 30 second
recording they consent to (VF8 to VF11). Every route takes the caller's own id
from the token and no id in the path or body, so there is no way to ask for,
record or use anyone else's voice. The audio is an AI voice: every view carries
`aiVoice: true` so the app shows the tag. No message names the voice provider.

| Route | Does |
|---|---|
| `GET /me/voice` | `{ namePhonetic, nameSavedAt, available }`. `available` is false until voices are set up on the Hub. |
| `POST /me/voice/name-preview` | Body `{ name, phonetic? }`: letters, spaces, apostrophes, hyphens. Answers `{ audioUrl, aiVoice: true }`. Free; at most `voice.name_previews_per_hour` an hour (`429 voice_preview_limit`). `503 voice_unavailable` when voices are off. |
| `PUT /me/voice/name` | Body `{ phonetic: string \| null }`: how the name is said. Answers `GET /me/voice`. |
| `GET /me/voice-intro` | `{ aiVoice, text, textMaxChars, consent: { line, given, at }, sample: { recorded, at, minSeconds, maxSeconds }, audioUrl, next: { free, costPoints }, canGenerate, run }`. `consent.line` is the words to show: "I am {name}. I agree that Who Made This? may create an AI version of my voice for my intros.", with the name from the Hub's record of the person (first, middle and last name, as `GET /users/me` gives it). `sample.minSeconds` and `sample.maxSeconds` are the shortest and longest recording, from the settings `voice_intro.sample_min_seconds` (15) and `voice_intro.sample_max_seconds` (30), both PROVISIONAL; the Hub does not read a file's length, the app times the take, and a shortest set above the longest is held down to the longest. `next.free` is true while the tier still includes the first Voice Intro. `run` is the latest try: `{ id, state, costPoints, included, message, createdAt, finishedAt }`; a failed try shows `costPoints` 0 (its points were released). When the Hub holds no name for the person, `consent.line` is the sentence "Add your name to your profile first." instead of a line to agree to. |
| `PUT /me/voice-intro/text` | Body `{ text }`, at most `textMaxChars` (`voice.intro_max_chars`, `400 voice_text_too_long`). Answers the view. |
| `POST /me/voice-intro/consent` | Body `{ line }`, which must be `consent.line` exactly, as served to this person (`409 voice_consent_line_changed`, also for another person's line). Stored exactly, with the time. With no name on record: `409 voice_name_required`, and nothing is stored. Answers the view. |
| `POST /me/voice-intro/sample` | Body `{ fileUrl }`: the `fileUrl` of `POST /uploads/presign` with the folder `voice/sample`, after the file is sent and `POST /uploads/confirm` says `confirmed`. Only the caller's own landed upload is taken (`400 voice_sample_unusable`); the consent comes first (`409 voice_consent_required`). The time of that consent is stored with the sample. |
| `POST /me/voice-intro/generate` | `Idempotency-Key` required. Answers `202` with `run.state` `working` (a repeat of the key: `200`, `Idempotent-Replayed: true`, nothing taken twice). The app polls `GET /me/voice-intro`. |
| `GET /users/{wawuId}/voice-intro` | `{ voiceIntro: { url, aiVoice: true } }`, or `{ voiceIntro: null }`. `404` for no such person or one hidden by a block. A person with no public profile (a plain account) answers `{ voiceIntro: null }`, as for no intro. Only the audio is public. |

Paying. The first Voice Intro a tier includes (`firstVoiceIntroIncluded`, spent
once) takes no points; any other holds the plan's `voice_intro` points (200 by
default, `points.action.voice_intro`) through POINTS-03 before the provider is
asked, keeps them when the audio is stored and gives every one back when it is
not (`run.message`: "That didn't work. No points were taken. Try again."); a
try that used the included one puts it back. One try at a time per person
(`409 voice_intro_busy`). Refused with nothing taken: `409 voice_text_required`,
`409 voice_consent_required`, `409 voice_sample_required`, `402
insufficient_points`, `422 points_cap_reached`, `503 voice_unavailable`.

The public profile route `GET /users/{wawuId}/public-profile` does not carry
`voiceIntro`: its response is locked by the protected route suite, so the
Voice Intro is served by the route above (G-VOICE-01-1).

