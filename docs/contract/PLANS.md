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

## 6. Granting a tier (JOIN-03)

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
| `POST /plans/purchases` | Pays. Headers `Idempotency-Key` (required) and `X-Transaction-Pin` (or a biometric approval, MONEY-14). Body: `kind`, `tierId`, optional `bump`, `method: "wallet"`, `expectedTotalKobo` and `quoteToken` from the quote. Answers 201 with a `PlanPurchaseView`. |
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

Paying by bank transfer at checkout (TIER-05), extra products (TIER-04),
points packs (POINTS-02), the Voice Intro itself, the Founding Maker's badge
number (BACKEND_GAPS G-421) and the dollar wallet path (NUV-09).

