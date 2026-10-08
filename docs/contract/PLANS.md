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
  3000.5)`. Ids must be unique; a tier's `event_pass` must be listed in
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
   row, the table the wallet gate reads) or a Nigerian mobile on their
   account (the WAWU ID token's `phone`, read with `toLocalNigerianPhone`, so
   `0803...`, `234803...` and `+234 803 ...` all count).
3. Otherwise `USD`.

**Fixed at the first purchase, never changed by a route.**
`BillingCurrencyService.fixAtFirstPurchase({ wawuUserId, phone, purchaseRef },
tx)` is called by the purchase (TIER-03; POINTS-02 for a first purchase of
points) inside the transaction that records it. It inserts only when there is
no row (`ON CONFLICT DO NOTHING`) and answers the currency that holds, so a
repeated confirmation or two first purchases at once leave one currency, and a
purchase that rolls back fixes nothing. The purchase prices in the currency it
answers. No method and no route updates the row (a spec checks every write to
the table in `src/`); the owner's rule is "do not switch without support",
which is a person at WAWU changing it by hand, recorded as `fixedBy:
support`.

## 3. `GET /plans`

Signed in. The plan in the caller's billing currency only: `currency`,
`currencyFixed`, `tiers`, `extraProducts`, `packs`, `checkoutBump`, `actions`
and `caps`. Every amount is `priceMinor`: whole minor units of `currency`
(kobo for `NGN`, cents for `USD`). The answer never holds the other
currency's figures: one price per item, picked by `priceIn` in
`plans-config.ts`. `tiers[].preselected` marks the tier VF5 shows selected
(Founding Maker in the example file). Referral and cash-out figures are in
the config for REF-01 and POINTS-04 and are not in this answer.

## 4. `GET /me/tier` (VF14)

Signed in, the caller's own only. `state` is:

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
| `MakerTier` | person who ever held a tier | TIER-03 (buy, renew, upgrade), TIER-04 (extra products) |
| `EventPass` | purchase that issued a pass (`purchaseRef` unique) | TIER-03 |

`MakerTier` copies what the tier gave when it was bought
(`productsIncluded`, `pointsIncluded`), so a later change to the config never
takes away what a person paid for. `MakerTierService` is the one reader: GET
/me/tier, the publishing gate (TIER-02, `hasActiveTier`) and the purchases ask
it. All three tables are in the account purge (OWNED) and the data export
(without payment references).
