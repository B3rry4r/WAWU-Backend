# Money contract conventions

Task MONEY-04, 2 Oct 2026. These rules hold for every route under
`/api/hub/money` (the Naira wallet on Fintava) and for any route added later
that reads or moves money. Routes that exist today keep their shapes: nothing
here renames, retypes or widens them (CLAUDE.md, "Additive only").

The routes themselves, the artboard mapping and the conflicts for the owner
are in [`WALLET.md`](WALLET.md). Every Fintava fact cited here comes from the
mobile repo's `docs/fintava/` (`naira-api.md`, `fees.md`, `limits.md` and the
real sandbox calls in `sandbox/`).

---

## 0. Where the contract lives, and why it is code

`contract/openapi.json` is generated, never hand-edited, and `contract/**` is
fenced. `npm run contract:build` builds the app, emits the document from the
Nest controllers and DTO classes (`src/openapi/emit-openapi.ts`, with the
`@nestjs/swagger` CLI plugin reading request DTOs and their JSDoc), then
`scripts/enrich-contract.js` fills in every success response from the
TypeScript type the handler returns. The mobile app copies that one file from
`origin/main` (`npm run api`, `scripts/api/sync_contract.py` in the mobile
repo) and generates its types from it.

So the wallet contract is written the way this repo declares every contract:
as code, in `src/money/`.

| File | What it declares |
|---|---|
| `src/money/dto/money-request.dto.ts` | request bodies and queries (class-validator classes) |
| `src/money/money-view.type.ts` | every response shape, one named interface each |
| `src/money/dto/money-error.dto.ts` | the error envelope and its `reason` |
| `src/money/dto/money-enums.ts` | the closed value sets (payment kinds, error codes, filters) |
| `src/money/money-contract.ts` | header and error decorators, the code-to-status table |
| `src/money/*.controller.ts` | the routes, each naming the task that serves it |
| `src/money/money-contract.module.ts` | the module that holds them, **not imported by AppModule** |

**Declared, not served.** No request can reach these routes: AppModule does
not import `MoneyContractModule`, and every handler body is `declaredOnly(...)`,
which throws if it is ever called. `emit-openapi.ts` builds a second document
from that module and copies it in, marking each operation
`"x-wawu-served": false` with `"x-wawu-built-by": "<task>"`, and its
description starts "Declared by MONEY-04, not served yet". The emit fails if a
route is both served and declared, or if a schema name collides with a served
one. `src/money/tests/money-contract.spec.ts` fails if AppModule ever reaches
the module or one of its controllers, if a declared operation loses its
markers, if a success body is an inline object instead of a named schema
(G-1), or if a money-moving route stops requiring `Idempotency-Key` and
`X-Transaction-Pin`.

A field that can be null and holds a named shape is written
`{ "allOf": [{ "$ref": ... }], "nullable": true }`, the OpenAPI 3.0 form that
generators read as `Named | null` (`scripts/enrich-contract.js`, for types
under `src/money/` only, so no served route's entry changes).

**Why not a hand-written spec file next to `contract/openapi.json`.** The
mobile app reads only `contract/openapi.json`, so a second file would need a
change to its fenced sync script, and it would be a second truth: when the
real controllers land, the generated shapes and the hand-written ones would
drift with nothing to catch it. `scripts/enrich-contract.js` already makes
that argument for response shapes. Written as code, the task that serves a
route keeps the same DTO and view types, so the contract the app built
against is the one it gets.

**When a task serves a route:** write the handler in a controller owned by a
module AppModule mounts (importing a new module into `app.module.ts` is a
`SHARED-CHANGES.md` row in the mobile repo), import the DTOs and views from
`src/money/`, delete the declaration from `src/money/*.controller.ts`, and run
`npm run contract:build`. The operation then appears without
`x-wawu-served: false`. The mobile app must not treat a route marked
`x-wawu-served: false` as live.

**Served so far** (`MoneyModule`, `src/money/money.module.ts`, mounted by
AppModule since MONEY-09): `GET`, `POST` and `PUT /money/pin` and
`POST /money/pin/verify` (MONEY-09); `GET /money/wallet/balance`
(MONEY-11), which reads the caller's wallet from `FintavaWallet` (through
the wallet gate, section 7) and asks Fintava on every request; `GET /money/identity`,
`POST /money/identity/bvn` and `PUT /money/identity/occupation` (KYC-01),
Open your wallet's identity step (section 8); the PIN reset, biometric
approval and `POST /money/approval/verify` (MONEY-14, section 5);
`GET /money/transactions`, `/money/transactions/summary` and
`/money/transactions/{id}` (MONEY-15), the history from the ledger
(section 6); `GET`, `POST /money/beneficiaries`, `DELETE
/money/beneficiaries/{id}`, `GET` and `PUT /money/payout-account`
(WALLET-14, section 10). A served route and a declared one may share a
schema (the error envelope, the PIN DTOs); the emitter keeps one copy when
the two are identical and still fails when they differ. A task that serves
more routes adds them to `SERVED_MONEY_ROUTES` in
`src/money/tests/money-contract.spec.ts`.

---

## 1. Money is integer kobo

- Every amount in a money route is a **JSON integer number of kobo** in a
  field whose name ends in `Kobo` (`amountKobo`, `totalKobo`,
  `providerFeeKobo`). ₦25,065.00 is `2506500`. Never a float, never a string,
  never naira with decimals.
- Grounded in the backend as it is: where money is split it is already kobo
  integers (`CreditSpendEarning.hostShareKobo` and `platformShareKobo`;
  `splitKoboByBps` and `nairaToKobo` in `src/admin/finance/finance-streams.ts`,
  which floor the creator's share in kobo). Older routes carry whole naira
  (`amount`, `priceNgn`, `MIN_WITHDRAWAL_NGN`); they stay as they are.
- **The Fintava boundary.** Fintava speaks naira decimals: numbers in
  balances (`49960`), strings in transaction records (`"5.00"`) and bills
  lists (`"price": "900"`). The Fintava client (MONEY-06) is the only place
  that converts: it parses the decimal text into integer kobo (whole part
  times 100 plus the fraction padded to 2 digits) and rejects a value with more
  than 2 decimal places rather than rounding it; outbound it writes kobo as a
  2-decimal naira value built from integer division. Never `x * 100` on a
  float.
- **Caps are rules, not validation.** Request DTOs bound an amount only by
  what a JSON number carries exactly. A customer's own send is bounded by the
  daily limit (`daily_limit_exceeded`). Money that goes through WAWU's
  merchant wallet (a payment, a hold and its release or refund, a payout from
  WAWU) is bounded by `MERCHANT_MAX_PER_TXN_KOBO` from config (₦10,000,000,
  Fintava's per-transaction cap on the merchant account, `limits.md`); above
  it the answer is `400 amount_out_of_range` with `maximumKobo`, and the
  amount is never split (Lead ruling 1, 2 Oct 2026, `WALLET.md`).
- The contract says so too: every field and parameter whose name ends in
  `Kobo` is `"type": "integer"` in `contract/openapi.json`, responses and
  errors included (`scripts/enrich-contract.js` reads the name;
  `money-contract.spec.ts` checks every one). That rule covers a field that
  holds one figure. A list of amounts is therefore a list of objects, each
  with an `amountKobo` field, and never an array of numbers in a field named
  `...Kobo` (an array is not an integer): the electricity quick amounts are
  `presets: [{ "amountKobo": 500000 }]` on `GET /bills/electricity/billers`
  (BILLS-01, round 3 hotfix), not `presetsKobo: [500000]`.
- A balance is only ever Fintava's (`GET /money/wallet/balance`,
  `availableBalance`). No route sums ledger rows and calls the result a
  balance.

### 1a. Amounts that are not naira (WALLET-21, R-83, R-84)

Default (lead), owner may override. Naira stays kobo, in `...Kobo`. Every other
currency (dollars, euros, pounds, Canadian dollars, dirhams, cedis, and the
stablecoins USDT, USDC and RLUSD) is the same idea with its own unit:

- An amount that is not naira is a **JSON integer in the currency's smallest
  unit**, in a field whose name ends in `Minor` (`amountMinor`,
  `availableMinor`, `wawuFeeMinor`). $12.34 is `1234`. Never a float, never a
  string.
- A `...Minor` field **always sits beside a currency field** that says whose
  unit it is: `currency` on the object, or `fromCurrency` / `toCurrency` for a
  quote or a swap (`amountFromMinor` is in `fromCurrency`, `amountToMinor` in
  `toCurrency`). The currencies are the WAWU codes `USD`, `EUR`, `GBP`, `CAD`,
  `AED`, `GHS`, `USDT`, `USDC`, `RLUSD`; `NGN` appears only where a swap starts
  from or ends in the naira wallet, and there the figure is kobo, in a field
  that still ends `Minor` because the pair of fields is one rule.
- How many decimals the unit has is `decimals` on the currency (2 for a
  dollar). It is data: the app formats from it and never hard-codes it. The
  stablecoins' `decimals` is read from config (BACKEND_GAPS G-WALLET-21-1:
  Nuvion's docs say six places, its dev server counts cents).
- A `...Minor` field is `"type": "integer"` in `contract/openapi.json`
  (`scripts/enrich-contract.js` writes every number under `src/money/fx/` as an
  integer; `src/money/fx/tests/fx-contract.spec.ts` checks it).
- A balance of such an account is the provider's, read on every request; no
  route adds our rows up and calls the result a balance.

## 2. Phone numbers: any country in E.164, and `+234` only where a Nigerian rail is paid

Widened by GEO-02 (R-85, owner, 24 Oct 2026: "This is not a Nigeria only
platform"). Two rules, and the second is the old one, unchanged.

**Where the Hub only stores or shows a phone: any valid number, E.164.**

- **Out:** every phone the Hub returns is E.164 with its country code,
  `+2348031234567`, `+447911123456`, `+233241234567`. A masked phone keeps the
  prefix: `+234 803 *** 4412`.
- **In:** a number written with its country code (`+` or `00`, spaces, dashes
  and brackets ignored) is read as it is. A number written the way people write
  it at home (`0803 123 4567`) is read against the country the person chose,
  so a Nigerian number typed with its leading 0 works when Nigeria is chosen
  and means nothing without a country.
- **Valid** is libphonenumber's word (`libphonenumber-js` 1.13.15, pinned,
  `src/geo/phone.ts`: `parseInternationalPhone`), not a length rule. The
  trunk 0 in brackets goes: `+44 (0)7911 123456` is `+447911123456`. A number
  that is not valid is a 400 in a field that must be a phone.
- **The lists the app shows** (the country dropdown, its dial code and an
  example number for the field's hint) are `GET /geo/countries`, public. The
  app never carries a list of its own.
- **Where a country code is shared** (`+1`, `+44`, `+7`) the number's digits
  decide when they can (`+1 876` is Jamaica); when they cannot, the country the
  person chose wins and the Hub's guess from the number alone is only a guess.

**Where a route pays a Nigerian rail: the Nigerian rule, unchanged.** The
server accepts any common Nigerian mobile form and normalises it before it
compares, stores or forwards it: `08031234567`, `8031234567`,
`2348031234567`, `+2348031234567`, with spaces, dashes and brackets ignored.
The pattern is `^(?:\+?234|0)?([789][01]\d{8})$`
(`src/wallet-provider/nigerian-phone.ts`, `toLocalNigerianPhone`). A value that
is not a Nigerian mobile after normalising matches nothing; in a field that
must be a phone it is a 400. The naira wallet stays Nigeria-only (BVN, R-6,
R-85), and Fintava and Nuvion wait on a Nigerian number, so these keep it:

| Where | What it is for | Rule |
|---|---|---|
| `src/wallet-provider/nigerian-phone.ts` | the Nigerian mobile rule itself | Nigerian |
| `src/money/identity/wallet-identity.service.ts` | the BVN check matches the account's phone to the BVN's (`phone_not_nigerian`) | Nigerian |
| `src/money/opening/reviewed-opening.ts`, `wallet-opening.service.ts`, `src/nuvion/areas/opening.ts` | opening the naira wallet at the provider | Nigerian |
| `src/money/recipients/recipient-query.ts`, `recipient.service.ts` | finding a wallet holder by the phone they proved | Nigerian |
| `src/wallet-bills/wallet-bill.service.ts` | airtime and data to a Nigerian network | Nigerian |
| `src/health-plan/dto/health-plan.dto.ts` | enrolling with WellaHealth, a Nigerian provider | Nigerian |
| `src/money/pin/pin-reset.service.ts` (`maskPhone`) | the PIN reset text goes to the wallet's proved phone | Nigerian |
| `src/fintava/fintava-client.ts` | the provider client (not touched) | Nigerian |
| `src/waitlist/waitlist-contact.ts` (`normalisePhone`) | the launch registration stores a phone | any valid number; Nigerian forms as before; a `+234` number that is not a Nigerian mobile is refused |
| `src/plans/billing-currency.service.ts` (`phoneCountry`) | `+234` is naira, any other code is dollars | unchanged: it only reads the code |
| `src/account-purge/scrub-contact-details.ts` | takes phones out of text when an account is deleted | unchanged: it already reads any `+` number |

A route that stores or shows a phone and is not in the table takes the first
rule. Where a person's country is wanted, it is `ProfileDetails.countryCode`
(`GET /me/location`, section 2a), never the phone's.

### 2a. The place a person is (GEO-02)

- `GET /geo/countries` and `GET /geo/countries/{code}/regions` are public and
  cached (`Cache-Control: public, max-age=86400`, with an `ETag`). Countries
  are ISO 3166-1 with `code`, `name`, `dialCode`, `flag`, `exampleNumber`,
  `exampleNational` and `hasRegions`; regions are ISO 3166-2 with the full
  `code` (`NG-LA`), `name` and `type`. Region codes are stored on profiles, so
  they are ISO's for every country: `src/geo/data/regions.json` is written by
  `scripts/geo/build-regions.mjs` from `iso-3166` 4.4.0 (pinned; ESM-only, so
  it is read at build time and the Hub reads the JSON), with four places left
  out and two names spelled as ISO does (listed in the file). Country names are
  `i18n-iso-countries` 7.14.0 with a reviewed override table. No request
  reaches the network.
- A person's place is four nullable fields on `PATCH /users/me/profile-fields`
  (`countryCode`, `regionCode`, `regionName`, `city`), checked against those
  lists. A refusal is a 400 with `reason.code` `country_invalid`,
  `region_invalid`, `region_needs_country` or `city_too_long`. The old free
  text `location` is a separate key and works as before.
- `GET /me/location` answers the person's own country (what they chose, else
  WAWU ID's `countryCode` claim, else its older `country` text, else the
  phone's) and records it when they have not chosen one. Another person's
  country is shown only when they chose it.

## 3. One error shape

Every refusal is the envelope this backend already answers with
(`AllExceptionsFilter`), and money routes always fill `reason`:

```json
{
  "statusCode": 402,
  "message": "You need ₦1,323.25 more in your wallet.",
  "data": null,
  "reason": {
    "code": "insufficient_funds",
    "message": "You need ₦1,323.25 more in your wallet.",
    "balanceKobo": 120000,
    "totalKobo": 252325,
    "shortfallKobo": 132325
  }
}
```

- `reason` is how `POST /events` already explains a refusal (an object with a
  stable `code`, carried through untouched by the filter). Schema:
  `MoneyErrorEnvelope` and `MoneyErrorReason`. The app switches on
  `reason.code`, never on `message`.
- A 400 **without** `reason` is the global `ValidationPipe` refusing a
  malformed field; its `message` is the first validation message.
- A 400, 413 or 415 **without** `reason` can also be the body parser
  refusing the request before any route runs (too large, an unsupported
  charset or encoding, a body it cannot read). It is not a money outcome, so
  money routes carry no `reason` for it either; the app treats it as a
  malformed request (FIX-08).
- Success is `{ statusCode, message: "OK", data }`. The body's `statusCode` is
  always 200, even when the HTTP status is 201 (hazard H-3 in
  `src/common/tests/protected-registry.regression.spec.ts`): read the HTTP
  status.
- A PIN problem is never a 401: 401 means the WAWU ID token, and the app's 401
  handling signs the person out.
- Somebody else's transfer, payment, hold or transaction is a 404, never a
  403, so ids cannot be probed.
- A known condition is never a 500. Fintava down or timing out is
  `503 provider_unreachable`. Fintava's own error text never reaches the app:
  its responses can carry a customer's BVN and NIN
  (`sandbox/12-transaction-by-id.md`).
- `message` is a plain sentence the app may show: no em-dash, no provider
  name, no raw provider text.

| `reason.code` | HTTP | When | Extra fields |
|---|---|---|---|
| `wallet_not_open` | 409 | the caller has no wallet (R-6, MONEY-13) | |
| `wallet_opening` | 409 | Open your wallet finished, account still being created | |
| `wallet_frozen` | 423 | Fintava has the wallet frozen (fraud hold, R-17 deletion window) | |
| `provider_unreachable` | 503 | Fintava did not answer in time | `retryAfterSeconds` |
| `idempotency_key_required` | 400 | a money-moving request without `Idempotency-Key` | |
| `idempotency_key_reused` | 409 | same key, different body | |
| `idempotency_in_progress` | 409 | same key and body, first request still running | `retryAfterSeconds` |
| `pin_required` | 403 | a debit without `X-Transaction-Pin` | |
| `pin_not_set` | 409 | no PIN yet: the app opens PIN create (A9, W36) | |
| `pin_already_set` | 409 | POST /money/pin when one exists | |
| `pin_incorrect` | 403 | wrong PIN | `triesLeft` |
| `pin_locked` | 423 | too many wrong PINs | `lockedUntil` |
| `pin_mismatch` | 400 | the two entries of a new PIN differ | |
| `pin_changed_again` | 409 | a repeat (same Idempotency-Key) of a PIN change or reset whose first request landed but whose answer was never stored, arriving more than a minute later, after the PIN was changed again | |
| `reset_code_invalid` | 400 | wrong or expired reset code | `triesLeft` |
| `insufficient_funds` | 402 | balance below the total (H17, I6, S11, W13); one wording for every route, built by `insufficientFunds()` in `src/money/insufficient-funds.ts` (MONEY-19) | `balanceKobo`, `totalKobo`, `shortfallKobo` |
| `daily_limit_exceeded` | 403 | the send or purchase passes today's limit; stopped before money moves | `totalKobo`, `remainingTodayKobo` |
| `amount_out_of_range` | 400 | below the minimum, or above `MERCHANT_MAX_PER_TXN_KOBO` on money through WAWU's merchant wallet | `minimumKobo`, `maximumKobo` |
| `quote_changed` | 409 | `expectedTotalKobo` differs from the server's total | `feeQuote` or `paymentQuote` |
| `name_check_failed` | 422 | the bank did not confirm the account | |
| `account_name_changed` | 409 | a saved bank account whose holder's name, or whose bank's name, at the bank is no longer the one kept, or an account that is not saved whose holder at the bank is no longer the one the name check showed (WALLET-09, section 24): `accountName` and `bankName` as they stand now; nothing was sent. A saved account is confirmed by saving it again with `confirmCurrentName: true`; an unsaved one by a new name check |
| `account_not_in_your_name` | 409 | a payout account whose holder at the bank is not the person's verified name (the BVN name kept by the check, else the wallet's own account name; with neither, the answer is the same code with a plain reason and no `verifiedName`), on `PUT /money/payout-account`; or a withdrawal (a bank send to the saved payout account) while its holder is not, on `POST /money/transfers/bank`, answered before the PIN (no try used, the Idempotency-Key given back). Nothing is saved or sent. `accountName` and `bankName` are the bank's; `verifiedName` is the name on the person's wallet, left out when the wallet holds none. Sends to anyone else's account are unchanged (WALLET-37, R-51, G-765) | `accountName`, `bankName`, `verifiedName` |
| `name_check_rate_limited` | 429 | the person has run `name_check_per_hour` (launch value 30; an admin setting, read at every check) bank name checks in the hour, counted per signed-in person and never per address: `POST /money/banks/name-check`, `PUT /money/payout-account` and `POST /money/beneficiaries` for a bank account share the count, and so does `POST /money/transfers/bank` to an account that is not saved when its `nameToken` is not one this person got for that bank and account number (or is old, or missing). No check is made. The message gives the minutes left in plain words; also sent as the `Retry-After` header (WALLET-37, R-51, G-764) | `retryAfterSeconds` |
| `recipient_not_found` | 404 | no such WAWU user | |
| `recipient_has_no_wallet` | 409 | they have not opened a wallet | |
| `recipient_blocked` | 403 | a block between the two people | |
| `self_transfer` | 400 | sending to yourself, or saving yourself as a beneficiary | |
| `beneficiary_limit_reached` | 409 | the person already keeps the most beneficiaries allowed (`BENEFICIARIES_MAX`, PROVISIONAL); one must be removed first (WALLET-14) | |
| `bank_transfers_blocked` | 403 | sending to a bank is not allowed for this person now (W18) | `blockedBy` |
| `target_not_found` | 404 | the thing being paid for does not exist | |
| `target_not_payable` | 409 | it exists but cannot be bought now (already owned, sold out, closed) | |
| `not_found` | 404 | no such transfer, payment, hold or transaction for this caller | |
| `bvn_not_confirmed` | 422 | Fintava did not confirm the BVN (unknown or invalid) (KYC-01) | `checksLeft` |
| `bvn_phone_mismatch` | 422 | the BVN's phone is not the account's phone (A14); nothing from the BVN record is answered | `checksLeft` |
| `phone_not_nigerian` | 422 | the account's phone is not a Nigerian mobile, so no BVN can match it; Fintava is not asked | |
| `identity_checks_exhausted` | 429 | the person has used today's BVN checks; under a provider that reviews the person (Nuvion) also `POST /money/wallet/open` when today's opening tries are used (section 9a) | `retryAfterSeconds` |
| `bvn_not_checked` | 409 | A5's occupation, or a selfie match, sent before a BVN check passed; or a selfie match with a BVN other than the one that passed, or one whose BVN check was replaced by another while it was being matched | |
| `wallet_already_open` | 409 | a BVN check or selfie match from someone whose wallet is open | |
| `selfie_not_matched` | 422 | Fintava did not match the selfie to the BVN photo (A16) (KYC-02) | `checksLeft` |
| `selfie_checks_exhausted` | 429 | the person has used today's selfie matches (A16 and the retry rule); Fintava is not asked | `retryAfterSeconds` |
| `selfie_already_matched` | 409 | a selfie match from someone whose selfie already matched against their current BVN check | |
| `selfie_required` | 409 | account opening before a selfie matched against the BVN check whose BVN and NIN were sent (MONEY-12) | |
| `identity_has_wallet` | 409 | account opening for a BVN or phone another WAWU account opened a wallet with, or whose Fintava account another WAWU account holds; nothing is sent. Under a provider that reviews the person (Nuvion) it is the one plain answer for a BVN or phone another account holds, whether that account has a wallet or its opening is still being checked, and it does not say which (section 9a) | |
| `account_not_opened` | 422 | Fintava refused the details sent (a validation or identity refusal, such as a blacklisted NIN), or the account has no email; nothing was created and the person may try again | |
| `reset_codes_exhausted` | 429 | the person or the phone has had today's PIN reset texts (MONEY-14); nothing is sent | `retryAfterSeconds` |
| `device_approval_refused` | 403 | `X-Device-Approval` not accepted: not the registered phone, a wrong signature, a used, expired or another person's challenge, or no phone registered; never uses a PIN try (MONEY-14) | |
| `payment_in_progress` | 409 | a payment for this item by this person is still being confirmed (or is under review); a second one is not taken, under any Idempotency-Key (MONEY-17) | `paymentId` |
| `event_order_limit` | 409 | the buyer already holds the most open paid ticket orders one event allows (`events.open_orders_per_buyer` in the admin settings, launch value 10; an order that failed or was refunded does not count, a free order is never counted): refused on `POST /events/{id}/orders/wallet` when they are already at it, and again on `POST /events/orders/wallet/pay` inside the payment's claim, before anything is recorded or sent. "You have reached the order limit for this event." (EVENTS-13) | |
| `question_already_waiting` | 409 | the fan already has a paid question waiting on this creator (asked and not yet answered or refunded, or a payment for another still being confirmed): refused on `POST /dm/{creatorWawuId}/send/wallet` and again on `POST /dm/send/wallet/pay` inside the payment's claim. "You can send once they reply." (INBOX-17, G-75) | |
| `statement_rate_limited` | 429 | the person has asked for 5 statements in the last minute or 30 in the last hour (`STATEMENT_RATE_LIMITS`, PROVISIONAL), counted after the token is verified (WALLET-27) | `retryAfterSeconds` |
| `statement_busy` | 503 | two statements are already being built and no place came free within 5 s (`STATEMENT_CONCURRENCY`, PROVISIONAL) (WALLET-27) | `retryAfterSeconds` |
| `email_not_verified` | 409 | the account has no email address that WAWU ID says is confirmed (the token's `emailVerified` is not `true`, or its `email` is empty or not an address), so a statement is not emailed (WALLET-35); never counted against the statement limit | |
| `statement_email_failed` | 503 | the mail could not be handed to WAWU ID's sender (it was unreachable, busy, over its day's cap or refused it, or is not set up on this server), or WAWU ID did not say it took the file (its answer carries `attachments`, the number of files taken, and it must equal the one sent; a relay from before WALLET-35 answers none); asking again is right once WAWU ID is current (WALLET-35). The answer never names the address or WAWU ID's reason | |
| `recipient_search_rate_limited` | 429 | the person has searched for recipients 20 times in the last minute, 120 in the last hour or 500 in the last day (`RECIPIENT_SEARCH_PERSON_LIMITS`, PROVISIONAL), counted after the token is verified (WALLET-08); also sent as the `Retry-After` header | `retryAfterSeconds` |
| `statement_too_large` | 400 | the period holds more movements than one statement lists (`STATEMENT_MAX_ROWS`, 50,000); counted before anything is written, and the person picks a shorter range (WALLET-27). Also on `POST /money/statements/email`: the file is over 12 MiB (`STATEMENT_EMAIL_MAX_BYTES`, WAWU ID's cap), measured before anything is sent; it can never succeed on a retry (WALLET-35) | |
| `phone_held_by_other_identity` | 409 | account opening where Fintava already has a customer for the person's phone whose record does not carry the checked BVN (or carries none): nothing is adopted or created, and the opening stops for review (MONEY-12, BACKEND_GAPS G-37) | |
| `fees_not_set` | 503 | the running wallet provider's fees are settings not filled in yet (Nuvion's `NUVION_FEE_*`, R-42): every fee quote and every money-moving route answers it before anything is sent to the provider; the balance, the history and the account number are unaffected (NUV-07, section 11) | |
| `limit_reached` | 403 | the movement passes a limit: WAWU's own setting for its kind (`WAWU_LIMIT_<KIND>_<LIMIT>_KOBO`), checked before anything is sent, or the provider's own (Nuvion's per-transaction, daily or monthly refusal); the same answer either way (NUV-07, section 11) | `limit`: `per_transaction`, `daily` or `monthly` |
| `open_address_limited` | 429 | under a provider that reviews the person (Nuvion): one address has made `OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR` opening tries (default 10, PROVISIONAL) in the last hour, across every account; a plain 429 before anything is claimed, sent or counted for the account. A call with no client address (made on the server itself) is not limited by address (NUV-02 round 3, section 9a) | `retryAfterSeconds` |
| `identity_under_review` | 409 | under a provider that reviews the person itself (Nuvion): the person's details are with the provider's compliance review; they wait and nothing is sent again. The sentence promises a notification, and one is written when the review ends (NUV-02, section 9a). Any money route can answer it when the provider says so (`walletProviderErrorToHttp`) | |
| `step_not_used` | 409 | `POST /money/identity/bvn` under a provider with no BVN lookup (Nuvion): that step does not exist there, the BVN is checked inside the review when the details are sent to open the wallet. Permanent, never "try again"; nothing is hashed, counted or sent (NUV-02 round 2, section 9a) | |
| `below_minimum` | 422 | `POST /points/convert` with fewer points than the config's minimum; answered before the PIN, nothing held or changed (POINTS-04, section 20) | `minimumPoints`, `balancePoints` |
| `insufficient_points` | 402 | more points than the person has (`PointsError`, section 16); answered before the PIN by the conversion, and again under the person's points lock (POINTS-04) | `balancePoints`, `neededPoints`, `shortfallPoints` |
| `points_not_cashable` | 422 | `POST /points/convert` with more points than the person's earned and bonus points: points they bought are in the balance and can never be cashed out (R-101 point 7, POINTS-BOUGHT). Answered before the PIN, and again under the person's points lock; nothing is held | `balancePoints`, `cashablePoints`, `neededPoints` |
| `currency_not_supported` | 409 | `GET /points/convert/quote` or `POST /points/convert` for a person billed in dollars: their cash would be dollars and the dollar wallet is not built (NUV-09). Nothing is held (POINTS-04) | |
| `capital_unavailable` | 409 | Capital is switched off (the plan setting `capital.enabled`), or the running wallet provider has none, or an admin holds this order; nothing was sent (NUV-12, section 28) | |
| `reservation_expired` | 409 | the 15 minutes of a Capital reservation ran out (or the provider says it can no longer be confirmed and the order was not approved); nothing was taken, the person starts again (NUV-12) | |
| `withdrawal_not_available` | 409 | the provider will not pay this holding out now (locked, early exit off, already paid out) or has nothing to preview; before the PIN, no try used (NUV-12) | |

The same table is `MONEY_ERROR_STATUS` in `src/money/money-contract.ts`; each
operation in the contract lists the codes it can answer with, grouped by
status.

## 4. `Idempotency-Key` on every request that moves money

**Which requests:** `POST /money/transfers/wawu`, `POST /money/transfers/bank`
and `POST /money/payments`, `POST /plans/purchases` (a tier bought from the
wallet, TIER-03: its stored answer is the purchase, not the bare payment;
docs/contract/PLANS.md section 8), and every money-moving route added later. Without
the header: `400 idempotency_key_required`. Format: 8 to 128 characters of
`[A-Za-z0-9_-]`.

**The app:** makes one key (a UUID v4) when the person first taps Send or Pay,
keeps it with that payment's screen state, and sends it again unchanged on
every retry of the same intent (a timeout, a network error, a 5xx, a
double tap). A new intent gets a new key: a different amount, or "Try again"
after a send that failed (W14).

**The server:**

1. The key is scoped to `(wawuUserId, method, route, key)`. Its fingerprint is
   the SHA-256 of the request body as canonical JSON (keys sorted). Headers
   are not part of it, so the PIN is not either.
2. The key row is inserted first, as `in_progress`, under a unique
   constraint: the constraint is the lock, the way this backend already makes
   things idempotent (`WalletLedgerEntry.reference` is unique and "the caller's
   idempotency key"; the funding sweep derives its reference from the source;
   a duplicate insert is mapped to 409 by `AllExceptionsFilter`, P2002).
3. **Same key, same body, finished:** the stored HTTP status and body are
   answered again, with the header `Idempotent-Replayed: true`. Nothing moves,
   the PIN is not checked again and no PIN try is used.
4. **Same key, same body, still running:** `409 idempotency_in_progress`, with
   `retryAfterSeconds`.
5. **Same key, different body:** `409 idempotency_key_reused`. Nothing runs.
6. **What is stored:** the outcome of every request that got past the checks
   made before money moves (validation, wallet state, PIN, quote, funds,
   limit), whatever it was: completed, pending or failed. A refusal before
   that point is not stored and releases the key, so the same key can be sent
   again once the cause is fixed (the right PIN after a wrong one, or after a
   top-up).
7. Keys are kept for at least 24 hours: `IDEMPOTENCY_KEY_HOURS`
   (PROVISIONAL, 48 by default, 24 to 720), then purged hourly (MONEY-17).
8. **As built (MONEY-17, `src/money/payments/idempotency.ts`):** the key is
   taken (rule 2) by `IdempotencyGuard`, after the wallet gate and before
   the PIN, so taps at once reach the PIN, the quote and Fintava once; the
   others get the replay or `idempotency_in_progress`. The row is linked to
   the payment in the transaction that creates it, before Fintava is
   called. A refusal before that (rule 6) deletes the row
   (`IdempotencyFilter`). A key left `in_progress` past the money timeout
   plus a minute is answered from its payment's record as it stands, or,
   when no payment was made, freed. A route that moves money uses
   `@RequireIdempotentApproval(route)` (WALLET-07 and WALLET-09 too).

**Not only money: community messages.** `POST /communities/:id/messages` takes an
OPTIONAL `Idempotency-Key` (the same 8 to 128 characters of `[A-Za-z0-9_-]`; INBOX-05
round 5). Without it the route behaves exactly as it always has. With it, per
`(wawuUserId, key)` the message is stored and its credit charged once; a repeat answers
with the first message as stored (same status and body) and `Idempotent-Replayed: true`,
and stores, charges and publishes nothing. The unique index is the lock, not a read:
two requests with one key at the same moment, on one server or two, still store once
(`CommunityMessageKey`, primary key sender plus key, written with the message before the
credit is taken). The same key for other words or another room is
`409` with `reason: idempotency_key_reused`. A refusal (402, 403, 400) stores nothing and
leaves the key free to use once the cause is fixed. The app makes one key per message and
sends it again unchanged on every retry of that message.

**Not only money: a creator's reply to a paid question.** `POST
/paid-dm/questions/:messageId/replies` takes an OPTIONAL `Idempotency-Key` too (the
same 8 to 128 characters of `[A-Za-z0-9_-]`; INBOX-18 round 2). Without it the route
behaves exactly as it always has: every call is a bubble. With it, per `(creatorWawuId,
key)` the bubble is stored once (`DmReplyKey`, primary key creator plus key, written with
the bubble by one nested create, so the unique index is the lock). A repeat, and a second
request with the same key at the same moment on one server or two, answers `201` with the
question as it stands (the first bubble in it once, and any later bubble too) and
`Idempotent-Replayed: true`, and stores nothing, releases nothing and asks no one again.
A key still in flight is answered this way, not with `idempotency_in_progress`: the second
request waits on the index for the first to commit and then answers with its bubble. The
same key for another question or other words is `409` with `reason:
idempotency_key_reused`. A header that is not 8 to 128 of `[A-Za-z0-9_-]` is `400`. A
refusal (403, 404, 409 for the window) stores nothing and leaves the key free. The app
makes one key per reply attempt, keeps it across a retry of that attempt, and makes a new
one for a new reply.

**What a community message costs (INBOX-22, R-62).** By kind, in WAWU Credits (a count,
never naira): text and emoji 0, a photo `community_credit_cost_photo` (1), a video
`community_credit_cost_video` (3), a voice note `community_credit_cost_voice` (3), the admin
settings of TIER-06, read when the message is sent. `GET /communities/message-cost` answers
`creditsPerMessage` (what a plain message costs: 0) and `creditsByKind` (`text`, `photo`,
`video`, `voice`). A message carries at most one of `imageUrl`, `videoUrl` and `voiceUrl`
(a second is `400`); a `videoUrl` or `voiceUrl` must be the sender's own confirmed upload
(`POST /uploads/presign` for `community/message-video` or `community/message-voice`, then
`POST /uploads/confirm`) and the link must be the `fileUrl` presign handed back, on this bucket's
own host, or it is `400` and nothing is charged. An `imageUrl` is held to the same rule (FIX-77):
the `fileUrl` of the sender's own `POST /uploads/presign` for `community/message`, on this
bucket's own host; it needs no confirm (the web never confirms a photo), so a presigned or a
confirmed upload both pass, and any other link, another person's file or another folder's file
is `400` ("That photo could not be sent. Choose it again.") with nothing stored or charged. Text sent with an
attachment adds nothing. The host sends every kind free in their own room. A free message
writes no credit row at all (no balance row is made, no ledger row, no host earning). A sender
whose credits do not cover the message gets `402` with `reason: "insufficient_credits"` and a
sentence that says what the kind costs, what they have and how many they are short; nothing
is stored or taken, and the key stays free. The message, the debit and the ledger row are
one transaction, so a send that fails after the debit gives the credits back.

**On the PIN routes (optional).** `PUT /money/pin` and `POST /money/pin/reset/confirm`
move no money, so they do not need a key, but they take one if it is sent
(WALLET-06 round 2). A phone whose answer to a PIN change or a reset was lost
sends the same request again with the same key, instead of judging by whether
`changedAt` moved (which is also true when someone else changed the PIN) or
spending a wrong-PIN try to ask. Without the header nothing is stored and the
routes answer as they always did. With it, the store and rules 1 to 7 above
are the payments' own (`MoneyIdempotencyKey`, `IdempotencyService`), with these
differences:

- The key is optional. One that is sent but is not 8 to 128 of `[A-Za-z0-9_-]`
  is `400 idempotency_key_required` (refused, not ignored).
- The replay is answered before the PIN guard, because the PIN a landed change
  was sent under is no longer the PIN: a repeat uses no try. A repeat of a
  change someone else has beaten is not a replay (nothing was stored): it runs,
  and is refused for its PIN (`403 pin_incorrect`) or its dead code (`400
  reset_code_invalid`).
- The key is linked to the person's PIN in the same transaction that changes
  it, and the answer is stored right after. A row that names the PIN means the
  PIN changed; one that names nothing and is more than a minute old means the
  request died first and the key is free again; one that names the PIN, has no
  answer and is more than a minute old is answered with the PIN's state as it
  stands.
- The fingerprint of the body is an HMAC-SHA256 under a key only the Hub
  holds, not SHA-256, because the body holds the new PIN: the key is derived
  from `WAWU_ID_INTERNAL_SERVICE_KEY` (already required to start in
  production, so no new setting) with the fixed label
  `wawu-hub:pin-request-fingerprint:v1`, and the person, route and key are in
  what is signed, so the same request always gives the same text and a read
  of the table alone reveals no PIN. A row written before this (argon2id,
  `$argon2id$...`) is read as it was until it expires; nothing writes that
  form any more. The stored answer is the PIN's state, never a PIN or a code.
- The two refusals the store gives a repeat are worded for the PIN, not for a
  payment: `idempotency_in_progress` says "Your PIN change is still going
  through. Check again in a moment." (a reset: "Your PIN reset is still going
  through. ..."), and `idempotency_key_reused` says "Start again to change your
  PIN." (a reset: "Start again to reset your PIN."). Same codes, same shape.
- A row that names the PIN, has no answer and is more than a minute old is
  answered `200` with the PIN's state only if the PIN is still the one the
  repeated request carries (its hash verifies against that request's new PIN;
  nothing is counted); otherwise `409 pin_changed_again` ("Your PIN was
  changed again since. Check it in Wallet settings."), and nothing is stored,
  so each repeat is answered from the PIN as it stands.
- The two codes `idempotency_key_reused` and `idempotency_in_progress` are
  documented in the header's description, not in the route's `reason.code`
  lists: those lists are how `money-moving-coverage.spec.ts` tells a route
  moves money, and these two do not.

**Fintava has no Idempotency-Key** (`naira-api.md`). Ours is enforced here.
The reference we send Fintava as `CustomerReference` is derived from our own
transaction id, not from the app's key (which is only unique per person).
`/transaction/wallet-to-wallet`, `/bank/credit/merchant` and `/bank/credit`
all take it and refuse a repeat (OPS-02, `sandbox/13-`, `14-`; question 1
answered). A send whose answer was lost is never sent again blindly: the
Fintava client (MONEY-06, `src/fintava/`) asks Fintava first, by our
reference and then from history, because a lookup can answer `200 {}`,
which is neither found nor not found. Only Fintava's own JSON
`404 "Transaction not found!"` with no row in the sender's history counts
as "Fintava does not have it", and only once the money timeout plus a
safety window (`FINTAVA_RESEND_SAFETY_MS`, ten minutes) has passed since
the first send: Fintava keeps working after the client gives up. Then a
wallet-to-wallet send goes again under the same reference, and a bank send
only under a new one (a refused bank send can leave a `PENDING` record and
use its reference up). A repeated reference means the earlier send exists:
it is reconciled, never refunded or charged again. Anything still pending
or unknown stays `pending` until MONEY-08 has asked Fintava again, holding
one retry at a time per payment.

## 5. The transaction PIN

- **How it is sent:** in the header `X-Transaction-Pin: 1234`, on every
  request that moves money and on `PUT /money/pin` (the current PIN) and
  `POST /money/pin/verify`. Four digits, `^[0-9]{4}$`.
- **Never in a URL or a query** (proxy logs, browser history), **never in the
  body of a debit**: the body is the idempotency fingerprint and is what an
  error reporter captures; the PIN is a credential for the request, not part
  of what the request is. A single guard (MONEY-09) reads one header on every
  debit route, so no DTO has to remember it.
- **A new PIN** (set, change, reset) is the subject of its own request and
  travels in that route's body: `pin` and `pinConfirmation` (A9 then A10),
  `newPin` and `newPinConfirmation`. The server compares the two entries
  (`400 pin_mismatch`); the app does not need to.
- **Never logged, stored or echoed.** No request logger exists today
  (`AllExceptionsFilter` logs only exception messages). Anything that logs
  requests later, an error reporter, or a trace (the protected route suite's
  `PROTECTED_ROUTES_TRACE`), drops the `x-transaction-pin` header and the
  `pin`, `pinConfirmation`, `newPin`, `newPinConfirmation` and `code` fields.
  The PIN is stored only as a slow hash (`argon2`, already a dependency) by
  MONEY-09 and is never in a response.
- **Checked** after the token, before the quote, the balance and the limit,
  by `TransactionPinGuard` (`@RequireTransactionPin()`, `src/money/pin/`,
  MONEY-09). Nest runs guards before pipes, so the PIN is checked before the
  body is validated: a malformed body with a wrong PIN still uses a try.
  Missing, sent twice, or not four digits: `403 pin_required`, and no try is
  used. Not set: `409 pin_not_set`. Wrong: `403 pin_incorrect` with
  `triesLeft` (4, 3, 2, 1). The fifth wrong try in a row answers
  `423 pin_locked` with `lockedUntil` (not "0 tries left"), and so does every
  try until then, the right PIN included. The lock lasts `PIN_LOCK_MINUTES`
  (config, provisional 30). A check reserves a slot before the hash is
  compared (one conditional update: wrong tries plus checks still running
  stay below five), compares with no transaction, row lock or database
  connection held, and records its result in one more update. So tries sent
  at the same moment can never be compared past five together, a right PIN
  never uses up a try however many arrive at once, and one person's checks
  cannot hold up anyone else's requests; a check that finds every slot taken
  waits for one (in memory) and answers the lock as soon as there is one. A
  slot left by a check that died frees itself after 30 seconds. A check held up past that (a saturated thread pool) can lose its slot, so more than five wrong compares can happen; what holds is what is answered: every wrong compare counts when recorded (at most four are ever answered `pin_incorrect` before the lock), a lock already set is not extended, and a PIN that is locked at the moment a result is recorded answers `423 pin_locked`, a right PIN included (R3-2). A right PIN
  resets the count; so does the end of a lock; a reset by code
  (`/money/pin/reset/confirm`, MONEY-14) clears the lock.
- **The guard removes the header** from the request once read (`headers` and
  `rawHeaders`), so nothing that runs after it can log or report it. An
  idempotent replay must not check the PIN again (section 4, rule 3), so
  whatever answers replays runs before the guard.
- **Fintava has no wallet PIN** (only card PINs), so this PIN guards WAWU's
  API, not the account at Fintava.
- **Approving with a fingerprint or a face** (W11, W35; R-26; MONEY-14): a
  biometric approval from the registered phone stands in for the PIN. It is
  a key the phone holds and the server checks, never a "true" from the app:
  - **The phone's key.** The app makes a P-256 key pair whose private half
    only the phone's biometric unlocks (kept where only the biometric
    prompt releases it; the app side is WALLET-06's, mobile BACKEND_GAPS
    G-43), and turns approval
    on with `PUT /money/device` `{ publicKey, biometric }`: the public half
    as SubjectPublicKeyInfo DER, base64url, and `fingerprint` or `face`,
    with the current PIN in `X-Transaction-Pin` (only the PIN adds a phone).
    One phone per person: registering another replaces it and gets a new
    `deviceId`. `GET /money/device` says which phone is registered (the app
    compares the `deviceId` it kept); `DELETE /money/device` turns it off.
  - **One approval.** `POST /money/device/challenge` answers `challengeId`,
    `challenge` (32 random bytes, base64url), `deviceId` and `expiresAt`
    (`DEVICE_APPROVAL_SECONDS`, provisional 120). After the biometric prompt
    the phone signs, with ECDSA P-256 and SHA-256 (signature DER), these
    lines joined by `\n`: `wawu-device-approval-v1`, `challengeId`,
    `challenge`, `deviceId`, the method in capitals, the path as sent with
    its query (`/api/hub/money/...`), and the SHA-256 hex of the exact body
    bytes (of nothing when there is no body). It sends
    `X-Device-Approval: v1.<challengeId>.<signature base64url>` instead of
    `X-Transaction-Pin`. A challenge works once, right or wrong, for that
    person and that phone; the signature covers that one request, so it
    cannot move to another payment, amount or recipient.
  - **Which routes.** `@RequireApproval()` (`src/money/pin/`) on every route
    that moves money from MONEY-14 on (WALLET-07, WALLET-09 and MONEY-17
    swap `@RequireTransactionPin()` for it when they serve the debits, and
    the MONEY-04 debit header test then expects the pair) and on
    `POST /money/approval/verify` (check an approval without moving money).
    It is the same `TransactionPinGuard`, which also takes an approval on
    those routes only. Changing the PIN, checking the PIN
    (`/money/pin/verify`) and adding a phone stay PIN only: there an
    approval header is removed and ignored.
  - **Refusals.** Anything not accepted is `403 device_approval_refused`;
    the app shows "<Name> failed. Use your PIN." (R-26) and the keypad. It
    never uses a PIN try, and a passed approval does not reset the count.
    With `X-Device-Approval` sent, a PIN header beside it is removed unread.
    While the PIN is locked a passed approval is `423 pin_locked` too
    (Default (agent), owner may override; BACKEND_GAPS G-9). Both headers
    are removed from the request once read, as the PIN header is.
- **Both are behind the wallet gate** (MONEY-13): every `/money/device`,
  `/money/approval/verify` and `/money/pin/reset` route answers `409
  wallet_not_open` or `409 wallet_opening` first, and the gate drops
  `X-Device-Approval` unread with the PIN header.
- **Resetting the PIN by a code** (W37; MONEY-14): `POST /money/pin/reset`
  texts a 6-digit code through Fintava's `POST /sms/send` to the phone the
  BVN check proved (`WalletIdentity.verifiedPhone`; none: `409
  wallet_not_open`), never to a number the caller or the token names, and
  answers `resetId`, `sentTo` (last 4 digits), `resendAvailableAt` and
  `expiresAt`. Asked again before Resend opens, it answers the same reset
  and sends nothing; after, a new code, and only the newest code works.
  `POST /money/pin/reset/confirm` takes `resetId`, `code`, `newPin`,
  `newPinConfirmation`: a mismatch is checked first (no try of the code);
  the code gets five wrong tries (the PIN's own five), counted before it is
  compared (`400 reset_code_invalid` with `triesLeft`, 0 when dead,
  expired, used, replaced or not this person's), works once, and is stored
  only as an argon2id hash. The right code sets the new PIN, clears the
  count and the lock, and turns biometric approval off (`DELETE
  /money/device`'s effect). Texts: `PIN_RESET_TEXTS_PER_DAY` (provisional
  5) in any 24 hours per person and per phone (`429
  reset_codes_exhausted`); code life `PIN_RESET_CODE_SECONDS` (300), Resend
  `PIN_RESET_RESEND_SECONDS` (60). So a day allows at most 25 guesses at a
  million codes against the PIN's 240 at ten thousand. A text Fintava
  refused was not sent (`503 provider_unreachable`, not counted, its code
  never works); a text whose answer was lost may have arrived (`503`
  with `retryAfterSeconds` until Resend opens; it counts, its code works,
  and it is never sent again blindly).
- **The app** never stores the PIN and drops it from memory once the request
  is answered.

## 6. Cursor pages

- Money lists that grow (history, holds) are cursor-paged:
  `?cursor=<opaque>&limit=<1..100, default 20>`, answered as
  `data: { items: [...], nextCursor: string | null }`, newest first.
  `nextCursor: null` is the last page. The cursor is opaque: send it back as
  given (the server encodes the last row's time and id).
- **Why not the existing paging:** this backend's lists are offset-paged
  (`page`, `perPage`, a `pagination` block; `PaginationQueryDto`). History
  gains rows while someone scrolls (webhooks land at any time), so an offset
  page shifts and repeats or skips rows. Fintava's own history is
  offset-paged and cached for about 5 minutes per `page` and `take`
  (`sandbox/10-merchant-history.md`), which is also why our history pages our
  own ledger (MONEY-10) rather than Fintava's list.
- **No change to `src/common`:** `ResponseInterceptor` only rewrites a value
  that has `items` and a numeric `total`; a cursor page has no `total`, so it
  goes out unchanged inside `data`.
- Each list has its own named page type (`TransactionPage`, `HoldPage`), not
  a generic `CursorPage<T>`: the enricher inlines a generic instantiation,
  which is the duplication G-1 asks to stop.
- Short lists (banks, recipients, beneficiaries) are plain arrays with a
  stated maximum and no paging.
- **A cursor page ordered by text names its collation in the query** (FIX-27).
  A text column sorts by the collation its database was made with (CI's
  `postgres:16` is `en_US.utf8`, a laptop `C.UTF-8`, an ICU database a third
  way), so a list left to the column comes in a different order on each, and a
  cursor compared against it can disagree with the page. Write `COLLATE "C"`
  (built into every Postgres) on the `ORDER BY` and on the cursor's
  comparison, built from the same expressions: the schools list does
  (`src/schools/schools-order.ts`), the inbox does for its text key. Keys that
  are times or uuids need nothing.

### The history (MONEY-15)

`src/money/history/`. It reads the ledger (MONEY-10) and nothing else: no
Fintava call, so no `provider_unreachable`, and a frozen wallet's history
still reads. Every answer is `Cache-Control: no-store`.

- **Whose rows:** only rows on the caller's own wallet (`walletKind` user,
  the token's wawuUserId and the account number of the wallet the gate
  found). All three routes carry `@RequireOpenWallet()` (section 7, the
  wallet gate): no wallet is `409 wallet_not_open` (`wallet_opening` while
  MONEY-12 opens it) in the gate's words. Someone else's row, or no row:
  `404 not_found`.
- **Status** is the ledger's, which only Fintava's word moves (a send's
  answer, a signed delivery, a lookup, MONEY-08's sweep): a row the sweep
  has not settled shows `pending`, and a row whose sightings disagree stays
  as stored (`discrepancy`, MONEY-16).
- **Order:** newest first by `occurredAt` (when the money moved), then id.
  A page ends with `nextCursor: null` only when nothing follows (a last page
  that is exactly full carries none either).
- **The scroll's snapshot** (MONEY-15 rounds 2 and 3).
  - A first page takes the server's clock (milliseconds) as the scroll's
    snapshot. The cursor (`c2.` + base64url) carries the last row's
    (`occurredAt`, id) and that snapshot. The group key (`g2.` + base64url)
    carries a piece, a Lagos day and the snapshot of the read that showed
    the row.
  - Every page of one scroll groups as of a fixed bound: the snapshot minus
    `LEDGER_WRITE_MAX_MS` (5 s). A grouped row's members are the unlocks
    whose `completedAt` is at or before that bound.
  - The 5 s is how long a ledger write can run from stamping `completedAt`
    to committing: Prisma's default interactive-transaction timeout. The
    ledger's writers pass no timeout, and `PrismaService` sets none;
    `history-units.spec.ts` fails if either starts to.
  - So these unlocks stay their own row in that scroll and cannot move a
    group across a cursor already handed out: one that lands mid-scroll,
    one that settles mid-scroll, and one whose write was in flight when the
    first page was read. An unlock completed in the last 5 s is its own row
    until a refresh after that. The next refresh (a new first page) groups
    them.
  - Why not anchor a group to its first member: the anchor alone still
    shows a settling unlock twice (pending on a page already read, then
    inside its group). It would also put a group below rows newer than its
    `createdAt`, which stays its latest member's (Lead ruling 3).
  - The bound is compared with `completedAt`, which the ledger stamps with
    the same server clock.
  - A cursor or key the server did not write is a plain 400
    (`cursor is not one this history gave.`, `group is not a key this
    history gave.`). That includes round 1's `c1.` and `g1.`, and any time
    dated year 0000, which Postgres cannot hold.
  - **What one scroll can still get wrong, each corrected by a refresh:**
    - *A row whose time moves earlier mid-scroll.* MONEY-10's merge keeps
      the earliest `occurredAt`, and MONEY-08's sweep settles a pending
      row with Fintava's own time. A row already shown can sort below the
      cursor and show a second time. This is not about grouping; round 1's
      cursor did the same. Today only a pending row is settled this way,
      so it is a duplicate. If a completed row's time ever moved across
      Lagos midnight into a day with a group of the same piece (only a fold
      of two rows of one movement could do that), that group could move
      and its members go missing from that scroll.
    - *A completed unlock put back to `pending` by a disagreement*
      (MONEY-08, a stop; `completedAt` is cleared). If its group was
      already shown, its money shows twice in that scroll: the group comes
      back lower with its other members, or the unlock comes back as its
      own pending row, and the key of the group already shown lists one
      member fewer than its count. If its group was still below the
      cursor, everything shows once.
    - Apart from these, every movement that existed before the first page
      shows exactly once in the scroll, as a row or inside a group.
- **Groups** (WALLET.md, Lead ruling 3): two or more unlock earnings of
  one piece on one Africa/Lagos day, completed by the group bound, are one
  row. Its id, reference and `createdAt` are its latest movement's,
  `amountKobo`, `fee` and `totalKobo` the sums, `counterparty`, `note`,
  `transferId` and `paymentId` null. A pending or failed unlock stays its
  own row. `group=<key>` lists the movements the row stood for, one per
  row, and ignores `filter`, `q` and `month`.
- **Filters:** `money_in` and `money_out` by direction; `bills` is category
  `bill` or a link of kind `bill` (a held bill payment too); `content` is a
  link of kind `content_unlock` or `tip`. `month` is `YYYY-MM` in
  Africa/Lagos time.
- **Search** (`q`) is trimmed first, then must be 2 to 60 characters
  (`" P "` is a 400). It matches, case-insensitively,
  a part of what the row shows: the counterparty's name or handle, the
  description, the note and the reference. `%`, `_` and `\` are only
  characters. A grouped row is searched by its description only.
- **Description:** the label, then the link's title, then the bank when the
  other side is a bank account, joined with " · " ("Transfer · GTBank",
  "Unlock · Lighting night shoots · 3 buyers"). Labels are in
  `history-labels.ts`; the SQL that searches and the text that is sent are
  built from the same table.
- **Fees:** a money-in row has none. A money-out row shows the split the
  sending feature quoted (`providerFeeKobo`, `wawuFeeKobo`) when amount plus
  both equals the total Fintava reported; otherwise Fintava's own charge
  (`feeKobo`) as the provider fee and WAWU's as 0. `totalKobo` is always the
  stored total.
- **Counterparty:** the name the movement recorded, else (someone on WAWU)
  their wallet's account name as Fintava gave it at opening
  (`FintavaWallet.accountName`, MONEY-12), else their `@handle`, else a plain
  word for the kind (a Fintava delivery names nobody); a bank account's number only as
  its last 4 digits; an avatar only for someone on WAWU.
- **Reference:** ours (`customerReference`) first, else Fintava's
  reference, the session id, the transaction id, the tagapay reference,
  else the row's id. Ours first is what G-44's fix (the receiver's row
  holding ours) relies on.
- **Month summary:** the sums of that Africa/Lagos month's `completed`
  rows by direction (`totalKobo`: out is what left, fees included; in is
  what arrived). Pending, failed and reversed rows are not in it, and
  grouping never changes it. It is never called, or shown as, a balance.

## 7. Everything else

- **The caller is the token.** No money route takes the wawuUserId of whose
  wallet to act on (`WalletController`'s rule, kept).
- **No wallet yet** (R-6, MONEY-13): `GET /money/wallet` answers 200 with
  `state: "not_open"` so the Wallet tab can open "Open your wallet"; every
  other money route answers `409 wallet_not_open` (`wallet_opening` while
  the account is being created, `423 wallet_frozen` when frozen).
  - **The wallet gate** (`src/money/gate/wallet-gate.ts`) is how: a route
    that reads or moves a person's wallet carries `@RequireOpenWallet()`
    (`@RequireTransactionPin()` brings it, ahead of the PIN), and the gate
    answers before the PIN, the body, the quote or Fintava. New and
    existing users alike: a web user's Flutterwave wallet
    (`CreatorWallet`) is not a Naira wallet here.
  - **One body per code, on every route**: `{ statusCode: 409, message,
    data: null, reason: { code, message } }` with `message` "You don't
    have a wallet yet. Open your wallet to continue." for
    `wallet_not_open` and "Your account is still being opened. Check
    again in a moment." for `wallet_opening`. The app switches on
    `reason.code` and leads to Open your wallet (A26) or A7's wait.
  - **One rule** (`walletStateOf`) decides `GET /money/wallet`'s `state`
    and the gate's code, so the two never disagree: a `FintavaWallet` row
    is `open`; an opening `opening`, `unknown`, `open` (row not yet
    visible) or `conflict` held for review is `opening`; nothing, a
    `failed` opening, or one stopped because the phone's Fintava customer
    is not this person (section 9) is `not_open`. `423 wallet_frozen` is
    never answered from storage (nothing stores a freeze): it is Fintava's
    own refusal on the call a route makes.
  - **A person without a wallet never uses a PIN try**, and the PIN they
    sent is dropped from the request unread when the gate refuses.
  - **Not gated:** Open your wallet itself (`/money/identity/*`, `POST
    /money/wallet/open`), `GET /money/wallet`, and the declared bank list
    and name check (WALLET-09), which read no wallet.
  - **Held to it by** `src/money/gate/tests/wallet-gate-coverage.spec.ts`
    over every controller AppModule mounts: a route that documents the gate
    codes runs the gate and the reverse, the gate runs before the PIN, and
    every `/money` route is gated or listed there with its reason. A task
    that serves a declared wallet route puts `@RequireOpenWallet()` on it
    (MoneyModule exports the gate; `@CurrentWallet()` hands the route the
    wallet the gate found). `wallet-gate.contract.spec.ts` sends every
    gated route MoneyModule mounts, whatever it is sent, as each kind of
    person without a wallet.
- **Fees** come from config (R-10), never from the app or the canvas. Every
  quote, transfer, payment and history row carries a `FeeBreakdown`
  (`providerFeeKobo` + `wawuFeeKobo` = `totalFeeKobo`), and a send repeats the
  quote's `totalKobo` as `expectedTotalKobo`, so the fee shown is the fee
  charged (`409 quote_changed` with the new quote otherwise).
- **Bank name, licence and deposit-insurance lines** come from what Fintava
  returned and from owner config (R-1), never from the canvas.
- **Times** are ISO 8601 UTC strings. A month is `YYYY-MM` in Africa/Lagos
  time. Ids are UUIDs.

## 8. Open your wallet's identity step (KYC-01, KYC-02)

- **Routes** (`src/money/identity/`): `POST /money/identity/bvn` with
  `{ bvn, nin }` (A26) runs Fintava's `GET /compliance/verify/bvn` through
  the MONEY-06 client and answers `BvnCheckView`: A5's prefill (`firstName`,
  `middleName`, `lastName`, `dateOfBirth` as `YYYY-MM-DD`, `gender` as
  `male` or `female`, each null when Fintava did not give it in a form we
  read) and the step's state. `GET /money/identity` answers that state
  (`WalletIdentityView`: the BVN's last 4 digits and when it passed, the
  NIN's last 4, the occupation, checks left today). `PUT
  /money/identity/occupation` stores A5's occupation once a check passed.
- **What is stored.** The time the check passed, an HMAC-SHA256 of the BVN
  and of the NIN under `IDENTITY_HASH_KEY` (a keyed hash: an 11-digit number
  has 10^11 values, so a plain or salted hash can be walked), the last 4
  digits of each, the account phone that matched (E.164), and the
  occupation. Never the full BVN or NIN, the BVN record's name, date of
  birth, gender, phone or photo, or the address. Since WALLET-14 the words
  of the BVN record's first and last name are kept as keyed hashes only
  (`bvnNameKeys`, section 10), so a payout account's name can be compared
  with the BVN name; the name itself is still never stored. The prefill is answered
  once and not kept. The steps after this one need the numbers again
  (Fintava takes them in full), and get them one of two ways: from the app
  again (MONEY-12's opening checks the BVN and the NIN with
  `checkedIdentity`, the NIN required; KYC-02's selfie, sent the BVN only,
  uses `checkedBvn`), or from the check handle below (KYC-03), which the app
  sends in their place so that nothing on the phone keeps the numbers.
- **The check handle (KYC-03, mobile BACKEND_GAPS G-72).** A check that
  passes also answers `checkHandle`: `v1.` and base64url of a 12-byte
  nonce, the AES-256-GCM sealed JSON `{ sub, bvn, nin, checkId, iat, exp }`
  and its 16-byte tag, with the label `wawu/kyc-check-handle/v1` as
  associated data, under a key derived from `IDENTITY_HASH_KEY` with
  HKDF-SHA256 and that label (`IdentityHasher.deriveKey`; no new setting:
  wherever the check can run, the key exists). `checkId` is the
  `BvnCheckAttempt` that passed; `exp` is 30 minutes after `iat`
  (`CHECK_HANDLE_TTL_SECONDS`, Default (lead), owner may override). The
  selfie match takes `checkHandle` in place of `bvn`, the opening in place
  of `bvn` and `nin`; sending both is a 400. The server opens it and
  requires all of: the seal (a changed byte, another key or another
  version fails), `exp` not passed, `sub` the caller, `checkId` a
  `verified` check of the caller's, and the sealed BVN and NIN the ones the
  caller's current check was run with (`checkedByHandle`, then the same
  one-read rules as the numbers). Any failure is one answer, `409
  bvn_not_checked` "Check your BVN again to continue.", never a 500 and
  never which part failed; a handle that is not a string or is over 1,024
  characters is a 400 with one fixed sentence. The handle is never stored,
  logged or echoed (`src/money/identity/tests/check-handle.contract.spec.ts`
  scans logs, rows and answers). The app holds it in memory with the passed
  check and drops it on every session end. The numbers sent again keep
  working as before (additive).
- **A14.** The BVN record's phone must be the account's phone (the token's
  `phone`, compared after both are normalised as in section 2). If it is
  not, or the record has none: `422 bvn_phone_mismatch` with A14's own
  sentence. The answer carries nothing from the BVN record, not even a
  masked phone (A14 draws none), so a BVN typed by someone else reveals
  nothing about its owner.
- **Limits** (Fintava charges every check, even a refused one). Per person:
  3 checks in any 24 hours (`BVN_CHECKS_PER_DAY`, PROVISIONAL), counted in
  `BvnCheckAttempt`; the fourth is `429 identity_checks_exhausted` with
  `retryAfterSeconds`, and Fintava is not asked. A check that never reached
  the provider (no key, a key refused, the merchant gate) is given back.
  Per address: the app's global throttler, `short` 3 a minute and `medium`
  20 an hour on this route (PROVISIONAL); its 429 has no `reason`. The
  address is the caller's, not nginx's: from a loopback peer the last
  X-Forwarded-For entry (the one nginx appends), from anyone else the peer
  itself (`bvnCheckTracker`; the app sets no `trust proxy`, mobile repo
  BACKEND_GAPS G-20).
- **Without settings.** No `FINTAVA_*` (production before OPS-10) or no
  `IDENTITY_HASH_KEY`: the server starts, and the BVN check answers
  `503 provider_unreachable` without calling out or counting a check.

### The selfie match to the BVN photo (KYC-02)

- **Routes** (`src/money/identity/`): `POST /money/identity/selfie` with
  `{ bvn, image }` (A6) runs Fintava's `POST /compliance/verify/bvn/selfie`
  through the MONEY-06 client and answers `SelfieMatchView` (`matchedAt`,
  `checksLeft`). `GET /money/identity/selfie` answers the same state. It is
  a face match against the BVN record's photo, not a liveness check:
  Fintava offers none, and no answer, message or screen may claim one.
- **Input.** `image` is plain base64 (no `data:` prefix) of a JPEG or PNG,
  1 KB to about 75 KB (at most 100,000 base64 characters), at most 2,048
  pixels on each side (`SELFIE_MAX_SIDE_PX`, read from the PNG's IHDR or the
  JPEG's frame header before any pixels are inflated; Default (agent), owner
  may override): the app (KYC-03) downscales and compresses its capture to
  fit both before sending it. The file is walked from its first byte to
  its last (`src/money/identity/selfie-image.ts`): a PNG chunk by chunk
  (each length inside the file and each CRC correct, IHDR first, PLTE when
  needed, one run of IDAT whose data inflates to exactly the rows IHDR
  describes, IEND last with nothing after); a JPEG marker by marker (SOI,
  segment lengths inside the file, a frame header before the first scan,
  well-formed scan headers; in a scan an `FF` is followed only by `00`,
  `D0` to `D7`, another scan's table segment, or the EOI that must be the
  last two bytes). A file framed with the right first and last bytes, an
  image with anything appended, or a cut one is a 400 before Fintava is
  asked (every match is charged, a broken one too). The app sends the
  capture as its encoder wrote it (no trailer after the end). The cap sits below the
  server's global JSON body limit (100 KB), so the route needs no parser
  change. `bvn` must be the one whose check passed, compared with the stored
  keyed hash (`WalletIdentityService.checkedBvn`); otherwise `409
  bvn_not_checked`.
- **What is stored.** One `SelfieMatchAttempt` row per match sent: the
  outcome (`matched`, `not_matched`, `unavailable`), when it was taken and
  answered, Fintava's confidence score when its answer carries one, and the
  passed BVN check it was compared against (`bvnVerifiedAt` and the keyed
  `bvnHash`, as in `WalletIdentity`), read once at the start of the request.
  Never the selfie, the BVN photo, the BVN or any part of it, or anything else
  Fintava answers with. The client passes on only the verdict; it logs no
  body, and masks base64-like runs in Fintava's messages.
- **Reading Fintava's answer, by allowlist** (`src/fintava/fintava-selfie-answer.ts`).
  The success body is unseen (no sandbox BVN passes, mobile repo
  `docs/fintava/sandbox/README.md` questions 6 and 11) and Fintava
  documents no verdict field (its 200 example is `{}`). So the answer is
  compared with exact shapes, not searched for a "no": HTTP 200 exactly,
  `content-type: application/json` (optionally `; charset=utf-8`), JSON with
  no key named twice at any level, and every key on the allowlist. A match
  is only Fintava's success envelope as its other checks answer it
  (`{ data, status: 200, message: "successful" }`, `message` optional)
  whose `data` holds exactly one key, one of the candidate verdict names
  (`match`, `matched`, `is_match`, `isMatch`, `face_match`, `faceMatch`,
  `selfie_match`, `selfieMatch`), set to `true`. The same with `false`, or
  Fintava's documented failure envelope (`{ status: 400, timestamp,
  message, path }`) in a 200, is an explicit "no": `422
  selfie_not_matched`, counted. Anything else (the documented `{}`, a
  score, a second verdict, an unknown key, a status word, an error field,
  anything deeper, a 201 or 202, another content type) has no verdict: `503
  provider_unreachable`, counted (it was charged), never a match. So until
  Fintava shows its real success body, no selfie passes; the verdict names
  are narrowed (and a score field added, if it has one) when it does. No
  score is read today, so `confidence` is null. The answer is read with a
  cap of 4,096 bytes (`SELFIE_ANSWER_MAX_BYTES`; every readable answer is
  under 200), of any status: a declared Content-Length over it, or more
  bytes than it arriving, drops the connection at once and is `503
  provider_unreachable`, counted, never a match, never buffered or parsed
  (a 400 or 401 over the cap included). Default (agent), owner may
  override. A failed match is the
  sandbox's `400 ["Request failed with status code 404"]`, charged ₦10
  there.
- **Result.** A match counts only for the BVN check it was compared
  against: `matchedAt` and `selfieMatched` need the row's `bvnVerifiedAt`
  and `bvnHash` to equal the person's current check. A later passed BVN
  check (the same BVN or another) needs a new selfie, and one that passes
  while a selfie is being matched does not inherit it (the match answers
  `409 bvn_not_checked`). Once matched, a further match is `409
  selfie_already_matched` and is not sent. Account opening (MONEY-12) reads
  the passed check once (`WalletIdentityService.checkedIdentity`, the BVN and
  the NIN compared in that read) and requires the matched row tied to that
  exact check (`SelfieMatchService.matchedFor`, its `bvnVerifiedAt` and
  `bvnHash`): two separate reads of "the current check" could race as
  KYC-02's defect 2 did (section 9).
- **Limits** (each match is charged, a failed one too). Per person: 3 in
  any 24 hours (`SELFIE_CHECKS_PER_DAY`, PROVISIONAL), counted in
  `SelfieMatchAttempt` with the BVN check's limiter (`reserveDailyAttempt`:
  row first, count after, so parallel requests cannot pass it). A failed
  match is `422 selfie_not_matched` with A16's words and `checksLeft`; the
  fourth is `429 selfie_checks_exhausted` with `retryAfterSeconds`, and
  Fintava is not asked. A match that never reached the provider (no key, a
  key refused) is given back; a timeout or a 5xx counts (it may have been
  charged). Per address: the BVN check's `short` 3 a minute and `medium` 20
  an hour, with its own count (`BVN_CHECK_THROTTLE`, `bvnCheckTracker`).
- **Without settings.** No `FINTAVA_*` or no `IDENTITY_HASH_KEY`: the server
  starts, the match answers `503 provider_unreachable` without calling out
  or counting, and the read still answers.

## 9. Opening the account at Fintava (MONEY-12)

- **Routes** (`src/money/opening/`): `POST /money/wallet/open` with
  `OpenNairaWalletDto` (`bvn`, `nin`, `firstName`, `lastName`, `dateOfBirth` as
  `YYYY-MM-DD`, `address` in one line) ends Open your wallet (A7) and answers
  `WalletView`; `GET /money/wallet` answers the same, never calls Fintava,
  and is `no-store` like the open. `state` is `not_open` (no wallet, or the
  last attempt failed), `opening` (being created, or a lost answer being
  confirmed: A7's wait) or `open` (with `account`: Fintava's account number
  and account name, the bank name from `WALLET_BANK_NAME`, default "Loma
  Bank", provisional, bank code `090620`, and the owner's licence and
  deposit-insurance lines, null until set). `limits` is null (G-7),
  `bankTransfers` is allowed for an open wallet (W18 is not built, R-28) and
  `beneficiaryCount` counts the rows `GET /money/beneficiaries` shows
  (WALLET-14, section 10; 0 without a wallet). While an
  opening is in flight the balance answers `409 wallet_opening`.
- **Identity, read once.** The BVN and NIN must be the ones the passed check
  was run with (`checkedIdentity`: keyed hashes, one read, the NIN required;
  `409 bvn_not_checked` otherwise) and the selfie must have matched against
  exactly that check (`matchedFor`; `409 selfie_required` otherwise). The
  opening records the check it was claimed under. The phone sent is the one
  the BVN check proved (`WalletIdentity.verifiedPhone`), the email the
  token's (`422 account_not_opened` when there is none). The name, date of
  birth and address are the app's (G-25's default: A5's prefill as shown);
  none of them, nor the BVN or NIN, is stored or logged.
- **One person, one account.** Fintava refuses neither a repeated create
  nor a repeated BVN (`sandbox/07-create-customer.md`), so:
  `FintavaWalletOpening` (one row per person) is claimed before anything is
  sent (a new row, or a `failed` one by a conditional update on its attempt
  number), and checked again just before the create; a request that finds
  it taken answers `opening` and sends nothing. Its BVN hash and phone are
  unique: a second WAWU account with the same BVN or phone gets `409
  identity_has_wallet` and nothing is sent. Before a create, Fintava is
  asked for a customer with the phone (`/customers/details`, then
  `/customers/{id}`). It is the person's account only when Fintava's record
  carries the checked BVN: the keyed hash (`IDENTITY_HASH_KEY`, KYC-01's
  `bvn:<digits>` scheme) of its `userInfo.bvn` equals the opening's
  `bvnHash`. Fintava's BVN and date of birth are never stored, logged or
  answered; the client hands the BVN only to the hash. One that carries it
  and nobody holds is recorded instead of making a second; one another WAWU
  account holds is `409 identity_has_wallet`. One whose BVN differs, or
  whose record has no readable BVN, is never adopted and nothing is
  created: the opening stops as `conflict` (`failure`
  `phone_held_by_other_identity` or `phone_holder_bvn_unreadable`), one
  error line is logged, and the person is answered `409
  phone_held_by_other_identity` now and on every later open, while `GET
  /money/wallet` reads `not_open` (G-37: an owner's review). An answer that
  cannot be read is `503 provider_unreachable` with nothing created.
- **A lost answer** (timeout, 5xx, a 2xx without the customer, or a refusal
  saying the customer exists) leaves the opening `unknown`, answered as
  `opening`. It is reconciled with Fintava on the next open request and by
  a sweep every 30 seconds (also for an `opening` row whose request never
  finished): a customer found for the phone, by `/customers/details` or in
  `/customers/list` back to a little before the attempt, is recorded as the
  person's account only if it carries the checked BVN (as above; a list row
  of any age, matched by phone, is read by id and compared the same way),
  and otherwise stops the opening for review. Its order is not assumed:
  the list is read to its end (up to 10 pages of 100), and a list read to
  its end without the phone counts as "no row" whatever its order; a longer
  list counts only when every row read was newest first and reached back
  past the attempt, and otherwise the opening waits. Every time stamped on
  an opening or compared with one is the database's `now()`, not the
  server's clock. It counts as not created only when
  the details lookup gives Fintava's own `404 ["Customer not found"]`
  (`sandbox/32-money12-account.md`) AND the list has no row for the phone
  AND the money timeout plus `FINTAVA_RESEND_SAFETY_MS` has passed since the
  create was sent; then the opening is `failed` and the person's next open
  request sends a new create. Anything else waits: `{}`, `data: null`, any
  other 404, a failed, unreadable or out-of-order list. A found account
  another WAWU account holds leaves the opening `conflict` (shown as
  `opening`), logged for review.
- **Refusals.** A validation refusal or an identity refusal (a blacklisted
  NIN) is `422 account_not_opened`; the merchant gate, a refused key or any
  other refusal is `503 provider_unreachable`. Both leave the opening
  `failed`, and the next request is a new attempt.
- **Without settings.** No `FINTAVA_*` or no `IDENTITY_HASH_KEY`: the open
  answers `503 provider_unreachable` and sends nothing; `GET /money/wallet`
  still answers; the sweep does nothing.

### 9a. Opening on a provider that reviews the person (Nuvion, NUV-02)

Under `WALLET_PROVIDER=nuvion` there is no BVN check and no selfie match
before the open: `POST /money/wallet/open` carries the details, the BVN and
the NIN together, and Nuvion's own review checks them. Under Fintava none of
this applies and every answer is as in section 9.

- **The two additive fields of `GET /money/wallet` and `POST /money/wallet/open`.**
  `openingFlow` is `review` (an absent `openingFlow` means `check`, section
  9) and is sent only under such a provider. `review` (`WalletReviewView`) is
  `null` until something was sent, then `{ stage, reasons[], canResubmit,
  canResubmitAt, decidedAt }`. `stage` is `needs_documents` (the details are
  in; the ID document and proof of address are still needed, NUV-03; also
  right after corrected details), `checking` (sent for review), `approved`
  (the account number is on its way, NUV-04), `rejected` (`reasons[]` say
  why and what to fix, each `{ code, message, fix }` in our own words, never
  Nuvion's text; `canResubmit` is true), `stopped` (failed, suspended, or the
  BVN reviewed is now another account's; `reasons` is `review_stopped`, money
  routes answer `409 wallet_not_open`, support can help) or `expired` (the
  opening sat unfinished for too long, or support closed it; `reasons` is
  `review_expired`, `canResubmit` is true: send the details again to start a
  new one; `decidedAt` is when). `state` keeps its meaning: `not_open` while
  documents are needed, after a refusal, when stopped and when expired;
  `opening` while checked and once approved. `decidedAt` is when the
  decision was recorded (null before one). **`canResubmit` is never true
  while the server would answer 429** (round 3): when the person's day, or
  the address the request comes from, has no try left, `canResubmit` is
  false and `canResubmitAt` says when a try opens (otherwise `null`).
  `accountNumberStatus` (NUV-04) is `on_its_way` once Nuvion has approved
  the person; a person only being checked, refused, stopped (also for a BVN
  another account took) or expired reads `none`.
- **The body.** `bvn` and `nin` (11 digits each; a `checkHandle` is a plain
  `400`), the section 9 fields, and what Nuvion needs: `gender` (`male` or
  `female`), `city`, `state`, `postalCode`, `idType` (`international_passport`,
  `drivers_license` or `national_id`), `idNumber` and `proofOfAddressType`
  (`utility_bill` or `bank_statement`), each required; optional `middleName`,
  `addressLine2`, `idIssueDate`, `idExpiryDate`. `address` is then the street
  line. Nationality and the issuing country are not fields: they are `NG`.
  A required field that is left out **or sent as `null`** is the same plain
  `400` naming the first one missing, in that order; a `null` in an optional
  field is the same as leaving it out. **The words `null` and `undefined`
  (any case, trimmed)** in a required text field (`firstName`, `lastName`,
  `address`, `city`, `state`, `postalCode`, `idNumber`) are refused like an
  empty value, with the same sentence; in `middleName` and `addressLine2`
  they mean nothing was typed. Nothing in the body is stored or logged; the
  ID number is never stored.
- **Who holds a BVN.** A BVN is held by one account for as long as Nuvion's
  entity for that account still carries it in a live state. It is held while
  the opening is with Nuvion (being made, documents needed, being checked),
  once Nuvion approved it, after a refusal about anything but the BVN itself
  (the documents, the details or the NIN: the entity keeps the BVN and the
  person corrects what was named), and always once an account is recorded or
  was requested, whatever Nuvion says later: a failed or suspended entity
  **with** an account keeps its hold, and support decides. It is let go at
  once by a refusal of the BVN itself (the review's word for the BVN is a
  not-passed word: `rejected`, `failed`, `declined`, `not-approved`,
  `invalid` or `unverified`, in any case), by a failed or suspended entity
  that has no account, and by a create Nuvion refused. A BVN Nuvion has
  approved for the person stays held while the opening is alive, whatever
  else the refusal names (round 4, N11): any other word for the BVN
  (approved, pending, a word we do not know) is held, the safe side. A
  correction after a refusal moves the claim only in the step that sends the
  new number to Nuvion (the review named the BVN or the NIN: both go again
  and the claim moves to the BVN typed; it named something else: no number
  goes, the number typed is not used, and the claim keeps the BVN Nuvion
  already has). A lost answer sent again keeps its claim until a
  create really goes out. Another account asking for a held BVN or phone gets
  `409 identity_has_wallet`, "We can't use this BVN or phone number for a new
  wallet. If it's yours, contact support.", the same words whether the holder
  has a wallet or a check in progress (no existence oracle). The code is
  stable. Nuvion approving an entity whose BVN another account holds by then
  opens no account: the opening is stopped for review.
- **A hold runs out.** An opening that sits at `needs_documents`, or was
  refused with its BVN still held (anything but the BVN itself refused: the
  documents, the details or the NIN), with no progress from the person
  for `IDENTITY_HOLD_DAYS` (default 14, PROVISIONAL, 1 to 365) is marked
  `expired` by a sweep that runs every minute where the schedule runs (one
  pass at a time across servers, each opening by a conditional update): its
  BVN is let go, the person is told once (`identity_review`, "Identity check
  closed"), and nothing is sent to or deleted at Nuvion. Progress is the
  opening's last claim (the first send, a correction, a start again), the
  last submission, `NuvionEntity.progressAt` (NUV-03 sets it for each
  document uploaded and for the submit call, `recordOpeningProgress`), and,
  for a refusal, the day the person was told. An opening being checked,
  approved, stopped, with an account or a wallet, or refused on the BVN
  itself (which holds nothing) never expires. The sweep reads every
  candidate by a keyset cursor (attempt start, then account), with no cap on
  the rows it looks at, and when its time is used it hands the place it
  reached to the next pass (round 4, N15), so openings that are not yet due
  never keep it from the ones behind them. **A hold also has a lifetime**
  (NUV-03 round 4, R4-2): one account holds one BVN for at most
  `IDENTITY_HOLD_LIFETIME_DAYS` (default 30, PROVISIONAL, 1 to 365, never
  shorter than `IDENTITY_HOLD_DAYS`), counted from the day it took the claim
  on that number (`FintavaWalletOpening.bvnVerifiedAt`, which under Nuvion is
  when the account took, or moved to, the BVN it holds) and moved by nothing
  the person does while the same number stays held. A file of four bytes
  every 13 days is progress for the idle rule and does nothing for the
  lifetime. When it ends the sweep marks the opening `expired` exactly as it
  does an idle one (the same release, the same single notice; the stored
  cause is `hold_lifetime_ended`). A number let go and taken again, a start
  again after an expiry and a correction that moves the claim to another
  number each take a new claim and so start a new lifetime; a correction that
  keeps the same number does not. To start again the person sends the
  details to `POST /money/wallet/open` as for a correction: the same entity
  at Nuvion is corrected, BVN and NIN included, the claim is taken on the BVN
  typed (the plain `409` if another account holds it by then), and the review
  reads `needs_documents`. If Nuvion nevertheless starts checking or approves
  the entity of an opening that expired, the opening is live again: its BVN
  is held again (or, if another account took the number meanwhile, the
  opening is stopped and nothing is opened) and, once approved, the one
  account is opened as for any approval. A refusal about documents leaves it
  expired.
- **Support lets go of a hold at once.** `POST /admin/identity-holds/{wawuUserId}/release`
  (roles `superadmin` and `support`; `reviewer` and `finance` are refused):
  the holder's opening is marked expired exactly as an idle one is, and the
  person is told once. The route names the holder's account and takes no BVN
  and returns none (`{ wawuUserId, outcome: released | already_released,
  state }`); it is audited (`AdminOpsAudit`: admin, account, the state
  before) and logged by account and admin id only. `404` for an account with
  no opening; `409` while Nuvion is still reviewing the person (`open`,
  `opening`, `unknown`), for an opening held for a hand look (`conflict`) and
  for an account with a wallet. It releases an opening at documents needed,
  refused or stopped; a repeat, or an opening that holds nothing, changes
  nothing. Safe to repeat.
- **Tries.** At most 3 opening tries a day per account (`BVN_CHECKS_PER_DAY`,
  PROVISIONAL, 24 hours rolling, the ledger `BvnCheckAttempt` with outcome
  `opening`, written by KYC-01's `reserveDailyAttempt`): a request that takes
  the claim (a first try, a try after a refusal or a lost answer, a
  correction) or tries to and finds the BVN held by another account. The
  fourth is `429 identity_checks_exhausted` with `retryAfterSeconds`, before
  anything is claimed or sent; a burst of probes at once learns the held
  answer at most three times. Taps on an opening already in flight, being
  checked or stopped, and requests refused before the claim (a malformed
  body, no email), count for nothing. **From one address**, at most
  `OPEN_ATTEMPTS_PER_ADDRESS_PER_HOUR` (default 10, PROVISIONAL) such tries in
  a rolling hour across every account: the next is `429 open_address_limited`
  with `retryAfterSeconds`, before anything is claimed. The limit holds under
  any burst (round 4, N12): the address's place is taken in one atomic step
  before the claim (a lock on the address in the database, inside one
  transaction that counts the hour's tries and writes the place only when one
  is free; `BvnCheckAttempt.outcome` `reserved`, which the person's day does
  not count), the place becomes the try when the claim is taken and is given
  back when it is not, so 25 accounts opening at once from one address on one
  server or on several sharing the database let exactly the limit in and
  answer the rest `open_address_limited`. A second request of an account
  whose first still holds a place on that address (a double tap) takes none.
  A place left by a server that died stays counted against the address until
  its hour is out. The address is the
  caller's as the proxy gives it (`X-Forwarded-For`, as the BVN check's
  limit reads it); an IPv6 address stands for its /64, so rotating through
  the addresses of one connection is still one place. It is stored only as a
  keyed hash on the try (`BvnCheckAttempt.addressKey`); a call with no client
  address is not counted by address.
- **A decision.** Nuvion's entity is read back before anything is recorded
  (`GET /entities/{id}`). A decision is new when it is the first, or the word
  changed (the entity went through `pending`, or from one decision to
  another). The same word again is new only after the person submitted
  since the last decision (corrected details, or NUV-03's submit call:
  `NuvionEntity.submittedAt`) **and** a check Nuvion reports came to a
  failing verdict that differs from the one recorded (a not-passed word:
  `rejected`, `failed`, `declined`, `not-approved`, `invalid`, `unverified`;
  not back to `pending`, which a new document does, and not an approving
  word, which is the review progressing and leaves the stage, the decision
  time and the notices as they were: round 4, N13). With no submission since the last decision it is the
  same decision whatever Nuvion bumped; with every word as it was recorded
  it is the echo of the submission itself (Nuvion's `entities.updated` fires
  for our own PATCH). Nuvion's own `updated` time is not read: it moves for
  things that are not decisions. A new decision sets `decidedAt`. A person
  whose details were corrected after the last rejection reads
  `needs_documents` until a decision newer than the correction is read. A new
  `approved`, `rejected` or stopped (`failed`, `suspended`) decision writes
  one `identity_review` notification (title and body of our own words; a
  rejection carries what to fix; never a BVN, NIN or ID number), by the one
  delivery that recorded it. A person stopped by Nuvion and then again
  because their BVN was taken is told one "Identity check stopped".
- **`POST /money/identity/bvn`** answers `409 step_not_used` under such a
  provider (its `capabilities.identityLookup` is false) once the body passes
  validation; a malformed body gets the validation pipe's `400` first.
- **Nuvion's words are masked** before they are stored or logged: any run of
  7 or more digits is cut to its last 4 after every separator is removed
  from between the digits, however many there are (any width of space, tab,
  newline, punctuation, slash, underscore, bracket, dash, zero-width
  character, or the letter x or X, in any number: a run of 40 or more
  slashes or pluses between groups of full-width digits is masked like a
  run of one) and every Unicode decimal digit is read as 0 to 9 (full-width
  and Arabic-Indic digits too), before anything else is masked (round 4,
  N14). A letter or digit glued to the number is cut with it where the stored
  words are masked. **A letter between groups is not a separator**: "1234
  and 5678 and 9012" is three short numbers and a sentence, and is kept as
  written.

## 10. Saved beneficiaries and the payout account (WALLET-14)

- **Routes** (`src/money/saved-accounts/`): `GET /money/beneficiaries`
  (newest first, at most `BENEFICIARIES_MAX`), `POST /money/beneficiaries`
  (`CreateBeneficiaryDto`: `kind` with `wawuUserId`, or with `bankCode` and
  `accountNumber`; the other kind's fields are a plain 400), `DELETE
  /money/beneficiaries/{id}`, `GET /money/payout-account` (`null` when none)
  and `PUT /money/payout-account` (`PayoutAccountDto`). All need an open
  wallet: they run MONEY-13's gate (`@RequireOpenWallet()`, before the body
  is read), so they answer `409 wallet_not_open` and `409 wallet_opening`
  exactly as every wallet route does, and act on the wallet it found
  (`@CurrentWallet()`). `wallet_frozen` is declared, not answered (the
  gate's own rule). Every answer is `no-store`.
- **A bank account is the bank's word, never the app's.** Before a bank
  account is saved (as a beneficiary or the payout account), its bank code
  must be in Fintava's bank list (`GET /banks`, kept in memory for an hour,
  fetched once however many saves arrive while it is being fetched)
  and Fintava's name check (`GET /name/enquiry`, free) must confirm it:
  `data.status` true, `responseCode` `"00"`, a non-empty name and the same
  account number. The name saved is the one the bank returned. A body that
  carries a name is refused by validation. A name check that does not
  confirm the account, or a bank code not in the list, is `422
  name_check_failed` and nothing is saved; Fintava not answering (or the
  key refused) is `503 provider_unreachable` with `retryAfterSeconds`.
- **Under Nuvion the same two checks (NUV-06), with a sentence of their
  own for each way the account is not confirmed.** The bank list is
  Nuvion's (`GET /bank-codes/NG`) and the name check is its
  `POST /counterparty-lookups`. All four are `422 name_check_failed`, so
  the app's switch on `reason.code` is the same; the message says what to
  fix: no account with that number at that bank, a bank the check cannot
  ask (including a code not in the list; nothing is asked), a number that
  is not ten digits (nothing is asked), or more than one account found. A
  check that got no answer in time (Nuvion's own timeout, its lookup
  service down, or ours running out) is `503 provider_unreachable`, not a
  wrong account. Fintava's yes-or-no answer keeps its one sentence.
  `bank_not_supported` and the others are sentences, not new codes: the
  contract's `MoneyErrorReason` is unchanged.
- **A saved account carries what Nuvion needs to send to it (NUV-06).**
  `MoneyBeneficiary` and `MoneyPayoutAccount` hold `nuvionBankCode` (the
  bank's code in Nuvion's list) and `nuvionCheckedAt` (when the holder's name
  was last confirmed through Nuvion; null on a row from the Fintava days,
  which is matched to Nuvion's list by code, else by bank name, and
  checked by name again before its first Nuvion send:
  `SavedAccountTargetService`), and the ids of Nuvion's counterparty and
  payment detail once a send has made them (`nuvionCounterpartyId`,
  `nuvionPaymentDetailId`; a payout account also holds WAWU's operational
  account's own pair). None is in any response. Saving a different account
  as the payout account clears the ids.
- **The BVN name.** The BVN check (KYC-01) keeps, with every passed check,
  the keyed hash of each word of the BVN record's first and last name,
  bound to the person and the check: HMAC-SHA256 under `IDENTITY_HASH_KEY`
  over `name:<wawuUserId>:<bvnVerifiedAt>:<WORD>`
  (`WalletIdentity.bvnNameKeys`, `{ v: 2, check, first: [...], last: [...]
  }`; `check` is the same HMAC over `name:check:<wawuUserId>:<bvnVerifiedAt>`).
  Only one person's keys are ever compared, with that person's own payout
  account, so the same word hashes differently for every person and every
  check: a reader of the database without the key cannot match a hash to a
  name stored in plain text elsewhere (a payout account, a beneficiary, a
  wallet's account name). A record without a readable first or last name
  keeps null. A word is the name in capitals A to Z, accents taken off,
  split on anything else.
- **`matchesBvnName`** is worked out on every read of the payout account:
  true when every word of the BVN's first name and of its last name is a
  word of the bank's account name, in any order (the middle name is not
  needed; an initial in place of a name does not match). Default (agent),
  owner may override. `false` means the bank's name is not the
  BVN name: since WALLET-37 (R-51, G-765) such an account is refused on save
  (`409 account_not_in_your_name`, the bank's name beside the name on the
  wallet, nothing stored) and a withdrawal to a saved one that reads `false`
  is refused before the PIN with the same code; only a row saved before the
  rule can read `false`. With `null` there is no BVN name, and the
  verified name is the wallet's own account name as the provider gave it (a
  wallet opened under Nuvion keeps no BVN name; the provider verified the
  identity when it opened it): the account is saved when every word of the
  shorter of the two names (the wallet's, the bank's) is a word of the longer,
  in any order, and at least two words match (either side may leave a middle
  name out; a different word, or one word alone, does not match), and refused
  with the same code otherwise (round 4); with no wallet account name either it is refused
  with a plain reason (WALLET-37 round 2). The flag itself stays `null`.
  `null` when there is no BVN name to compare with: no passed check, no name kept, `IDENTITY_HASH_KEY` unset, the
  wallet opened under a different BVN check (`FintavaWalletOpening.bvnHash`)
  than the one that kept the name, or keys that cannot be compared (the
  first scheme's unbound `{ first, last }`, or a `check` that does not
  recompute because the key changed): never `false` for those.
- **Beneficiaries.** A WAWU user is saved only with an open wallet (`409
  recipient_has_no_wallet`; no such person `404 recipient_not_found`;
  yourself `400 self_transfer`), and shows their name from WAWU ID and
  handle, avatar and tick from the profile, read on every list. Saving a
  place already saved answers the row already there (unique per person and
  place, also under parallel saves). At most `BENEFICIARIES_MAX` (50,
  PROVISIONAL) per person, counting the rows the list shows (a saved
  person whose account is gone holds no place), under a per-person lock,
  so parallel saves cannot pass it: `409 beneficiary_limit_reached`. Removing is by id
  among the caller's own rows: someone else's id, or one already gone,
  removes nothing and answers the same 200. A saved WAWU user whose wallet
  is gone (a deleted account) leaves the list, and `WalletView.beneficiaryCount`
  (W35) counts exactly the rows the list shows.

## 11. The fee quote (WALLET-15)

- **Route** (`src/money/fees/`): `GET /money/fees/quote?kind=&amountKobo=`
  (and `&billCategory=` on a bill), behind the wallet gate, `no-store`.
  Answers `FeeQuoteView`. It never calls Fintava and reads no balance: a
  quote is the fee schedule applied to the amount. `amountKobo` is digits
  only (`100.00`, `1e4`, `10,000` are a 400, never read as another amount).
- **What each kind costs** (R-10, R-31; rates in the mobile repo's
  `docs/fintava/fees.md`, final), each charge one entry in `parts`
  (`code`, `source` `provider` or `wawu`, `amountKobo`), in this order:
  - `wawu_transfer`: `balance_transfer` (Fintava, by band on the amount),
    `wawu_fee` (₦10).
  - `bank_transfer` (a send or a withdrawal): `bank_transfer` (Fintava,
    ₦40), `wawu_fee` (₦25).
  - `purchase` (unlock, tip, tick, ticket, paid DM, credits, course, legal
    service): `balance_transfer` only; no WAWU fee, WAWU's share is the
    85/15 split. The pay sheet itself is `GET /money/payments/quote`
    (MONEY-17), which fills its `fee` from the same service.
  - `bill` (`billCategory` electricity, cable, airtime or data, required):
    `bill_charge` (Fintava, ₦100 electricity or cable, ₦0 airtime or data),
    `wawu_fee` (WAWU's bill fee, ₦0), `balance_transfer` (Fintava's charge
    on the payer's move into WAWU's merchant wallet, R-31). The payer moves
    the bill's amount, its charge and WAWU's bill fee into WAWU's wallet in
    one transfer, so that sum is what the band is read on. Default (agent),
    owner may override.
- **Bands** of the balance-transfer charge: below ₦5,000 ₦23.25, from
  ₦5,000 ₦15.75 (₦4,999 pays ₦23.25, ₦5,000 pays ₦15.75).
- **Config**: every figure is a setting with the ruled figure as its
  default (`.env.example`, `src/money/fees/fee-config.ts`): a fee changed
  by Fintava or the owner is changed there and in the dashboard's merchant
  charges (OPS-09) together; MONEY-16 reports a difference. A setting that
  is not a whole number of kobo stops the app at boot.
- **Merchant cap**: a `purchase` or `bill` whose `totalKobo` is above
  `MERCHANT_MAX_PER_TXN_KOBO` is `400 amount_out_of_range` with
  `maximumKobo`, the largest `amountKobo` that fits. A send is not bound by
  it; a total a JSON number cannot carry exactly is refused the same way.
- **Daily limit**: WAWU's limits are settings (NUV-07, below). Where the
  module that mounts the route imports `MoneyLimitsModule`, the quote shows
  today's standing for its kind (`withinDailyLimit`, `remainingTodayKobo`);
  with no daily limit set for the kind, or without the module, it is `true`
  and `null` as before.
- **The provider's part, per provider (NUV-07, R-42)**: every `provider`
  part comes from the running provider's schedule
  (`src/money/fees/provider-fee-schedule.ts`); WAWU's parts and the order of
  parts are the same under either provider, so R-23's one Fees row is
  `fee.totalFeeKobo` either way.
  - `fintava`: the WALLET-15 schedule above, unchanged (a rollback quotes
    exactly what it quoted before).
  - `nuvion`: `balance_transfer` is `NUVION_FEE_BOOK_TRANSFER` (a send to a
    WAWU user, a purchase into WAWU's operational account), `bank_transfer`
    is `NUVION_FEE_BANK_PAYOUT`; `NUVION_FEE_INFLOW` (money arriving by
    transfer) is held for the add-money tasks. Each is one kobo figure or
    `from:fee` bands, with **no default and no figure in code**. Nuvion has
    no bill payments (R-39), so a `bill` is `409 target_not_payable`; its
    operational account has no documented cap, so `MERCHANT_MAX_PER_TXN_KOBO`
    (Fintava's merchant wallet policy) does not apply and WAWU's
    per-transaction limit does that job.
  - **Fees not set**: while any of the running provider's fee settings is
    empty (only Nuvion's can be), every quote is `503 fees_not_set`, before
    the wallet gate and before the query is read (`@RequireFeesSet()`, whose
    guard runs first), and `FeeQuoteService.lines()`, `quote()` and `check()`
    refuse the same way, so a payment that charges a quote cannot reach the
    provider either. Default (agent), owner may override: a quote never asks
    Nuvion (`POST /fee-simulations`); NUV-08 compares the setting with
    Nuvion's own figure and reports a difference.
- **Limits (NUV-07, `src/money/limits/`)**: per person, per kind of movement
  (the quote's four kinds) and per limit (`per_transaction`, the Lagos
  calendar `daily` and `monthly`), each the setting
  `WAWU_LIMIT_<KIND>_<LIMIT>_KOBO` (whole kobo; empty is no WAWU limit; no
  default, no figure in code), under either provider. What counts toward a
  day or a month is the person's own pending and completed movements of the
  kind out of their wallet, by amount before fees, from the ledger (never a
  balance). A route is money-moving when it carries a debit gate, whatever
  else it documents: the PIN guard (on the controller or the method;
  `@RequireTransactionPin()` and `@RequireApproval()` bring it) or a refusal
  only a debit or a PIN check answers (an Idempotency-Key code, a PIN code,
  `insufficient_funds`, `quote_changed`, `limit_reached`). The routes that
  check a PIN and move no money (changing the PIN, checking a PIN or an
  approval, turning on approving from a phone) are named in the coverage
  spec, each with its reason (FIX-21). Every money-moving route:
  - carries `@RequireFeesSet()` as its last decorator, and puts nothing but
    `WawuAuthGuard` on its controller (class guards run before method
    guards), so `fees_not_set` is answered before the wallet gate, the
    Idempotency-Key record and the PIN
    (`src/money/limits/tests/money-moving-coverage.spec.ts` holds every
    mounted route to it, reading class and method guards together as Nest
    runs them, and every declared one documents `fees_not_set` and
    `limit_reached` through `DEBIT_GATE_ERRORS`);
  - calls `MoneyLimits.assertMayMove({ wawuUserId, kind, amountKobo }, { tx
    })` in the transaction that writes the movement's pending ledger row,
    before the provider is called: `fees_not_set`, then `403 limit_reached`
    with `limit` (per transaction, then today, then this month). `tx` is
    required: the check takes a per-person lock for that transaction, so two
    movements by one person are checked one after the other. It is the `tx`
    of `prisma.$transaction(async (tx) => ...)`, never the service's own
    client: the types refuse the root client, and a check given nothing, the
    service's own client or any root client throws a `NotInTransactionError`
    before anything is locked, read or written (FIX-26,
    `src/money/limits/movement-tx.ts`). That transaction stays at READ
    COMMITTED (Prisma's default: no `isolationLevel`): the lock orders the
    reads only there, so the check first reads `transaction_isolation` and
    refuses any other level with an `IsolationLevelError` naming it (FIX-21,
    `src/money/limits/read-committed.ts`). Both are programming errors,
    answered as a 500;
  - answers a provider failure with `error.toHttpException()`: the
    provider's own limit refusal (a `WalletProviderLimitError`; Nuvion's
    `error_transfer_transaction_limit_exceeded`,
    `error_transfer_daily_limit_exceeded`,
    `error_transfer_monthly_volume_exceeded`) is then the same
    `limit_reached`, with nothing moved.
- **Short-lived and checkable**: `quoteToken` is the quote signed by the
  server (HMAC-SHA256 under `FEE_QUOTE_KEY`: the person, kind, category,
  amount, total and `expiresAt`, `FEE_QUOTE_SECONDS` after it was given,
  300 by default, PROVISIONAL). Nothing is stored or reserved.
  `FeeQuoteService.check(wawuUserId, input, expectedTotalKobo, quoteToken)`
  is what a paying request calls (WALLET-07, WALLET-09, MONEY-17; their
  request bodies add `quoteToken` beside `expectedTotalKobo`, mobile repo
  BACKEND_GAPS G-64): it answers the quote as it stands now when the token
  is this server's, for this person and this input, not expired, and both
  its total and `expectedTotalKobo` equal today's total; otherwise `409
  quote_changed` with the new quote in `reason.feeQuote`. A caller may
  bind a quote to one thing with a subject (`quote(..., subject)`, `check(...,
  subject)`; MONEY-17 binds payments to their item). An unset
  `FEE_QUOTE_KEY` makes a key at boot (one warning): quotes given before a
  restart are then re-quoted, never charged wrongly.

## 12. Statements (WALLET-27)

- **Route** (`src/money/statements/`): `GET /money/statements?from=&to=&format=csv`
  answers `StatementView` in the usual envelope, with the file as text in
  `content` and the name and type to save it under (`fileName`,
  `contentType`). It runs MONEY-13's gate (`@RequireOpenWallet()`): no
  wallet is `409 wallet_not_open` or `409 wallet_opening` before the query
  is read. It takes no wallet id and no person: the statement is always the
  caller's own, and a query that names anyone (`wawuUserId=`,
  `accountNumber=`) is refused by validation. `no-store`. It reads the
  ledger only and never calls Fintava.
- **The period is two calendar days in Africa/Lagos time, both included.**
  `from=2026-09-01&to=2026-09-30` is 00:00 on 1 September to 23:59:59.999
  on 30 September, Lagos time (UTC+1): a movement at 23:30 UTC on 31 August
  is in it (1 September in Lagos) and one at 23:30 UTC on 30 September is
  not (1 October in Lagos). `from` equal to `to` is that one whole day. Each
  line's date and time are Lagos time too.
- **Refused with a plain 400:** a day not written `YYYY-MM-DD`, a day not on
  the calendar (`2026-02-30`, year `0000`), `from` after `to`, `to` after
  today in Lagos, a period longer than `STATEMENT_MAX_DAYS` (366, both days
  counted; PROVISIONAL), and any `format` but `csv`.
- **Rows are capped** (lead's ruling after the round-1 load run; Default
  (agent/lead), owner may override). The day cap bounds days, not rows, so
  the rows in the period are counted first (no further than one past the
  cap) and a period with more than `STATEMENT_MAX_ROWS` (50,000) is `400
  statement_too_large`, "pick a shorter range", before any row is read
  into a file. The read itself stops one past the cap and is checked again,
  so rows landing between the count and the read cannot pass it.
- **Limits** (`src/money/statements/statement-config.ts`; rounds 3 and 4).
  The route sets no throttler of its own: the app's global `short` and
  `medium` limits apply per address exactly as on every route. On top:
  - **Per person** (`StatementRateLimiter`, PROVISIONAL
    `STATEMENT-RATE-LIMITS`): at most 5 statements a minute and 30 an hour,
    each a fixed window that starts at the person's first request in it,
    keyed by the verified wawuUserId. It is counted in the handler, after
    WawuAuthGuard has verified the token and the wallet gate has found the
    wallet, so a forged token, no token or no wallet never makes an entry.
    Beyond either window is `429 statement_rate_limited` with
    `retryAfterSeconds` (rounded up). The counts live in memory in one map,
    swept at most once a minute of everyone whose windows have both ended;
    no timer is kept per request.
  - **What counts:** every request that reaches the build: a statement
    served, and a `503 statement_busy`. **What does not:** the route's own
    400s. The DTO's (a day not written `YYYY-MM-DD`, any `format` but `csv`,
    an extra field) and the period's (a day not on the calendar, `from`
    after `to`, `to` after today in Lagos, more than 366 days) are refused
    before the person is counted, and `statement_too_large` gives its place
    back. Nor do the gate's 409s and the token's 401.
  - **Two at once** (`StatementSlots`, PROVISIONAL `STATEMENT-CONCURRENCY`):
    at most 2 statements are built at once in the process (count, read and
    file). Another waits in order, up to 5 s, for a place, then is `503
    statement_busy`, "Statements are busy right now. Try again in a few
    seconds.", with `retryAfterSeconds` (rounded up).
- **What is listed:** every `completed` movement on the caller's own wallet
  (the history's three keys: a person's wallet, the token's wawuUserId,
  the wallet's account number) whose `occurredAt` is in the period, oldest
  first, one line each (unlock earnings are never grouped). Pending, failed
  and reversed movements are not listed: they are the rows the month
  summary (section 6) leaves out, so a month's statement adds up to W26's
  In and Out for that month. Default (agent), owner may override.
- **No balance and no totals.** The only balance is Fintava's live one, and
  Fintava gives none at a past moment, so a statement has no opening or
  closing balance. It does not add its lines up either.
- **The file** (RFC 4180): a byte-order mark, then the header `Date, Time,
  Description, Counterparty, Reference, Note, Money in (₦), Money out (₦),
  Of which fees (₦)`, one line per movement, lines ending CRLF. Money in is
  what arrived; money out is what left, fees included, with the fee part
  beside it (the receipt's `fee.totalFeeKobo`). Amounts are naira with two
  decimals written from integer kobo (`25065.00`). The description, the
  other side's name and the reference are the history's own (section 6,
  `history-labels.ts`), so every line can be found on W26 and W27. A text
  cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return is
  written with a `'` first, so a spreadsheet never runs it (an `@handle`
  shows as `'@handle`). Only the last four digits of a bank account ever
  reach the history; the statement shows none.
- **Not served:** a stamped PDF (Fintava issues no statement; mobile repo
  BACKEND_GAPS G-68).
- **By email** (WALLET-35, W38 "Send to"; `src/money/statements/statement-email*.ts`).
  - `POST /money/statements/email` takes the same `from`, `to` and `format` as
    the download, in the body, and nothing else: an `email`, a `to` or any
    other field is a 400. It builds the file exactly as `GET /money/statements`
    does (same period rules, same rows, same limits, shared with it: an
    emailed statement is one statement, `429 statement_rate_limited`), then
    hands it to WAWU ID's mail relay (`POST /internal/mail/send`, EMAIL-02,
    now with `attachments`) as one attachment named `fileName`.
  - **The address is the person's own, from their token, and confirmed.** It is
    the token's `email` and only when its `emailVerified` is `true` (WAWU ID
    holds mail back from an unconfirmed mobile sign-up for the same reason).
    A statement lists every movement and counterparty name, so it never goes to
    an address the person types. No confirmed address is `409
    email_not_verified`. The Hub holds no address of its own.
  - Order of answers: the route's own 400s (the period, the body), then the
    409, then the person is counted, then the file is built, then the mail is
    handed over. `400 statement_too_large` gives the place back (a file over
    12 MiB is measured before the mail is built, and is that 400, not a 503);
    a mail that could not be handed over is `503 statement_email_failed` and
    counts. WAWU ID answers `200 { id, attachments }` for a mail that carried
    files, `attachments` being how many it took; the Hub calls the mail sent
    only when that number is the one it sent (a relay from before WALLET-35
    drops the file and answers `{ id }`, which is a failure here). A mail with
    no files (a campaign, the money check's report) is judged as before.
  - `200` answers `StatementEmailView`: `sentTo` (the address masked,
    `a***@example.com`), `from`, `to`, `format`, `fileName`, `rowCount`,
    `sentAt`. `no-store`. An optional `Idempotency-Key` (8 to 128 of
    `A-Za-z0-9_-`) for the same person makes WAWU ID's sender answer a repeat
    with the first mail; the key sent on is a hash of the person's id and the
    key, and a request without one is its own mail.
  - `GET /money/statements/delivery` answers `StatementDeliveryView` from the
    token alone: `email` (masked, or null), `canEmail`, and `formats` (what
    `format` accepts today: `csv`). W38 reads it for its "Send to" row and its
    format choice, so a format Fintava adds later reaches the screen from here.

---

## 13. Finding a recipient (WALLET-08)

`src/money/recipients/`. `GET /money/recipients?q=` and `GET
/money/recipients/recent` answer `RecipientView[]` (plain arrays, at most 20
and 10, no paging: section 6 keeps recipients a short list, and a search is
narrowed by typing more). Both run MONEY-13's gate (`@RequireOpenWallet()`),
send `Cache-Control: no-store`, read our database only and never call Fintava.

- **Who can be found, on both routes.** Only a person with an OPEN wallet (a
  `FintavaWallet` row; R-6). Never the caller. Never a person blocked either
  way: the one list `BlockedAccountService.hiddenFrom` (SETTINGS-04), read
  once per request. A blocked person, a person with no wallet and a person
  who does not exist all answer the same way: nothing.
- **What a result is.** `wawuUserId`, `displayName`, `handle`, `avatarUrl`,
  `tick`, and nothing else. Never a phone number (not even masked), an
  account number, an email, a BVN or a NIN: the queries select none of them.
  A person found by phone is shown exactly like one found by name. The name
  is WAWU ID's, else the name on their wallet, else the handle; one with
  none of the three is left out.
- **A phone is matched in full, as a phone, and as nothing else.** The text
  is a phone when it is a whole Nigerian mobile after normalising
  (`08031234567`, `8031234567`, `2348031234567`, `+2348031234567`, spaces,
  dashes and brackets ignored; section 2). It is compared with the phone the
  person's wallet was opened with (`FintavaWalletOpening.phone`, and
  `WalletIdentity.verifiedPhone`, E.164). Digits that are not a whole mobile
  are read as text: they can match the beginning of a name or handle, never
  part of a phone. A handle written like a number never stands in for that
  number. The Hub holds no other phone: a person who changed the phone on
  their WAWU account since opening the wallet is found by the one they opened
  it with.
- **A name or @handle is matched by its beginning**, case ignored: the
  beginning of the handle, or of the name on the wallet or any word of it
  (`okoro` finds `ADAEZE OKORO`). `@text` searches handles only. `%`, `_` and
  `\` are the characters they are, never wildcards. At least 2 characters
  after trimming (and after a leading `@`), at most 60; anything else, a
  missing `q`, a repeated `q` or another query field is a plain 400 in the
  one error shape (no `reason`: it is a malformed field, section 3). Names
  live in WAWU ID, which has no search, so a name search reads the name on
  the wallet and the handle (BACKEND_GAPS G-132).
- **Order and size.** Search: name order, then id, the first 20. Recent:
  the caller's own completed outgoing ledger rows (`direction out`, `status
  completed`, `counterpartyKind wawu_user`, category `transfer` or
  `purchase`), one person once at the time of their latest send, newest
  first, the first 10 after blocked people and people with no open wallet are
  taken out. A pending, failed or reversed send is not a person sent to.
- **Limits** (PROVISIONAL `RECIPIENT-SEARCH-RATE`,
  `src/money/recipients/recipient-config.ts`; lead's figures after the
  round-1 verifier walked 6,000 holders at about 3 requests a person). Two
  kinds, both kept:
  - **Per address**, on the app's named throttlers, tighter than the global
    ones (which stay): at most 20 a minute and 120 an hour from one address.
    A refusal is the guard's own `429` with no `reason`, before the token is
    read. The recent list sets none of its own.
  - **Per person** (`RecipientSearchLimiter`, the shared
    `PersonWindowLimiter` that statements use too): at most 20 a minute, 120
    an hour and 500 a day, each a fixed window that starts at the person's
    first search in it, keyed by the verified wawuUserId. It is counted in
    the handler, after `WawuAuthGuard` has verified the token and the wallet
    gate has found the wallet, so a forged or missing token never makes an
    entry and a person with no wallet is refused by the gate first. A search
    the route refuses with a 400 is read before it is counted and does not
    count. Beyond any window: `429 recipient_search_rate_limited`, "You have
    searched a lot in a short time. Try again in a little while.", with
    `retryAfterSeconds` (seconds to the end of the longest full window,
    rounded up, at least 1) and the same number in a `Retry-After` header.
    One account cannot get round it by changing address (a whole IPv6 /64 is
    one caller's), and two accounts on one address each keep their own
    budget while the address limit still holds for the address.
- **Contract.** The search declares its plain `400` (a malformed `q`, no
  `reason`) and `429` (`recipient_search_rate_limited`; the per-address 429
  has no `reason`); both lists carry `maxItems` (20 and 10).

---

## 14. Pay from wallet (MONEY-17)

As built in round 2 (4 Oct 2026, lead rulings D1 to D4, each "Default
(lead), owner may override"), and moved onto the wallet provider seam on 8
Oct 2026 (MONEY-20's `WALLET_PROVIDER`; R-39, R-42, R-44): nothing in
`src/money/payments/` names a provider's client, so the same routes pay on
Fintava or on Nuvion, whichever the server runs.

- **Routes** (`src/money/payments/`): `GET /money/payments/quote?kind=&targetId=&amountKobo=`
  (`PaymentQuoteView`, behind the wallet gate, `no-store`) and `POST
  /money/payments` (`PaymentDto`; `Idempotency-Key`, and the PIN or a
  biometric approval, `@RequireApproval()`), and `GET /money/payments/{id}`
  (`PaymentView`, MONEY-19, below). The holds stay declared for MONEY-18.
- **Fees and limits first** (NUV-07, BACKEND_GAPS G-410; round 6). Both
  routes carry `@RequireFeesSet()` as their last decorator, so while the
  running provider's fees are not set they answer `503 fees_not_set` before
  the wallet gate, the key and the PIN. The quote's `withinDailyLimit` and
  `remainingTodayKobo` say where WAWU's own purchase limit stands today
  (`MoneyLimits.dailyStanding`). The payment checks the limits
  (`MoneyLimits.assertMayMove`, kind `purchase`, the price) inside the
  claim's transaction (READ COMMITTED, under the limits' per-person lock),
  so two payments by one person are counted one after the other: past a
  limit is `403 limit_reached` with `reason.limit`, nothing stored or sent,
  the key free. The provider's own limit refusal is the same answer.
- **Text the database can store** (round 6, R5-2). A NUL or a lone
  surrogate in `quoteToken` or `note` is a plain `400` naming the field
  (main's `isCleanText`), before anything is claimed; a blank note is no
  note.
- **What is paid for.** Each selling feature registers its kind with
  `PayableRegistry` (MoneyModule exports it): `resolve` gives the title, the
  price from its own record and the payee (or `404 target_not_found`, `409
  target_not_payable`), and `onCompleted` delivers it once the debit is
  confirmed. **Delivery is at least once**: `onCompleted` can be called
  twice for one payment (a delivery slower than its lease, or a server that
  dies after telling the feature and before recording the delivery; two
  servers that race one due delivery tell it once, see the claim under "Airtight
  against a concurrent path") and must be idempotent. A delivery that fails is tried again on the same
  capped backoff as the check (1, 2, 4, 8, 16, 32, then 60 minutes, with its
  own count `deliveryAttempts` and next try `nextDeliveryAt`; the first retry
  is a minute after completion, so it does not race the one the completion
  started). Past `PAYMENT_REVIEW_AFTER_HOURS` (72) after completion with no
  delivery the payment goes to review (`reviewSince`, still `completed`, the
  item still claimed, so it is never payable again while money moved) and
  the sweep stops. A paid payment whose kind nothing registers at boot goes
  to review at once, logged, never skipped in silence. A kind nobody registered answers `409 target_not_payable`
  "This can't be paid for from your wallet yet." Held kinds (paid DM,
  ticket, bill) register like any other and complete into a hold (section 18). `amountKobo` and `note` only on
  a tip; paying for your own item is `target_not_payable`.
- **Naira only.** A feature may say what currency its price is in
  (`PayableTarget.currency`, ISO 4217; unset is `NGN`). Only `NGN` is paid
  from the wallet: an item priced in another currency (R-43's dollar prices)
  is `409 target_not_payable` "This isn't priced in naira, so it can't be
  paid from your naira wallet." on the quote and the payment, and nothing is
  stored, so a price in cents is never taken as kobo. Paying in dollars is
  NUV-09's dollar wallet.
- **The quote is bound to the item.** The payment quote's `quoteToken` is
  the fee quote (section 11) signed with the subject
  `payment:<kind>:<targetId>`; `POST /money/payments` checks it with the
  same subject, so a quote for one item, or a plain `GET /money/fees/quote`
  token, never pays another (`409 quote_changed` with `reason.paymentQuote`,
  the quote as it stands). Expired, another person's, another price, signed
  before a restart: the same answer.
- **The money.** One `walletToWallet` of the price through the seam, from
  the buyer's wallet to WAWU's own account at the provider
  (`getPlatformAccount`, read once per process): on Fintava a
  `/transaction/wallet-to-wallet` to the merchant wallet (R-19), on Nuvion a
  book transfer to the operational account's `nuvion_ban` (R-42, NUV-05).
  Our reference `wawu-pay-<payment id>` (45 characters, inside Nuvion's 64
  for `unique_reference`). The provider takes its charge on top (R-10), as
  the quote showed (`fee.providerFeeKobo`; `wawuFeeKobo` 0). Each payment
  records the provider that took it (`WalletPayment.provider`).
- **What the seam's answer means.** `walletToWallet` resolves with a receipt
  only for a transfer the provider has completed; the payment is then
  `completed` (or held for review when another amount moved). A transfer the
  provider accepted and has not completed (Nuvion's `pending` or
  `processing`) is `not_confirmed`, and a lost answer `outcome_unknown`:
  both may have moved money (`recordMayExist`), so the payment stays
  `pending` and is settled as below. A provider that cannot make the
  transfer (`not_supported`), is not set up, or refuses our key answers `503
  provider_unreachable` and gives the key back, as `not_configured` always
  did. Every such refusal is the provider
  error's own answer (`toHttpException()`): a frozen wallet `423
  wallet_frozen`, the provider's limit `403 limit_reached`, anything else
  `503 provider_unreachable` with the provider's wait; insufficient funds
  keeps its shortfall answer (below).
- **Nuvion's book transfer** (NUV-05). `POST /transfers` with
  `payment_type: "book-transfer"`, the receiver named by its `nuvion_ban`,
  our reference as `unique_reference`, the buyer's `entity_id` (WAWU's
  operational account sends with none). Nuvion answers `pending` first
  ("all transfers are asynchronous"), so the adapter reads the transfer
  again for a few seconds (`NUVION_BOOK_SETTLE_STEPS_MS`, under four
  seconds in all) before it answers `not_confirmed`; nothing is sent again
  meanwhile. Every book transfer is written to `NuvionBookTransfer` BEFORE
  it is sent (the log of our reference, the accounts, the amount, Nuvion's
  id once read): Nuvion has no lookup by our reference, so a transfer whose
  answer was lost is found again from that row, by the sender's transfers
  (`GET /transfers?entity_id=&account_id=`), never sent under a new
  reference; a repeat of one reference is Nuvion's original, and a
  reference reused for other accounts or another amount is never sent
  (`duplicate_reference`, nothing leaves). Nuvion's `outflows.created`,
  `.completed`, `.failed`, `.cancelled` and `.refunded` are read back from
  Nuvion before they are acted on and merge the transfer's state into the
  ledger rows the payment wrote (completed at the charge Nuvion states as
  `applicable_fee`, failed, or reversed), once, in any order and however
  many times they come.
- **WAWU's own account is never the payer** (round 6, R5-1). Before the
  claim, the payer's wallet is compared with WAWU's account by identity,
  not by format: the same text, or the provider's `isSameAccount` (Nuvion
  knows one account by its NGN account number, its id and its
  `nuvion_ban`). The same account is `503 provider_unreachable`, logged,
  nothing sent.
- **The real debit is the record, on every path** (round 6, lead ruling 5;
  round 7, lead ruling R6-1). The payment records and answers the fee and
  total the provider really took, never the quoted ones. One function
  (`completedFigures`, `payment-figures.ts`) decides them from the
  provider's own record, and one method completes the payment from it
  (`completeFromRecord`) whichever job gets there first: the provider's
  answer to the send, the payment sweep's lookup, a ledger row the status
  check or a webhook settled, or a signed webhook that reports a charge
  other than the quote (round 8, R7-1). That last one is the only source of
  a Fintava charge on a lost answer (its lookups carry none): the ledger
  keeps the buyer's row at its figures (a stop), tells the payment what the
  provider reported (`LedgerService.onPaymentDebitSighted`, from
  `LedgerRecordResult.debitSighting`), and the payment completes at those
  figures through the same method, whether it is still `pending` or the
  sweep completed it at the quote first (a late report corrects the
  figures, the flag and the buyer's row, and nothing is delivered twice).
  A seam record that carries the provider's charge
  (`ProviderTransaction.feeKobo`: Nuvion's `applicable_fee`) is compared;
  one that does not (Fintava's lookups and history) leaves the quote
  standing. Once the provider's charge is known, the buyer's ledger row says
  it in `providerFeeKobo` on every path, never the quoted one (round 8, F1);
  history, statements and the receipt still read it through `feeOf`.
  - **Above the quote** (lead ruling, 10 Oct 2026): the money left the
    wallet at the provider's figures, so both ledger rows complete at them
    (the buyer's row takes the provider's charge, exactly as below), and a
    delivered purchase never sits `pending` in `GET /money/transactions`.
    `debitReviewSince` is set on the payment and both figures are named on
    `discrepancy` (NUV-08 reconciles it with the provider); the price moved
    as asked, so what was paid for is delivered. A row that holds a
    disagreement about the AMOUNT is still held (a stop); the row's note may
    keep the quote.
  - **Below the quote**: nobody is owed anything. Both ledger rows complete
    at the real figures (the buyer's row takes the provider's charge), the
    payment records them and the difference on `discrepancy`, and nothing is
    flagged. A delivered purchase is never left `pending`.
  - **The merchant (`in`) row completes with the payment on every path**:
    whichever of the payment sweep and the ledger status check gets there
    first, both rows end `completed` and the item is delivered once (R6-2).
- **A reversal** found by the sweep (round 6, lead ruling 7): the provider
  moved the payment and gave it back, so the payment is `reversed`, both
  ledger sides `reversed`, nothing delivered, the item free; nothing is
  owed back by WAWU. A reversal of another amount than the price is a stop
  (review, the item claimed). A status word the provider has and we do not
  know is never read as failed: still `pending`, asked again later.
- **The provider on every ledger row** (round 6, lead ruling 6): NUV-01
  merged first, so the ledger stamps the running provider on every row it
  creates. For a payment that is always the payment's own provider: the
  sweep acts only on the running provider's payments, and another
  provider's pending payment goes to review without a ledger row. The
  payer's wallet must be the running provider's too: NUV-01's balance read
  answers `503 provider_unreachable` for a wallet another provider holds,
  before anything is claimed or sent.
- **One open payment per buyer and item** (D1.2). While a payment is
  `pending` (under review included), another for the same person, kind and
  target, under any Idempotency-Key and at any moment, is `409
  payment_in_progress` with `reason.paymentId`. Held by a unique column
  (`WalletPayment.openKey`) from the claim until the payment is completely
  finished: cleared when it fails, is reversed, or, once paid, when what was
  paid for is delivered (the feature's record that the buyer owns it is then
  in place), never at the moment the provider confirms. The claim is taken before
  the feature's "already owned" rule is read for the last time, and given
  back (nothing sent, failed, the key freed) when that now refuses. The
  quote (`GET /money/payments/quote`) of a SCHOOL FEE answers the same `409
  payment_in_progress` with `reason.paymentId` when the SAME payer holds the
  open payment for the SAME target (FIX-58), so a second phone is never
  shown a Pay the PIN tap would refuse; it is read after the item (an item
  gone or not payable is that answer first) and before anything is priced.
  Every other kind is quoted as before, open payment or not (the 409 meets
  the payer at the PIN tap); a kind joins `QUOTE_REFUSES_OPEN_KINDS`
  (`src/money/payments/wallet-payment.service.ts`) when its app caller reads
  the 409 at the quote. Another person's open payment, or this payer's for
  another item, changes nothing. The routes of the features that quote
  through the same service (plans, points packs, bills, credit packs, event
  orders) are unchanged.
- **Before money moves**, in order, none of which stores anything: the
  wallet gate, the Idempotency-Key, the PIN, the body, the target, the
  quote, the merchant cap (`amount_out_of_range`), an open payment for the
  item, the provider's available balance (`402 insufficient_funds` with
  `balanceKobo`, `totalKobo`, `shortfallKobo`, "You need ₦523.25 more in
  your wallet."; a buyer holding exactly the total pays). When the provider
  itself refuses for funds, the balance is read again: a real shortfall is
  shown as above; otherwise "Your balance changed. Check it and try again."
  with no `shortfallKobo` (D3). A shortfall shown is never ₦0.00 or less.
  WAWU's own purchase limits are checked inside the claim, after these (see
  "Fees and limits first").
- **The split** is recorded on the payment (`WalletPayment`), of the price
  only: the payee's 85% rounded down to the kobo, WAWU's 15% the rest (R-5;
  ₦1,000 is ₦850 and ₦150, ₦999.99 is ₦849.99 and ₦150.00). No payee: all
  of it is WAWU's. Landing the 85% in the payee's wallet is WALLET-16's
  (section 19).
  Deleting the payer's account keeps the payment (the payee's share may be
  unpaid) with the payer side set to null (`ANONYMISED` in the account data
  map).
- **The ledger** gets both sides (buyer `out`, merchant `in`, category
  `purchase`, `paymentId`, the link) as `pending` in the same transaction as
  the payment, with the quoted charge as the expected fee, then the
  provider's figures from its answer. A difference is decided as the
  paragraph "The real debit is the record" says (a charge below the quote,
  as Fintava's sandbox's ₦0, completes the rows at what was taken and is kept
  on the payment's `discrepancy`; one above completes them at what was taken
  too and is flagged on the payment for MONEY-16 and NUV-08).
- **Answers** (all `201` with `PaymentView`, stored for the key):
  - `completed`: the provider moved the price.
  - `pending`, with `statusMessage` "We're still confirming this payment.
    Don't pay again; we'll let you know.": the outcome is not known (a
    timeout, a 5xx, a 2xx without a transaction, a repeated reference, a
    transfer accepted and not completed), or the provider moved another
    amount than the price (then straight to review). **Absence is never
    proof that no money moved** (D1): the provider having no record of the
    transfer yet keeps it `pending`. The payment sweep (every minute) asks
    the provider itself (`reconcileSend`: lookup by our reference, then the
    buyer's history), backing off 1, 2, 4 ... minutes to hourly, never sends again
    and never refunds; past `PAYMENT_REVIEW_AFTER_HOURS` (PROVISIONAL, 72) it
    goes to manual review: still `pending`, out of the sweep, the item still
    blocked. A payment another provider took (written before a switch of
    `WALLET_PROVIDER`) is never asked of the running one, whose silence
    about it says nothing: it waits for its ledger rows and goes to review
    past the bound, its note naming the provider. Whatever settles a payment's ledger row (a webhook, MONEY-08's
    status check, a reversal) settles the payment at once (D2), including a
    payment under review or in its hourly backoff, and the webhook consumer's
    own transaction: the payment hears of its ledger rows once that
    transaction has committed (R3-3).
  - `failed`, with `failureReason` "The payment did not go through. No money
    left your wallet.": only the provider's own refusal of the transfer, or
    its failed record. The provider's "not enough", a frozen wallet, or the
    provider being unusable (no key, wrong key, merchant inactive, no such
    transfer yet) fail the payment, give the key back, and answer `402`,
    `423 wallet_frozen` or `503`.
  - `reversed`: the debit came back.
  A key answers what it stored: a payment answered `pending` stays `pending`
  on its key after it completes; the app reads the outcome from `GET
  /money/payments/{id}` (MONEY-19, below).
- **Paid twice for one item** (D1.4): if a second payment for the same
  person and item completes while another was open, both carry a
  `discrepancy` for MONEY-16. The hold's refund (section 18) does not cover
  it: an ordinary payment has no hold, and which of the two payments is the
  extra is a person's call (BACKEND_GAPS G-70 in the mobile repo).

### 14a. Not enough money, and still confirming (MONEY-19)

- **How much short** (H17, I6, S11, W13). One answer on every route that
  takes money from a wallet: `402 insufficient_funds` with `reason.balanceKobo`
  (the wallet provider's available balance read for this request, never a sum
  of our own records), `reason.totalKobo` (what the movement needs: the amount
  plus every fee the person pays, R-10) and `reason.shortfallKobo` (the total
  minus the balance), and the sentence "You need ₦523.25 more in your wallet."
  It is built by `insufficientFunds(balanceKobo, totalKobo)` in
  `src/money/insufficient-funds.ts`, which refuses to build a shortfall of
  zero or less; a route that serves a send (WALLET-07, WALLET-09) throws it
  from there. On a payment the same figures are on the quote before the PIN
  (`PaymentQuoteView.balanceKobo`, `shortfallKobo`, which is 0 when the wallet
  covers the total, and null with the balance when the provider did not
  answer). A ₦1,000 item with ₦500 in the wallet is `balanceKobo` 50000,
  `totalKobo` 102325 and `shortfallKobo` 52325 at a provider charge of
  ₦23.25 (the dashboard's Fintava rate; Nuvion's charge is a setting). Nothing
  is stored, claimed or sent, and the Idempotency-Key is free for the same
  payment once the person has added the money.
- **The poll** (H18, E10). `GET /money/payments/{id}` answers the payment's
  `PaymentView` as it stands now, `Cache-Control: no-store`, behind the
  wallet gate; it needs no Idempotency-Key and no PIN and moves nothing.
  Only the payer reads it: another person's payment and an id nobody holds
  are the same `404 not_found` ("We could not find that payment."); a
  malformed id is a plain `400`. It reads our record only and never asks the
  wallet provider, so the app can poll it freely; what moves a payment on is
  the sweep (every minute), the provider's webhooks and the ledger's status
  check, each settling the payment as in section 14. The app polls after a
  `pending` answer, after a `409 payment_in_progress` (`reason.paymentId`),
  and from "Refresh" on H18 and E10.
- **What the app reads from it.** `status` is `pending`, `completed`,
  `failed` or `reversed`. A `pending` payment ends as `completed`, `failed`
  or `reversed` at the next sweep after the provider (or a webhook) says
  which, and the poll shows it from then on. `delivered` is true once what
  was paid for has reached the buyer (`completed` and the owning feature
  recorded the delivery, or there is nothing to deliver), and false while
  `pending`, `failed`, `reversed`, and while a `completed` payment's delivery
  is unfinished: "paid, still opening" (H18), `statusMessage` "Your payment
  went through and we're finishing it. Don't pay again." (the sentence
  `payment_in_progress` already answers), the sweep delivering it again.
  The app stops polling when `status` is not `pending` and, for `completed`,
  `delivered` is true. The answer to `POST /money/payments` carries the same
  fields, so a delivery that succeeded inside the request reads
  `delivered: true` there.
- **A provider that never answers.** The one case where a payment is still
  `pending` after the sweep has asked is a provider that gives no answer: no
  record of the transfer, or a transfer it keeps `pending`. That is never
  read as "no money moved" (lead ruling D1), so past
  `PAYMENT_REVIEW_AFTER_HOURS` (PROVISIONAL, 72) the payment goes to review,
  still `pending`, out of the sweep, the item still blocked, and the poll
  keeps saying "We're still confirming this payment. Don't pay again; we'll
  let you know." A webhook or the ledger's status check still settles it.
  Whether something should end such a payment on its own is a ruling
  (BACKEND_GAPS G-480 in the mobile repo), not a default.

---

## 15. A NUL, or other text Postgres cannot take (FIX-17)

Postgres refuses a NUL (U+0000) in a text parameter (error 22021), so a `%00`
that reached a query answered 500: on the 23 routes FIX-07's verifier found
and seven more FIX-17's sweep found. The code base had no single rule: a NUL
was stripped (money searches, AI text), refused (legal documents,
the assistant, the profile audience) or replaced with U+FFFD (the Fintava
webhook). From FIX-17 on there is ONE rule, and it holds for every route,
money routes included:

- **Refuse it with 400 naming the field, before any query runs.** The body is
  the plain 400 (no `reason`):

  ```json
  { "statusCode": 400, "message": "<field> must have text in it, with no null characters or broken characters", "data": null }
  ```

  One sentence for this fault everywhere (`unstorableTextMessage` in
  `src/storable-text/storable-text.ts`); `/search` (FIX-07) and `/schools`
  (SCHOOLS-04) already answered it for `q`. The app treats it as any
  malformed request.
- **What counts:** a NUL, or a lone UTF-16 surrogate, anywhere in the value
  (`isStorableText`). Over HTTP only the NUL arrives: Express turns a
  percent-encoded surrogate or broken UTF-8 into U+FFFD, which is searched
  for like any other character. A blank value is not this rule's business,
  and every other character (control characters, U+FFFD, U+FFFE, emoji) is
  accepted.
- **Where, with no line per route:** every query and path value of every
  route, every method. `checkStorableTextOnEveryRoute(app)` puts one pipe last
  on every argument of every route the app mounts, so a route added later is
  covered automatically. It is called from `configureHubApp(app)`
  (`src/hub-app-config.ts`), the one function `src/main.ts` calls between
  creating the app and listening, and it must run before `app.init()` or
  `app.listen()` (Nest reads each handler's arguments then). A test app that
  should answer as the Hub does calls `configureHubApp(app)` too (the Hub spec
  in `src/storable-text/tests` does, and pins that `main.ts` calls it first and
  never calls `init()` itself).
- **What answers first, unchanged:** a guard (`401`, `403`, `409
  wallet_not_open`, `423`), every check that already refused the value (the
  ValidationPipe's `MaxLength`, `IsUUID`, `IsIn` and so on, the argument's
  own pipe such as `ParseUUIDPipe`), and a fault in another argument (an
  undeclared query key, a bad body). Only text that every other check let
  through is refused here. Query keys are never read: an undeclared key is
  the ValidationPipe's (`property x should not exist`) or is ignored.
- **Request bodies are not in this rule yet.** FIX-17 changed no body. What
  a body does today stays: money text and AI text strip a NUL, legal
  documents, the assistant and the profile audience refuse it (`IsCleanText`,
  the same sentence). A new body field that stores text refuses it the same
  way (`@IsCleanText()`, or `isStorableText` for a field that may be blank).
  A provider's webhook body is the one standing exception: it is recorded,
  with a NUL replaced by U+FFFD, because refusing it would lose the
  provider's event.
- **Money searches.** `GET /money/transactions?q=` and `GET
  /money/recipients?q=` stripped a NUL in code (`searchText` in
  `transaction-history.service.ts`, `recipient-query.ts`). For a person with
  a wallet the refusal now answers first (`409 wallet_not_open` still comes
  first for a person without one), and a refused recipient search does not
  count towards the person's limit (section 13). The strip code no longer
  sees a NUL from a query string; it stays until the money owner removes it.

---

## 16. Points (POINTS-01)

Points are not money: no provider holds them, no route converts them to
naira or dollars, and every figure is a count of points (R-43). They are
written here because the tasks that sell, spend and cash them out
(TIER-03, POINTS-02 to POINTS-04, REF-01) answer in this one error shape.

- **Where they live.** `src/points/`: `PointLot` (one grant: how many, how
  many are left, when they end), `PointHold` (points taken for one job until
  it is committed or released) and `PointLedger` (append-only, one row per
  change to one lot). The lots are the authority for points; a balance is the
  sum of a person's lots that have points and have not ended.
- **The one writer.** `PointsService` (exported by `PointsModule`): `grant`,
  `hold`, `commit`, `release` and `expireLapsed`. The first four can join the
  caller's own READ COMMITTED transaction (`{ tx }`), so a payment can set a
  tier and grant its bonus in one commit; `expireLapsed` takes no `tx`: it is
  the expiry job's pass and writes each lapsed lot off in a transaction of
  its own. The account purge's `purgePersonPoints` is the only delete.
  Nothing else writes these tables.
- **Idempotent.** A grant on its (source, reference) and a hold on its
  (purpose, reference): the same call again changes nothing and answers what
  the first one made, in its current state (a released hold stays released:
  a new attempt needs a new reference). The same reference for another
  person or amount is a 409, also when the two arrive at the same moment.
- **A lot's end** must be after now and before 2100-01-01 UTC
  (`POINTS_LATEST_END`), else `400 points_invalid`. The database holds the
  end between 2000-01-01 and 2100-01-01 UTC.
- **Spent soonest-ending first,** then oldest grant, then lot id. A release
  puts every point back into the lot it came from.
- **Bought points never end and are never cashable** (R-101 point 7,
  POINTS-BOUGHT, owner, 27 Oct 2026, on every platform). Lots of source
  `pack` (a points pack paid by the wallet, by transfer or in a store, its
  bonus points included), `bump` and `shortfall` are stored with the "never"
  end `POINTS_NEVER_EXPIRES` (2099-12-31 23:59:59.999 UTC, `src/points/
  points-bought.ts`) whatever end the caller gives; the expiry job never
  reaches them, a balance and a hold count them, and every view answers their
  end as `null`. Earned and bonus lots (`tier_bonus`, `referral`) keep their
  end and must end before the "never" end. The spend order BEFORE was the
  soonest end across all lots, bought ones included (they ended after the
  plan's `bought_expiry_days`); it IS now: lots that end, soonest end first
  (then oldest grant, then lot id), then the lots that never end, oldest
  first, so nobody loses earned points to an end date while holding bought
  ones. A hold to turn points into cash (`purpose: cash_out`) takes only
  earned and bonus lots, soonest end first; more than those, with the balance
  covering it, is `422 points_not_cashable` (`balancePoints`,
  `cashablePoints`, `neededPoints`), and more than the balance is
  `402 insufficient_points`. A store refund still takes back only what is
  unspent of the refunded lot (`revokeLot`). The migration
  `20261211090000_points_bought_never_expire` cleared the end of the bought
  lots that existed (the old ends are in `PointLotExpiryChange`; its rollback
  restores them and refuses if a lot was spent past its old end, or would
  lose points at once); the plan setting `points.bought_expiry_days` no longer
  ends any lot.
- **What the database refuses** (the migration's CHECKs and triggers): a lot
  below 0 or above what it was granted, or ending outside 2000 to 2099; a lot
  whose points differ from the sum of its ledger rows when the transaction
  commits; any UPDATE or TRUNCATE of the ledger; any DELETE of ledger rows
  except the account purge's (`purgePersonPoints`: one transaction, the
  person's points lock, `wawu.points_purge` set to
  `<person id>:<txid_current()>` for that transaction, then all of that one
  person's rows in one statement; a value left at session level names an
  earlier transaction and is refused); a hold
  moving anywhere but from `held` to `committed` or `released`, or a settled
  hold changing at all.
- **Refusals** (`PointsError`, `src/points/points-error.ts`): `402
  insufficient_points` with `balancePoints`, `neededPoints`,
  `shortfallPoints`; `409 points_grant_conflict`; `409 points_hold_conflict`;
  `404 points_hold_not_found` (also for a commit or release whose hold the
  account purge deleted while it waited for the person's lock); `409 points_hold_settled` (spent, or already
  given back); `400 points_invalid`. A field that carries points ends in
  `Points`, as money fields end in `Kobo`.
- **`GET /me/points`** (PT5): `balance`, `cashablePoints` (earned and bonus
  points that have not ended: the most that can be turned into cash),
  `nextExpiry` or null (the soonest end and every point that ends then, over
  all live lots that end; null when every lot is bought), `lots` (in the order
  they are spent, at most 50, `lotCount` says how many in all; each has
  `cashable`, and `expiresAt` is null for bought points), `movements` (the last
  20 ledger rows, newest first, each with a plain `label` and `pending` for a
  hold still running). `Cache-Control: no-store`; the token is the person.
- **For every caller** (lead, 8 Oct 2026): call `grant` or `hold` last in your
  transaction, and never wait on a provider while you hold a person's points
  lock: this service's own transactions use Prisma's 5 s default, so a
  points call for that person would fail meanwhile.

### 16a. Spending points on AI tools (POINTS-03)

Every cost, cap and rate is an admin setting (R-65), read from the live plan on
each call: `points.action.<id>` (points for one unit), `points.daily_cap`,
`points.max_chars_per_job`, `points.max_audio_min_per_job`,
`points.price_kobo_per_1000` (the pack rate a shortfall is sold at) and
`points.job_max_run_minutes` (how long an AI job may hold points). Points are
a count, never naira; money fields end in `Kobo`.

- **The internal service.** `PointsSpendService` (`src/points/spend/`,
  exported by `PointsSpendModule`) is what the AI tools' server code calls:
  `hold(input)` before the job, `commit(holdId)` when it worked,
  `release(holdId)` when it did not. `hold` prices the job (`action`,
  `units`, `languages` for dubbing, `characters`), checks the caps, and takes
  the points, all under the person's points lock in ONE database-only
  transaction with the hold as its last write: two jobs at once never pass
  the daily cap together and never take the balance below zero. A call that
  waits on an AI provider must do it OUTSIDE `hold`, holding nothing. Every
  attempt needs its own `reference` (`jobHoldReference(jobId, attempt)`): a
  reference that was spent or given back is `409 points_hold_settled`, never
  returned as a hold. `commit` and `release` settle `ai_job` holds only.
- **`POST /points/quote`** (PT1 to PT3, PT7), body `{ action, units,
  languages?, characters? }`: `costPoints`, `balancePoints`, `shortfallPoints`,
  `canRun`, `useWallet`, `cap` (the cap that stops the job, or null) and
  `wallet` (with a shortfall and "Use wallet" on: the wallet money for exactly
  the shortfall at the pack rate, with the wallet payment's own signed quote)
  or `walletNote` (why not: no wallet yet, a dollar-billed person, fees not
  set). Always 200; it holds and takes nothing. A cap that stops the job
  shows no wallet money.
- **A cap names itself.** `cap` is `daily` (points of AI jobs held or spent
  since the Lagos day began; a given-back job does not count; `resetsAt` is the
  next Lagos midnight), `characters_per_job` or `minutes_per_job` (`resetsAt`
  null). Held, the answer is `422 points_cap_reached` with `cap`, `capLimit`,
  `capUnit` and, for the day's, `usedPoints`, `remainingPoints`, `resetsAt`;
  nothing is held.
- **`POST /points/shortfall`** (PIN, `Idempotency-Key`), body = the quote's
  job + `expectedTotalKobo` (`wallet.payment.totalKobo`) + `quoteToken`
  (`wallet.payment.quoteToken`): buys exactly the shortfall from the wallet as
  a wallet payment of kind `points_shortfall` (target `shortfall-<points>`, the
  provider's charge on top, WAWU's own sale, not held) and adds one lot
  (source `shortfall`, keyed by the payment) once, last in a database-only
  transaction; nothing is held across the provider call. `201` with a
  `PointsShortfallView` (`paid`, `pending`, `failed`); poll
  `GET /points/shortfall/{id}`. Points, rate and expiry are the payment's terms:
  a balance, rate or expiry that changed since the quote is `409 quote_changed`
  with the new quote, nothing moved. Not short any more (including the same
  quote sent again under another key) is `409 points_not_short`; a cap is `422
  points_cap_reached`. "Use wallet" only decides whether the quote offers the
  money; the PIN is the confirmation. Naira only (R-16): a dollar-billed
  person is `409 target_not_payable`.
- **`GET` and `PUT /me/points/settings`**: `{ useWallet }`, off by default, each
  person's own.
- **The sweep.** Every five minutes, `ai_job` holds still `held` after
  `points.job_max_run_minutes` are given back by id. A late commit and the
  sweep cannot both win: the second is `points_hold_settled` and is skipped.

---

## 17. Documents and the hosted selfie (NUV-03)

Opening a wallet on Nuvion takes an ID document and a proof of address dated
within 3 months (R-42), and Nuvion's hosted selfie when it is in use (R-39).
The routes are part of opening, so they are not behind the wallet gate
(section 7); a person with no opening started gets the same `409
wallet_not_open` as every wallet route. The token is the person: no route
takes a user id or a Nuvion id. Every answer is `Cache-Control: no-store`.
Under a provider that reviews no documents (Fintava) the routes exist and say
nothing is needed.

| Route | What it does |
|---|---|
| `GET /money/identity/documents` | Both documents' state, whether uploads are open, what the opening waits for. When the documents are in and the opening is due to be sent (or its sending was lost), it sends it, once. |
| `POST /money/identity/documents` | Multipart: `kind` (`identity` or `proof_of_address`), `file` (a PDF, JPG or PNG, 10 MB at most) and, for an ID with a back side, `file_back` of the same type. Sends the document to Nuvion once and answers the documents view. |
| `GET /money/identity/liveness` | The hosted selfie: `enabled`, `state`, `url` while pending, `canStart`. Reads the result from Nuvion. |
| `POST /money/identity/liveness` | JSON `{ redirectUrl? }` (https only). Starts the selfie, or answers the one already running, and returns the secure page to open. |

- **One request per document.** Nuvion's `POST /documents` takes the front and
  the back in one call and WAWU keeps no copy to hold a front until a back
  arrives, so the two sides of an ID go in one request. A `side` field is
  accepted only as `front`.
- **WAWU keeps no file.** It goes to Nuvion; WAWU keeps the kind, the sides,
  the state, Nuvion's document id, the time, whether Nuvion's review refused
  it, and an HMAC-SHA256 of the bytes under `IDENTITY_HASH_KEY` (as the BVN's
  hash is; so the same file sent twice is forwarded once, and nobody who can
  read the table can test whether a person sent a given file). The
  fingerprint is cleared once the opening is submitted: after that nothing is
  compared with it, and any upload is `documents_closed` until the review
  refuses a document and details are corrected. The type is read from the
  bytes, never from what the client names it.
- **Each step is progress** (round 4, NUV-02 G-497): a document sent (when it
  is accepted for sending, and again when Nuvion has it), the selfie started
  and the selfie coming back passed, and the submit call each write
  `NuvionEntity.progressAt` (the submit call also `submittedAt`, so a refusal
  read after it can be a new decision, section 9a). An opening being worked
  on is therefore never closed by the hold expiry for being idle; one with
  nothing done for `IDENTITY_HOLD_DAYS` is, as section 9a says, and one whose
  account has held its BVN for `IDENTITY_HOLD_LIFETIME_DAYS` is whatever was
  done (round 4, R4-2). Support sees
  the same time. A failure to write the time never fails the step.
- **The same file again** (a double tap, a retry after a lost answer) is the
  answer it already got, until the opening is submitted. **A different file**
  replaces the first while the opening still takes documents.
- **A document is `uploaded` only on Nuvion's answer.** An answer that was
  lost leaves it `confirming`; nothing is sent again until the call's own
  time has passed. Past that time `GET /money/identity/documents` reads
  Nuvion's list of the entity's documents: a document it took reads
  `uploaded`; one it never got, or a list that cannot be read, reads
  `send_again` (WAWU keeps no copy: ask the person for the file again; the
  upload route looks at Nuvion's list once more before it sends, so a file
  Nuvion has is never sent twice). `not_accepted` means Nuvion refused the
  last file (send another).
- **A refused document stays refused.** `needs_new` means Nuvion's review
  said this upload did not pass. The refusal is kept on the document's own
  row, written where the entity's word for it is written (the delivery and
  the correction of the details), so it survives a correction that Nuvion
  answers with the check back at `pending` (as its own `PATCH
  /individual-entities` sample does). The person is asked for a new file,
  and the opening is not sent again without one: only a new upload of that
  kind clears the refusal.
- **The opening is sent for review once**, when both documents are `uploaded`
  (and the selfie has passed, when it is in use), behind a claim taken before
  `POST /onboarding-submissions`; `GET /money/wallet` then reads `checking`.
  A submission Nuvion refused is not sent again for a minute, or until a
  document changes. Corrected details after a refusal start it again.
- **The selfie** is off unless `NUVION_HOSTED_LIVENESS=on`, and it is the
  server's one switch, never a row of one person. A refused session start is
  read by whom it is about:
  - Nuvion saying its API is not available to this key (`error_endpoint_not_found`,
    404, "API endpoint does not exist"; `error_auth_permission_denied` or
    `error_auth_elevated_permission_required`, 403) turns the selfie off for
    everyone on that server for an hour, logged as an error without any
    person in it; the opening goes on without it and `POST` answers `409
    selfie_not_available`. These are the only such answers Nuvion's errors page
    lists; if the sandbox shows another, it is one more line
    (`LIVENESS_API_UNAVAILABLE_TYPES`).
  - A return address Nuvion will not take (a refused body, with an address
    sent) is that person's `400 document_request_invalid`.
  - Anything else about the person's request or entity (an identity,
    entity or account refusal, no such record, a rate limit, a refused
    body with no address) is `503 provider_unreachable` with `retryAfterSeconds`
    for that person to wait out or retry. The step stays required of them:
    no one gets past the selfie by being refused.
  - A lost answer or a 5xx turns nothing off and records nothing.
  The return address must be https, with no credentials or encoded dots or
  slashes, on an origin AND under a path prefix listed in
  `NUVION_LIVENESS_REDIRECT_ORIGINS` (`https://app.example/open` allows `/open`
  and `/open/...` there, not `/opening`); an empty list allows no address,
  and no address at all is allowed (nothing is sent).

| `reason.code` | HTTP | When | Extra fields |
|---|---|---|---|
| `wallet_not_open` | 409 | no opening started | |
| `document_request_invalid` | 400 | no or unknown `kind`, no file, a field or part we do not read, `file_back` for a proof of address, a return address that is not https or not one the server lists (origin and path prefix, `NUVION_LIVENESS_REDIRECT_ORIGINS`), or one Nuvion refused for that person | |
| `document_file_invalid` | 422 | a file that is empty, over 10 MB, not a PDF, JPG or PNG, or two sides of different types; nothing is sent | |
| `document_not_accepted` | 422 | Nuvion read the file or the details and refused them; nothing was kept | |
| `documents_closed` | 409 | the opening is not taking documents now (sent, decided, stopped, or a refusal not yet corrected), or this wallet needs none. An opening the sweep expired answers with the wallet view's own words for it ("We closed your wallet application because it was not finished. Send your details again to start a new one."): no upload is taken, no selfie is started and nothing is sent to Nuvion until the person sends their details again (round 4, R4-1) | |
| `document_in_progress` | 409 | the last upload of this kind is still being confirmed, or a selfie is being started | `retryAfterSeconds` |
| `document_rate_limited` | 429 | too many uploads (or selfie starts) for now (`PROVISIONAL(NUVION-DOCUMENT-UPLOAD-LIMITS)`) | `retryAfterSeconds` |
| `document_busy` | 503 | the server is busy with other uploads | `retryAfterSeconds` |
| `selfie_not_available` | 409 | the selfie is not part of this opening (not in use, or Nuvion said its API is not available to us) | |
| `identity_under_review` | 409 | Nuvion has the details with its compliance review | |
| `provider_unreachable` | 503 | Nuvion did not answer, the answer is not confirmed yet, or it would not start this person's selfie (the step stays required) | `retryAfterSeconds` |

The codes of this section are the task's own (`src/nuvion/documents/document-errors.ts`),
not in the money contract's shared list; each route's entry in the contract
lists the ones it can answer.

---

## 18. Hold, release and refund (MONEY-18)

Money held between a payer and a payee (R-19): a paid DM, an event ticket and
a bill are paid into WAWU's own account at the wallet provider (section 14),
and the price waits there until something happens. It is then **released** to
the payee or **refunded** to the payer. Fintava has no way to reserve part of
a balance, so a hold is a row of ours plus money in WAWU's account; the
provider's balance is still the only balance (MONEY-11) and nothing here is
added up into one.

- **Routes** (`src/money/holds/`, behind the wallet gate, `no-store`, from our
  own records: they never call the provider, so none answers
  `provider_unreachable`): `GET /money/holds?role=payer|payee&cursor=&limit=`
  (`HoldPage`, newest first by `heldAt`) and `GET /money/holds/{id}`
  (`HoldView`; its payer and its payee read it, anybody else gets `404
  not_found`). The cursor is `h1.` plus base64url of the last hold's time and
  id; one the server did not write is a plain `400` ("cursor is not one this
  list gave."). No route releases or refunds: a client never moves a hold.
- **A hold comes to be** in the same transaction as the completion of a
  payment of a held kind (`WalletHold`, one per payment): the payment is
  `completed` exactly when its price is held. `PaymentView.hold` carries it
  (`status: held`), `GET /money/payments/quote` says `willBeHeld: true`, and
  the feature's `onCompleted` is told its id (`CompletedPayment.holdId`).
  What releases each kind is fixed: `paid_dm` `dm_answered`, `event_ticket`
  `event_took_place`, `bill` `bill_delivered`, `school_fee` `intake_started`
  (`holds/hold-rules.ts`). The
  buyer's ledger row stays a `purchase`; they paid the price and the
  provider's charge (R-10) and the price is not spendable: it is already in
  WAWU's account.
- **The owning feature decides, once** (`WalletHoldService`, exported by
  `MoneyModule`; nothing else moves a hold):
  - `release({ paymentId } | { holdId })`: the payee's 85% moves from WAWU's
    account to the payee's wallet; the 15% is WAWU's and stays; with no payee
    (a bill) or a share under a kobo nothing moves and the hold is over.
    The payment's `payeeSettledAt` is set when it is paid, so WALLET-16 never
    lands the same share again (WALLET-16 skips a payment that has a hold).
    **Asked with `asEarning`** (a paid question, an event ticket; R-55, lead
    ruling 17 Oct 2026) the share is not a transfer of its own: the release is
    one database write that makes the hold `released` (no `transferKobo`, no
    reference) and makes the payee's `EarningSettlement` for the payment, which
    goes to their wallet in their ONE move a day with their other earnings
    (section 26); `payeeSettledAt` is set when that move lands. The money stays
    in WAWU's account until then (R-19).
  - `refund(...)`: the **price** moves back to the payer's wallet. The
    provider's charge on the original payment is not returned (R-10), unless
    the owning feature asks `returnCharge` because the payer did not cause the
    refund (a lapsed paid question, a tip, unlock or legal fee that could not
    be delivered, a called-off event, a failed bill): every naira comes back
    and WAWU bears the charge of the refund transfer (lead ruling 17 Oct 2026).
  - The provider's charge on either move is WAWU's, paid from its 15% (R-31):
    the person receives the whole figure. It is recorded on the hold
    (`providerFeeKobo`) and on the merchant-side ledger row.
  - **Once, one way.** The first request sets `action` in one conditional
    update; the same request again is the same hold (it answers where the
    move stands); the other request is a `HoldRequestError`
    (`other_action_chosen`), before and after settling. A payment with no
    hold is `no_such_hold`. The database holds the same rules (the migration's
    CHECKs and trigger): an action never changes once set, a settled hold
    never changes, a refund returns exactly the price, a release only follows
    a release. The hold id is the movement's Idempotency-Key: the provider
    sees our reference, `wawu-rel-<hold id>` or `wawu-ref-<hold id>` (45
    characters, inside Nuvion's 64), unique in our table and refused as a
    repeat by the provider.
  - Answers are `HoldSettlement { state: settled | pending | waiting |
    review, waiting, status }`; `status` stays `held` until the provider
    **confirmed** the move (its answer, or its record of our reference).
  - **A hold for a kind that is not held** (TIER-03 round 2): a tier payment is
    WAWU's own sale and completes into no hold. When its plan cannot be
    granted after the payment confirmed, `PlanPurchaseService` writes a
    `WalletHold` for it (`releaseCondition: plan_granted`, no payee, the
    payment's price and shares) and asks for the **refund** at once; nothing
    ever releases it. The same once, one way, the same sweep, the same
    reference `wawu-ref-<hold id>`. docs/contract/PLANS.md section 8.
- **The provider's record is the truth** (the same rules as section 14).
  A move whose outcome is unknown (a timeout, a 5xx, a transfer accepted and
  not finished, a repeated reference) is `pending`: `sentAt` is set, the
  provider is asked about our reference (`reconcileSend` on WAWU's own
  account; backing off 1, 2, 4 ... 60 minutes), the move is never sent again
  and never read as "nothing moved". Past `PAYMENT_REVIEW_AFTER_HOURS` (72)
  with no answer it goes to review (`reviewSince`): out of the sweep, the
  money where it is, a person decides. Only the provider's own record that
  the move **failed** starts a new try, under a new reference
  (`wawu-rel-<id>-2`); a record that it was completed and then **reversed**,
  or that another amount moved, is review. A lookup that carries no charge
  (Fintava's) leaves the schedule's charge on the merchant-side row; a record
  that carries it (Nuvion's `applicable_fee`) is used.
- **Waiting is not failing** (`waiting` on the hold): the hold stays `held`
  and the money stays in WAWU's account.
  - `payee_wallet`, `payer_wallet`: the person has no wallet yet (R-11: the
    creator keeps earning). Looked at again after a rest that doubles with the
    hold's age, a minute to an hour (`walletWaitRestMs`: looks at 1, 2, 4, 8
    ... minutes of age, then hourly), so a creator who never opens a wallet
    costs one look an hour; the first sweep after the person HAS a wallet
    wakes the hold whatever its rest, so the money still lands within a
    minute of the wallet opening. No review bound. (MONEY-18 round 2, F4.)
  - `recipient_frozen`: the provider refuses a move into a frozen wallet
    (G-10). Paid on unfreeze, tried hourly. No review bound.
  - `funds`: the provider says WAWU's own account cannot cover the move
    (amount plus its charge): an error in the log on every try, retried.
  - `provider`: the provider is out of reach or not set up, or it is another
    provider's hold (written before a switch of `WALLET_PROVIDER`; this
    server sends nothing for it). **A request that provably never reached the
    provider** (the connection was refused, the host name did not resolve, no
    route, WHILE the connection was being made: `WalletProviderError.requestNotSent`,
    set by the Fintava and Nuvion clients from the socket's own error code AND
    the syscall that raised it: `connect` for a refusal or an unreachable
    route, `getaddrinfo` for a name, undici's own connect timeout; the same
    codes on an established connection, `read ECONNREFUSED` after the provider
    read the request, are not it, MONEY-18 round 3, R2-1) is this, not an unknown
    outcome: the lease is given back and the minute sweep sends it again under
    the SAME reference (MONEY-18 round 2, O1). Every other loss (a timeout,
    a dropped line, a reset, a 5xx, a TLS failure) may have reached the
    provider and stays `pending`: asked about, never sent again. Payments
    (section 14) read the flag nowhere: they keep treating a lost write as an
    unknown outcome.
  - `refused`: the provider refused and nothing moved; retried under the same
    reference, and a person looks past the review bound (`PAYMENT_REVIEW_AFTER_HOURS`,
    counted from when the release or refund was asked for): the first refusal
    at or after it sends the hold to review. A frozen wallet, a missing wallet
    and an unreachable provider have no such bound.
  Nothing is refunded because a release is stuck, or the other way round.
- **Limits.** A move above the cap on one move through WAWU's account
  (`MERCHANT_MAX_PER_TXN_KOBO`, Fintava) is refused, never split: review. The
  move into WAWU's own account is never made, however the provider names it.
- **The ledger.** On confirmation both sides are written under our reference,
  category `earning` (a release) or `refund`, linked to the item: WAWU's
  account `out` (with the provider's charge) and the person's wallet `in`
  (the payee's row names the payer; a refund's names WAWU; no account number
  of the other side). Best effort, like every ledger write after the money
  moved; the signed delivery and the status check write them too.
- **For the nightly check (MONEY-16):** `WalletHoldService.openTotals()` is
  the count and the sum, in kobo, of the holds still `held` for the running
  provider (a move whose confirmation is awaited is still held). It is
  compared with the provider's own balance, never shown as one.
- **Account deletion** keeps a hold when its payer goes (the payer's id and
  the account a refund went to are cleared, `ANONYMISED`); a payee's goes
  `COUNTERPARTY`. A refund with nobody to return to is review.

- **The sweep** (`WalletHoldService.sweep`, every minute) walks every due
  hold by a keyset cursor (action time, then id) with no cap on the rows it
  looks at, stopping only at the end or when its time (`HOLD_SWEEP_BUDGET_MS`,
  45 s) is used; the next pass then starts where this one stopped, and a pass
  that reads to the end starts from the front again. A hold in front, however
  many and however long they stay due, cannot keep it from the ones behind
  (MONEY-18 round 2, F4; the shape of NUV-02 round 4's N15).
- **A settled hold names its action** (MONEY-18 round 2, F3): the database's
  `WalletHold_outcome_check` states that a `released` hold has the action
  `release` and no refund amount, and a `refunded` hold the action `refund`
  and a refunded amount equal to the price, so a NULL is a refusal and not a
  pass (migration `20261020190000_wallet_hold_outcome_check`).

### The provider's charge on a purchase must be believable (N2)

(MONEY-17's finding N2, carried into MONEY-18.) A payment's charge **below 0**,
or **above the quoted one by more than** `PAYMENT_CHARGE_REVIEW_ABOVE_KOBO`
(PROVISIONAL, default 100000 kobo, 0 to 100000000) is not trusted on any path
that completes a payment (the answer to the send, the sweep's lookup, a ledger
row settled by another job, a signed report): the payment is not completed or
delivered at it. A `pending` payment goes to review with both figures on
`discrepancy` (`charge not trusted: <provider> reported <total> kobo (fee <fee>),
quoted <total> kobo (fee <fee>); held for review`), `chargeReviewSince` and
`reviewSince` set, out of the sweep, the item still claimed; the buyer is told
it is being confirmed. The buyer's ledger row gets the same words and stays as
it is. No figure the provider reported is written to the payment or the ledger.
**Sticky:** no later path completes or corrects it; a person clears it. A
payment already completed and delivered at the quote is only marked
(`chargeReviewSince`, the words on `discrepancy`). A charge exactly at the cap
above the quote is believed (completed, flagged `debitReviewSince`, as before).

**Airtight against a concurrent path** (MONEY-18 round 2, F1 and O3):
- A signed report of a charge that is not believed is judged (by the same
  `completedFigures`) and the payment marked **inside the ledger's own
  transaction** that stores the report
  (`LedgerService.onPaymentDebitSightedInTransaction`), so there is no instant
  at which the ledger has the report and the payment does not. The listener
  that runs after the commit (`onPaymentDebitSighted`, not awaited) only
  completes a payment at figures that ARE believed.
- Completing a payment (`complete()`) is conditional on `chargeReviewSince`
  being null, in the same update that checks it is `pending`, so a path that
  read the payment a moment ago and judged it "as quoted" (the sweep's lookup
  carries no charge) cannot complete it once the mark is there. The mark and
  the completion meet on one row; whichever is second sees the other.
- Delivery is a claim, not a read (`fulfil`; MONEY-18 round 3, R2-2): one
  conditional update on the payment as it stands in the database (completed,
  not delivered, no review, no charge review), taken last, with nothing awaited
  between it and the call to the feature. A payment in charge review (or any
  review) is not delivered, however it was read before, and the sweeps do not
  offer it. The claim also leases the delivery (`nextDeliveryAt`), so a slow
  feature is not told twice at once, **even by two servers** (MONEY-18 round 4,
  R3-1): the claim compares `nextDeliveryAt` with the value its caller read
  (`null` matches an unleased row), so of two servers that read the same due
  payment exactly one update matches and the other tells nobody. A server that
  dies holding the lease leaves it in the row; the delivery then happens once,
  after the rest has passed (1 to 60 minutes). A feature that is merely slower
  than its lease may be offered the payment again when the rest passes, which
  is the at-least-once above: `onCompleted` must still be idempotent. A
  report that arrives after a payment completed but before its delivery stops
  that delivery (the item stays claimed, the payment is out of
  the delivery sweep, the hold, if any, stays); a delivery already made is not
  taken back, the payment is only marked. A person clears the review by
  clearing `chargeReviewSince` and `reviewSince`; the next sweep delivers.
- What the system has not yet been told is not a report: a delivery stored by
  the webhook route and not yet applied to the ledger (up to 30 seconds) is
  the late report above.

### D8-1 (MONEY-17 round 8)

When another job completes a payment between a path's figures update and its
`complete()`, the path's note (both figures) is still written, once, to the
completed payment (`keepNote`, a conditional update that only touches a
completed payment).

## 19. Send to a WAWU user (WALLET-07)

`POST /money/transfers/wawu` and `GET /money/transfers/{id}`
(`src/money/transfers/`), served; sending to a bank account is section 24
(WALLET-09). Finding the person is WALLET-08.

- **The request.** Headers `Idempotency-Key` (required, section 4) and
  `X-Transaction-Pin` or `X-Device-Approval` (section 5). Body
  `WawuTransferDto`: `recipientWawuUserId`, `amountKobo` (what they get),
  `expectedTotalKobo` and `quoteToken` (both from `GET /money/fees/quote?
  kind=wawu_transfer`, BACKEND_GAPS G-64), and an optional `note` (trimmed,
  at most 100 characters, no NUL). Answers `201` with `TransferView`.
- **What moves.** One wallet-to-wallet transfer of `amountKobo` from the
  sender's wallet to the receiver's, at the provider the server runs (Fintava,
  or Nuvion's book transfer), under OUR reference `wawu-send-<id>` (also
  `TransferView.reference`). The sender's balance falls by the quoted
  `totalKobo` (the amount, the provider's charge and WAWU's fee, R-10); the
  receiver's rises by exactly `amountKobo`. WAWU's fee is collected by the
  provider in the same transfer (Fintava's dashboard "Merchant charges",
  `docs/fintava/fees.md`), so there is no second transfer and no second
  provider charge. What the provider's own record says it took is the record:
  a charge other than the quote is kept on the send (`TransferView.fee` and
  `totalKobo` say what really left, the provider's part first and WAWU's what
  is left), a believable excess is flagged for NUV-08, and a charge below 0 or
  above the quote by more than `PAYMENT_CHARGE_REVIEW_ABOVE_KOBO` is not
  believed: the send stays `pending`, in review, and nothing the provider
  reported is written.
- **Who it may go to, answered before the PIN.** Guards run in this order:
  the wallet gate, the key (a repeat of a finished send is answered here and
  is never re-judged), the recipient, then the PIN. A refusal at the
  recipient uses no PIN try and gives the key back.

  | Recipient | Answer |
  |---|---|
  | yourself | `400 self_transfer` "You can't send money to yourself." |
  | nobody the Hub knows | `404 recipient_not_found` "We could not find that person." |
  | an account whose deletion is scheduled | `404 recipient_not_found` "This account is closed." |
  | a block between you, in either direction | `403 recipient_blocked` "You can't send money to this person." (never says who blocked whom) |
  | no open wallet at the provider this server runs | `409 recipient_has_no_wallet` |

  A value that is not a user id is the plain validation `400`, after the PIN
  like every malformed field. No answer of either route carries a phone
  number: the recipient is `MoneyPartyView` (id, name, handle, avatar, tick).
- **Before money moves**, in order: `fees_not_set`, the wallet, the key, the
  recipient, the PIN, the body, the quote (`409 quote_changed` with
  `reason.feeQuote`), the provider's available balance (`402
  insufficient_funds` with `balanceKobo`, `totalKobo` and `shortfallKobo`,
  CONVENTIONS section 14a; BACKEND_GAPS G-481; nothing claimed, the key given
  back), WAWU's limits inside the claim (`403 limit_reached`).
- **Once per key.** The send, the sender's pending ledger row and the key's
  link to it are written in one transaction BEFORE the provider hears of it.
  A retry, two taps at once on one Hub or on two, and a Hub that dies between
  the provider's answer and our write all end in one transfer: the provider
  is asked about the send by our reference and is never sent it twice.
- **`status`.** `completed`; `failed` (the provider refused it or its own
  record says it failed: nothing left the wallet); `reversed` (the provider
  moved it and reversed it); `pending`. A `pending` send is one whose
  outcome is not known: the answer was lost, or the provider accepted it
  and has not finished. It carries `statusMessage` "We're still confirming
  this send. Don't send it again; we'll let you know."; nothing says no money
  moved (absence at the provider is never proof, lead ruling D1). The app
  polls `GET /money/transfers/{id}`; the sweep (every minute, backing off to
  hourly) asks the provider by reference and settles it; past
  `PAYMENT_REVIEW_AFTER_HOURS` it goes to review, still `pending`. The one
  exception to "never sent again": a request that PROVABLY never reached the
  provider (a refused connection, a host name that did not resolve, decided
  by error code and syscall) fails the send, answers `503
  provider_unreachable` and gives the key back, so the same key sends it
  again as a NEW send under a new reference.
- **Ledger.** The sender's `out` row (`category: transfer`, counterparty the
  receiver, the fee split and the note) is pending from the claim; the
  receiver's `in` row is written only once the send is confirmed, so nobody
  sees money coming in that has not arrived. `TransferView.transactionId` is
  the sender's row (`TransactionView.id`), what the receipt routes are keyed
  by (BACKEND_GAPS G-66).
- **`GET /money/transfers/{id}`** reads our record only (never the provider),
  `Cache-Control: no-store`, behind the wallet gate, not behind the fee
  settings, the key or the PIN. Only the sender reads it: another person's
  send and an id nobody holds are the same `404 not_found`.
- **Providers.** Under Fintava the send works as above. Under Nuvion it is a
  book transfer (NUV-05); until that area is served the adapter answers
  `not_supported`, and the send answers `503 provider_unreachable`, fails,
  and gives the key back before any money moves.
- **Deleting an account** keeps the send for the other person: each side's
  user id, account number and name are set to null when that person is
  purged, and the sender's note goes with the sender.

## 20. Points to cash (POINTS-04)

A person turns points into naira in their wallet at the config's rate
(`plans.config.json`, `cash_out`: kobo for 1,000 points, and the fewest points
one conversion takes; TIER-01, R-43). The cash is WAWU's own money moving
from its account at the wallet provider into the person's wallet: Fintava's
merchant wallet or Nuvion's operational account, whichever `WALLET_PROVIDER`
runs, through the seam only (MONEY-20). The provider's charge on the move is
WAWU's (R-31); the person pays nothing to convert.

- **Routes** (`src/points/convert/`, `PointsConvertModule`; `points/convert` is
  a path nothing else declares):
  - `GET /points/convert/quote?points=` (wallet gate, `fees_not_set` first,
    `no-store`): `balancePoints`, `minimumPoints`, `maximumPoints` (from the
    provider's cap on one move, or null), `rate` (`points: 1000`, `kobo`),
    `points` (the ones asked about, else all the cashable points), `cashKobo`,
    `feeKobo` 0, `wawuPaysProviderCharge` true, `canConvert` and `blockedBy`
    (`below_minimum`, `insufficient_points`, `above_maximum` or `not_cashable`).
    `balancePoints` counts every point the person has; `cashablePoints` is
    their earned and bonus points that have not ended. Points a person bought
    never expire and can never be turned into cash (R-101 point 7,
    POINTS-BOUGHT): they are in the balance and never in `cashablePoints`;
    asking for more than `cashablePoints` is `blockedBy: not_cashable`. It answers
    the figures instead of refusing, so PT6 can draw "below the minimum".
    A dollar-billed person is `409 currency_not_supported`.
  - `POST /points/convert` `{ points }` with `Idempotency-Key` and
    `X-Transaction-Pin` (or a device approval): answers `201` with the
    conversion `{ id, status, currency, points, cashKobo, reference,
    statusMessage, failureReason, createdAt, completedAt }`.
  - `GET /points/convert/{id}`: the same view for its owner (anybody else, and
    an id nobody holds, are the same `404 not_found`), from our records only.
- **Status** is `completed` (the provider confirmed the cash; the points are
  spent), `pending` (the points are on hold and the cash is not confirmed yet:
  poll the id; the move is never sent again) or `failed` (the cash did not
  move and the points are back; `failureReason` says so in words). A `pending`
  answer is stored for replays like any other: the app polls the id.
- **Cash** = `floor(points x kobo per 1,000 points / 1,000)`: rounded down, so
  nobody is paid more than the rate says. A conversion worth no kobo is
  refused (`400 amount_out_of_range`). The migration holds the same sum as a
  CHECK, with the rate the row was worked out at stored on it.
- **Before the PIN, changing nothing** (a guard between the Idempotency-Key and
  the PIN; `RequireIdempotentApproval(route, ...guards)`): no wallet is the
  wallet gate's `409 wallet_not_open` (it runs first, takes no key); then a
  dollar-billed person `409 currency_not_supported`, fewer points than the
  minimum `422 below_minimum` (`minimumPoints`, `balancePoints`), more cash
  than one move may carry `400 amount_out_of_range` (`maximumKobo`), more
  points than the person has `402 insufficient_points` (`balancePoints`,
  `neededPoints`, `shortfallPoints`), more than their earned and bonus points
  `422 points_not_cashable` (`balancePoints`, `cashablePoints`,
  `neededPoints`). None uses a PIN try, holds a point or
  keeps the Idempotency-Key. A repeat of a finished request is answered
  before any of them, so a balance that has since changed never turns a replay
  into a refusal. `points` that is not a whole number of 1 or more is the
  validation pipe's plain `400`, also before the PIN.
- **The order of the steps.** (1) The conversion row, the key's link to it and
  the points hold are written in ONE transaction (the hold last, so the
  person's points lock is taken after everything else and let go at once):
  there is no row without held points and no held points without a row. The
  points leave their lots soonest-ending first (POINTS-01). (2) The provider is
  asked to move the cash, outside every transaction: nothing waits on a
  provider while it holds a person's points lock. (3) Only when the provider
  has CONFIRMED the move, one transaction marks the conversion `paid` and
  commits the hold; when its own record, or a refusal that proves nothing
  moved, says the cash did not move, one transaction marks it `cancelled` and
  releases the hold, back to the lots it came from with their own end dates
  (a lot that ended meanwhile loses them, as POINTS-01 says). At commit the
  database requires the conversion and its hold to agree (a deferred trigger).
- **Once.** The Idempotency-Key links to one conversion; the conversion has
  one reference at the provider, `wawu-pts-<id>` (45 characters, inside
  Nuvion's 64; unique in our table, refused as a repeat by the provider); the
  move is handed over by a lease (`sentAt`) only one caller wins, whichever
  Hub process or sweep it is. A new reference exists only for a NEW
  conversion: one the provider did not make is cancelled, and asking again is
  a new request with a new key.
- **The provider's record is the truth** (the rules of sections 14 and 18).
  A move whose outcome is unknown (a timeout, a 5xx, a transfer accepted and
  not finished, a repeated reference, a Hub killed between the provider's
  answer and our write) is `pending`: `sentAt` is set, the provider is asked
  about our reference (`reconcileSend` on WAWU's own account; backing off 1,
  2, 4 ... 60 minutes), the move is never sent again and never read as
  "nothing moved", and the points stay HELD. Nothing times a `cash_out` hold
  out. Past `PAYMENT_REVIEW_AFTER_HOURS` (72) with no answer it goes to review
  (`reviewSince`): out of the sweep, still held, a person decides. A record
  that it was completed and then reversed, another amount than asked, or
  cash confirmed for points already given back, is review too. Only a
  refusal that proves nothing moved (`recordMayExist` false or
  `requestNotSent`: WAWU's account short, a frozen wallet, the provider's
  limits, a body it refused) or the provider's own record that the move
  failed gives the points back.
- **A sweep** every minute (`points-cash-out-settle`) drives every held
  conversion that is due, of the provider this server runs, by a keyset cursor
  with a time budget (the hold sweep's shape): it sends what a request that
  died after the hold never sent, and asks about every move whose answer was
  lost. A conversion of the other provider is left alone.
- **Ledger.** Both sides of the move, under our reference: WAWU's account (out,
  the provider's charge on top, `wawuFeeKobo` 0) and the person's wallet (in),
  category `earning`, counterparty "Who Made This", link kind
  `points_cash_out` (a `PAYMENT_KINDS` value that no feature registers, so a
  payment for it is `target_not_payable`), link title the points. History
  reads "Points to cash". The provider's balance is still the only balance.
- **Deleting an account.** The row is `ANONYMISED` (the person and the wallet
  account it paid into are set to null); its hold goes with the person's
  points. A conversion not yet sent is then cancelled by the sweep; one the
  provider already moved is paid with no person on it.
- **For MONEY-16 / NUV-08:** `PointsCashOutService.inFlightTotals()` counts and
  sums (kobo) the conversions still held of the running provider: cash that
  may already have left WAWU's account without our record knowing yet.

## 21. Provider webhook deliveries are not kept for ever (FIX-20)

(Numbered 21 because MONEY-16 and WALLET-16 both add a section 19 on their
branches; the lead renumbers at merge.)

`FintavaWebhookEvent` and `NuvionWebhookEvent` keep each signed delivery's raw
body and a parsed copy of it: names, account numbers, narrations. Neither table
has a person column, so **retention, not the account purge or the data export,
covers these rows**. The purge map (`src/account-purge/account-data-map.ts`)
and the export list (`src/data-export-request/data-export-sections.ts`) say so
in their comments and name neither table; a person's own money history is the
ledger, which the purge and the export do cover.

**The rule.** A daily job (`src/webhook-retention/`, 02:40 server time) clears
the raw body (`rawBody` becomes empty) and the parsed copy (`payload` becomes
JSON null) of a delivery when both are true:

- it was received more than `WEBHOOK_RETENTION_DAYS` ago (default **90**,
  PROVISIONAL, whole days from 7 to 3650, anything else stops the app at boot);
  the period counts from the time received, not the time processed; and
- its state says nothing can still read it.

**Which states are cleared, and which are held.** A held row keeps its body
whatever its age, and the job reports how many such rows are past the period.
The table is `WEBHOOK_STATE_RULES` in
`src/webhook-retention/webhook-retention-config.ts`, typed over each enum, so a
new state does not compile until it is classified.

| State | Fintava | Nuvion | Why |
|---|---|---|---|
| `processed` | cleared | cleared | Every consumer is finished with it. The ledger keeps the references and the figures; each Nuvion handler re-fetches from Nuvion before it acts on money. |
| `test` | no such state | cleared | Nuvion's own test delivery: no data, nothing acts on it. |
| `pending` | held | held | A consumer has not used it yet: the ledger sweep and the Nuvion dispatcher read its payload. It may be resting after a wait, held by a worker, waiting for a consumer that is not built yet (Fintava cards, an event no Nuvion handler lists), or left for a rollback to the other provider. |
| `failed` | held | held | The consumer could not use it. That is a stop for review (a reversal with no debit), and the body is the evidence. A delivery that disagrees with the ledger is `processed`; its evidence is the discrepancy on the ledger row, not the body. |
| `unrecognised` | held | held | Kept for review: an event nobody documents is how a real payload format is learned. |

Nothing marks a review closed, so a held row stays until a person or a
consumer finishes with it (BACKEND_GAPS G-750).

**What stays on a cleared row.** Everything the repeat check and every reader
needs: the id, the event, the references (`reference`, `dataReference`,
`dataCustomerReference`; the ledger's absent check reads them), the SHA-256 of
the body, the outcome (`processingStatus`, `note`), `receivedAt` and
`processedAt`, and `bodyClearedAt`, the time the body went. The database holds
the rule: `*_body_cleared_check` refuses `bodyClearedAt` on a row that still has
a body (and on a Fintava row without its `bodySha256`).

**A delivery sent again after clearing is still a repeat.** The receivers'
inserts are `ON CONFLICT DO NOTHING` on unique keys the job never touches, so
the answer is `200 duplicate`, no row is written, the body is not put back, and
the ledger or the handler is not told again:

- Fintava sends no event id and no timestamp, so its key is `bodySha256`, the
  SHA-256 of the exact bytes it signed. It is the only protection against a
  captured signed body being replayed, which is why a Fintava row without one
  is never cleared.
- Nuvion's keys are `eventId` and the signed pair (`signedAt`, `bodySha256`),
  and the signature check refuses a timestamp more than 20 minutes from our
  clock before the insert is reached.

**Safe to run twice, on two servers, and while a delivery arrives.**

- A batch is one statement: it picks up to 200 rows, locks them
  (`FOR UPDATE SKIP LOCKED`) and clears them together. It is a transaction of
  its own, so no lock outlives it. A run stops starting batches after 10
  minutes and leaves the rest to the next day.
- Two servers running the job at once share the rows between them; a row is
  cleared by one of them. A row a consumer holds is skipped and cleared by the
  next run. A second run finds nothing to clear and writes nothing.
- A new delivery never waits for the job: it is a new row, received after the
  cutoff, and its insert conflicts with nothing. A repeat of a delivery whose
  row is in the batch being cleared right now waits for that one statement
  (Postgres makes an insert that conflicts with a row being updated wait for the
  updater, a few milliseconds for 200 rows) and then answers `duplicate`; a
  repeat of any other row does not wait at all.

**A new reader of these tables.** A reader of `rawBody` or `payload` reads only
rows in a held state, as the ledger sweep and the Nuvion dispatcher do (they
read `pending` rows, locked and re-checked as `pending`). The readers are listed
in `WEBHOOK_TABLE_READERS`, and `webhook-retention-readers.spec.ts` fails when a
file touches either table without being listed there. A reader that needs a
cleared state's body changes `WEBHOOK_STATE_RULES` in its own task, on purpose.

## 22. The nightly check against the provider (MONEY-16)

`src/money/check/`. No route. It reads WAWU's ledger and the provider's own
record and reports any difference the same night. It only reads: it never
changes a ledger row, a hold, a payment or a balance (the provider's balance is
the truth, and what to do about a difference is a person's call). It reaches
the provider only through `WALLET_PROVIDER` and acts only on the rows of the
provider the server runs (their `provider` column).

- **When.** `MONEY_CHECK_TIME` (HH:MM Lagos, default 02:30, PROVISIONAL), from
  that minute until `MONEY_CHECK_CATCH_UP_HOURS` (6) later; a minute cron
  (`money-nightly-check`) starts it where `ScheduleModule.forRoot()` is loaded.
  By hand: `npm run money:check` (after `npm run build`, with the Hub's
  environment; `-- --night=YYYY-MM-DD`, `-- --again` for one more run of a
  night that finished). It prints one line and exits 0 (finished or already
  finished) or 2.
- **One run a night, on any number of Hub processes.** The run is claimed by
  inserting its `MoneyCheckRun` row (unique per provider, Lagos date and
  sequence). A run is kept with a lease that its worker extends per wallet; a
  process that finds a `running` row past its lease takes it over and makes the
  run again (`attempt` + 1), at most three times a night. A night that cannot be
  made ends `finished` with the verdict `incomplete` and the reason, and is
  reported like any other: a night is never left as nothing, which would read as
  clean. A run another process took while this one worked is dropped, and says
  nothing. A run whose last try died is closed the same way by the next minute
  tick at any hour, not only inside the catch-up window: a `running` row whose
  lease ran out, or a `failed` row whose rest is over, on any night but the one
  being made now (a `failed` row of a run made by hand is left to the person who
  saw it fail).
- **Why a night failed: a code and one fixed sentence.** The stored `failure`
  (`code: sentence`, for example `provider_unavailable: The wallet provider
  failed while the check was reading from it.`) and the note in the emailed
  report carry the code and the sentence only, never an exception's own text,
  which could hold a value from a library, the database or the provider. The
  Hub's log names the error class.
- **What it compares.**
  1. `movements`: each wallet's debits (`listTransactions`, newest first, 100 a
     page) with the ledger's `out` rows, inside the window (back past the last
     finished run by `MONEY_CHECK_OVERLAP_HOURS`, never further than
     `MONEY_CHECK_MAX_LOOKBACK_DAYS`). A debit only the provider has (completed)
     and a completed or pending send only the ledger has are mismatches; so are
     a different amount, two provider records for one ledger row, and statuses
     that cannot both be true (a send the ledger calls `failed` or `reversed`
     while the provider lists it completed, a completed one the provider lists as
     failed, a settled disagreement over pending). A provider record that is only `PENDING` or
     `FAILURE` with no ledger row moved no money (a notice), as are the
     provider's own charges to WAWU (`kind` `charge`). Movements younger than
     `MONEY_CHECK_SETTLE_MINUTES` are left to the next night.
  2. `merchant_movements`: the same for WAWU's own account.
  3. `balances`: each wallet's AVAILABLE balance (the figure the app shows)
     against completed money in less completed money out, widened by the pending
     rows and by a failed bank send nobody has seen come back. The booked figure
     never rescues a wallet whose available figure is outside that range: a
     pending item nobody recorded is the difference this check exists to find. A
     booked figure that is not the available one is a notice
     (`balance_booked_differs`). Read with the ledger standing still and
     confirmed once; a wallet that kept moving is not compared.
  4. `held_money` (R-19): the provider's available balance of WAWU's account
     against what the open holds need (their price, less a move already handed
     to the provider). It cannot be one equality: the account also holds WAWU's
     shares and fees (BACKEND_GAPS G-447). Also a completed payment of a held
     kind with no hold, and a settled hold whose merchant-side row is missing,
     pending or marked.
  5. `merchant_charges` (R-10, OPS-09): for each completed send whose ledger row
     carries a WAWU fee, the provider's full record (`findTransactionById`,
     Fintava's `merchantComm`) shows that charge paid to WAWU.
  6. `ledger_rows`: rows the ledger marked as disagreeing (`discrepancy`), rows
     pending past the confirm window, failed bank sends with no reversal, each
     completed payment's two rows (a missing, pending or marked one is a
     mismatch), and ledger rows inside the window on a wallet account that has no
     wallet row (a deleted account's last rows, which no balance or history
     comparison reaches): a look, with the references and a count.
  7. `payments` and 8. `holds`: what a person has to look at. A payment in
     review (silence from the provider never ends a payment, G-480), one whose
     charge was not believed, one debited above the quote, one paid twice; a
     hold in review, a move handed over and unconfirmed past the review bound, a
     move waiting past it for a reason other than a person's wallet, money owed
     to a deleted payee (G-461), and a refund waiting for a payer's wallet (the
     payer paid from a wallet, so a missing one is not a normal wait): a look
     every night until a person settles it. A payee who has not opened a wallet
     is not a problem (R-11): a notice.
- **Verdicts.** `differences` (any mismatch); `not_checked` (nothing could be
  compared with the provider: not set up here, or its adapter answers
  `not_supported` to all of it); `incomplete` (something could not be compared:
  a wallet the provider would not answer for, a history longer than the pages
  read, a check the adapter cannot do yet, a run that did not finish);
  `needs_a_look`; `clean` only when every comparison was made and nothing was
  found. The report says how many wallets were checked and why the others were
  not.
- **Telling someone.** Through WAWU ID, as the data-export link and the PIN
  reset code go: `POST /internal/users/:userId/money-check-report` with the
  `X-Service-Key`, once per WAWU id in `MONEY_CHECK_RECIPIENT_WAWU_IDS`. The Hub
  names the person and gives the facts (the verdict, the counts, each check's
  state, and up to 100 findings as check, kind, reference, a sentence and kobo);
  WAWU ID owns the address and the wording (BACKEND_GAPS G-690; built in wawu-id
  on `wmt/MONEY-16`). The route mails the account's own VERIFIED address only
  and answers `200 { data: { emailed: true } }` after the mail was handed to its
  mailer; `400` for a body it will not take (any field it does not name, a
  sentence with a character outside letters, digits, spaces and `. , : ; ' " ( )
  _ -`, a reference that is only 10 or 11 digits, a value outside a closed
  list), `404` no such account, `409` no verified address, `503` the mailer
  could not take it. Anything but `emailed: true` leaves the report unsent and
  tried again. The Hub sends only what that route takes: a sentence is cut to
  those characters and a reference of a phone's length is given a word in front
  of it, so a stray character cannot cost a night's report; the stored report
  keeps the text as the check wrote it. A clean night is mailed too, so silence never means clean. A report
  WAWU ID would not take is kept and handed on again with a growing rest
  (5 minutes doubling to 6 hours, for a week); a recipient already mailed is not
  mailed twice. With no recipient set the run is still made, and the result is in
  the log (an error line per night that is not clean) and in the table.
- **Opened during the run.** A wallet opened while the run was going is not in
  the list read at its start, so "N of N" does not count it and nothing compared
  it; the report names it (notice `wallets_opened_during_run`) and tomorrow's run
  reads it.
- **Never in a report or an email:** a name, a phone number or an account
  number. A reference is a ledger row id, a payment id, a hold id, our own
  reference at the provider or the provider's wallet id. Amounts are kobo as
  decimal text.
- **Rows.** `MoneyCheckRun.report` holds the first 500 mismatches and the first 500 looks
  and counts the rest; finished runs are kept `MONEY_CHECK_KEEP_DAYS` (120).

## 23. Publishing needs a tier (TIER-02)

Publishing a piece, or taking a file for one, answers `402` in this one error
shape when the person has no way to publish or has used every product they
may have:

| `reason.code` | HTTP | When | Extra fields |
|---|---|---|---|
| `pack_not_allowed` | 409 | PACK-CAP (R-100): `GET /plans/purchases/quote?kind=extra_products` and `POST /plans/purchases` (kind `extra_products`) refuse the extra-products pack: the running tier may not buy it (admin setting `plan.extra_products.tiers`, Founding Maker by default) or the profile already holds the most packs (`plan.extra_products.max_packs`, 2 by default). Nothing moves. A store purchase of the pack that arrives against the rule is not refused: it is recorded with `flag: pack_not_allowed` and grants nothing | none |
| `tier_required` | 402 | no running tier and no verification tick that has not ended | `tierState` (`none` or `ended`), `productsUsed`, `productsAllowed`, `currency`, `tiers`, `extraProducts` |
| `product_limit_reached` | 402 | every product the person may have is published | the same fields |
| `identity_paused` | 403 | the person's identity check is paused: waiting for documents, refused, stopped, or closed unfinished (S7 round 2). A check that passed, one under way, and one never started are not refused. Asked after the tier, before the room | `stage` (`needs_documents`, `rejected`, `stopped` or `expired`); `message` is the Hub's own sentence, no offers |
| `draft_limit_reached` | 409 | a person already keeps `PRODUCT_DRAFTS_MAX` drafts (`POST /product-drafts`) | `draftsKept`, `draftsAllowed` |
| `draft_incomplete` | 400 | a draft being published still lacks details | `missing` |

The offers inside `reason` are `GET /plans`' figures in the person's billing
currency only (`priceMinor` in the minor unit of `currency`). The rules, the
routes that ask and the drafts are in [`PLANS.md`](PLANS.md) section 6.

`tier_required` is also a money error code (TIER-04): `GET
/plans/purchases/quote` and `POST /plans/purchases` answer `402 tier_required`
in the money error shape (`reason.code` and `reason.message` only) when the
person asks to add more products without a tier that is running. The status is
the same 402, so one handler covers both. Nothing is taken, and a bank-transfer
purchase waiting for its money when the tier ends is closed with nothing taken
([`PLANS.md`](PLANS.md) section 11).

## 24. Send to a bank account (WALLET-09)

`GET /money/banks`, `POST /money/banks/name-check` and `POST
/money/transfers/bank` (`src/money/transfers/`, `src/money/saved-accounts/`),
served. A withdrawal (W17) is a bank send to the payout account; it has no
route of its own. Reading one send, of either kind, is `GET
/money/transfers/{id}` (section 19).

- **The bank list and the name check** read no wallet and move no money. `GET
  /money/banks` is the provider's list in one unpaged array (`code`, `name`;
  key on `code`), kept in memory for an hour. `POST /money/banks/name-check`
  answers `AccountNameView` with the holder's name AS THE BANK GIVES IT, or
  `422 name_check_failed` with the sentence that says why (CONVENTIONS
  section 10), or `503 provider_unreachable`. W8's Continue unlocks only after
  it answers. The answer carries `nameToken`, signed for this person and good
  for 15 minutes: the send to an account that is not saved sends it back.
- **Name checks are limited per person** (WALLET-37, R-51, G-764): at most
  `name_check_per_hour` (launch value 30) an hour for one signed-in person,
  in one count shared by `POST /money/banks/name-check`, `PUT
  /money/payout-account` and `POST /money/beneficiaries` for a bank account;
  the 31st is `429 name_check_rate_limited` with the minutes left, no check
  made. It is per person, never per address: two people on one address each
  have their own count. A check the bank could not answer (`503`) is not
  counted. A bank send's own check just before the money goes is not
  counted when it is the person's own: a send to a saved account, or to an
  account that is not saved with a `nameToken` this person got for that bank
  code and account number (not older than 15 minutes). Any other send to an
  account that is not saved is a name check (round 5, G-764): it spends one of
  the 30, and past them it is `429 name_check_rate_limited` before the PIN,
  the key given back, the bank not asked, no holder name in the answer.
- **A withdrawal goes only to the person's own name** (WALLET-37, R-51,
  G-765). A withdrawal is a bank send to the saved payout account. The bank
  is asked as for any send; when the holder it gives is not the person's
  verified name (the BVN name kept by the check, else the wallet's own
  account name; with neither, nothing vouches for the account) the answer is
  `409 account_not_in_your_name` before the PIN, the key given back, nothing
  sent. A holder that differs from the one kept
  is `409 account_name_changed` first, as above. Sends to other accounts (W8)
  are unchanged.
- **The request.** Headers `Idempotency-Key` (required, section 4) and
  `X-Transaction-Pin` or `X-Device-Approval` (section 5). Body
  `BankTransferDto`: `bankCode`, `accountNumber` (ten digits), `amountKobo`
  (what the account gets), `expectedTotalKobo` and `quoteToken` (both from
  `GET /money/fees/quote?kind=bank_transfer`, BACKEND_GAPS G-64), an
  optional `note` (trimmed, at most 100 characters) and, for an account that
  is not saved, the `nameToken` of the name check the person saw (required
  for such an account: without it the answer is `400`, FIX-41). The app
  never sends a name: the server asks the bank again, just before the send, and sends to
  the name it gets. Answers `201` with `TransferView` (`kind: bank_account`,
  `toBankAccount`: the bank's code and name, the account number and the
  holder's name as the bank gave it, `timeline`: `requested`, `sent_to_bank`
  once the provider has taken it, then `completed`; a send that `failed` or
  was `reversed` shows `requested` and that outcome only).
- **What it costs.** The amount, the provider's charge for a bank send and
  WAWU's fee on top (R-10, from the fee settings; with Fintava's dashboard
  rates, ₦40 + ₦25 = ₦65, so a ₦25,000 send debits ₦25,065). The provider
  collects both in the one transfer; what its own record says it took is the
  record, as for a send to a WAWU user (section 19). A send has no receiver's
  ledger row: the money is at another bank.
- **Before money moves**, in order: `fees_not_set`, the wallet, the key, the
  ACCOUNT (below), the PIN, the body, the quote (`409 quote_changed`), the
  provider's available balance (`402 insufficient_funds` with `balanceKobo`,
  `totalKobo`, `shortfallKobo`), WAWU's limits and the provider's daily limit
  inside the claim (`403 limit_reached`, WALLET-23's check, section 3). A
  refusal at any step before the PIN uses no PIN try and gives the key back.
- **The account, answered before the PIN.** A `bankCode` or `accountNumber`
  that is not a bank code or ten digits (missing, the wrong type, or the
  wrong shape) is the route's `400` with the validation sentence for that
  field, before the bank is asked. Your own wallet at the provider's own
  bank is `400 self_transfer`. The bank is asked; an account it does not
  confirm is `422 name_check_failed`. A SAVED account (one of your
  beneficiaries, or your payout account) goes through the saved-account gate
  (NUV-06): the bank code the provider knows the bank by, and the payee ids
  kept after the first send. The kept holder name, and the kept bank name
  against the provider's name for the code, are compared with the answer of
  the bank just now; any difference is `409 account_name_changed`, with
  `reason.accountName` and `reason.bankName` as they stand now, and NOTHING
  is sent. The person is shown both and confirms them by saving the account
  again with `confirmCurrentName: true` (`POST /money/beneficiaries`; a
  payout account is confirmed by `PUT /money/payout-account`, which takes no
  flag: a plain PUT keeps what the bank says now, and refuses it with
  `409 account_not_in_your_name` when the name is not theirs). Saving without the flag
  answers the row as it is, as before. An account that is NOT saved is bound
  to the name the person was shown: with `nameToken` on the send, a holder
  or bank that the bank names differently now, or a token that is not this
  person's, this account's, or is past its 15 minutes, is the same
  `409 account_name_changed` and nothing is sent; the app shows the names
  and runs the name check again. A send to an account that is not saved with
  no token is `400` with one plain sentence, before the PIN: nothing is sent,
  no PIN try is used and the key is given back (FIX-41). A saved account and
  a withdrawal to the payout account need no token.
- **Once per key, written first.** The send, its pending ledger row (with the
  quoted `providerFeeKobo` and `wawuFeeKobo`) and the key's link to it are
  written in one transaction BEFORE the provider hears of the send. The
  provider is called once. A request that provably never left is failed and
  the key given back; an unknown outcome (a lost answer, a 5xx, a transfer
  accepted and not finished, a repeated reference, or any refusal that may
  have created a transfer) is `pending` with the
  same `statusMessage` as section 19, and is found again by OUR reference
  (the sweep asks the provider; under Nuvion the sender's transfers are
  walked, never read as "no money moved"). Nothing sends it a second time.
  A refusal the provider makes before it takes the money (not enough in the
  wallet, a frozen wallet, payouts not available) fails the send at once,
  voids its pending ledger row and gives the key back: `402
  insufficient_funds` with the figures, `423 wallet_frozen`, `503
  provider_unreachable`. The same request again is a new send under a new
  reference.
- **A failed send is reversed once.** A send the provider reports as failed is
  `failed`; the provider's reversal of the debit (`debit_transfer_reversal`)
  then moves it to `reversed`, with `reversal.returnedKobo` and `keptKobo`
  from the provider's own report, once however often it is reported.

## 25. Delete account: money first, 30 days, cancel (SETTINGS-06)

`DELETE /account` (R-17) asks to delete the signed-in account. It waits 30
days; signing in during them cancels it (WAWU ID, SETTINGS-08).

- **Money first (Z6).** Refused with `409`, `reason.code`
  `account_deletion_blocked`, nothing changed, while any of these holds.
  `reason.blockers` lists them; the app leads with `wallet_balance` (the
  Withdraw button) and shows `reason.balanceKobo`, the wallet provider's
  balance, never a sum of our rows. `reason.message` is a sentence to show as
  it is.
  - `wallet_balance`: the wallet holds money (available or booked above 0).
  - `open_hold`: a held payment (paid DM, ticket, bill) where the person is
    the payer or the payee (R-19). `reason.openHolds` counts them.
  - `waiting_earnings`: a completed sale whose 85% has not reached their
    wallet (R-11, `WalletPayment.payeeSettledAt` unset, no open hold), or a
    community host's share of spent credits still owed (WALLET-17).
    `reason.waitingEarnings` counts them. A person with no wallet can have
    these.
  - `payment_in_progress`: a payment of theirs with no final answer.
  - `cash_out_in_flight`: points held for a cash-out.
  - `wallet_opening`: their wallet is being opened right now.
  - `fx_balance`: a foreign-currency account (WALLET-21) holds money, as the
    provider reports it (available or booked above 0). The sentence says to
    swap it to naira and withdraw it, or send it out.
  - `fx_balance_unreadable`: a foreign-currency account could not be read
    (the provider did not answer, holds no such accounts on this server, or is
    not the provider that made the account). It is never taken for empty, and
    it is its own reason, not `503 provider_unreachable`: try again.
  - `fx_operation_pending`: a swap or a send of theirs has no final answer yet.
  - `capital_holding`: a Capital holding (NUV-12) is not closed: it is held,
    matured and not withdrawn, or paying out. Closed is the provider's
    `WITHDRAWN`, `CLOSED` or `REFUNDED`. The sentence says to withdraw it or
    wait for the holding to end.
  - `capital_order_pending`: a Capital order is reserved (a live reservation,
    not an expired one), reserving, confirming, or held for review.
- **`503 provider_unreachable`** when the provider does not answer, never a
  guess that the wallet is empty. A wallet another provider holds (after a
  rollback) answers the same.
- **Otherwise `200 { deletionScheduledAt }`**, 30 days out, and: the Naira
  wallet is frozen at the provider (it can neither send nor receive, so money
  due to it waits in WAWU's account and is paid on unfreeze, as the hold sweep
  does, G-10; a provider with no freeze leaves the wallet as it is), the
  person's content is hidden (`removed`, remembered piece by piece), phone push
  stops, and WAWU ID starts its grace period. Asking again keeps the date.
  The money is looked at before the wallet is frozen, and the deletion is
  recorded before the freeze call, so a freeze whose answer is lost is undone
  by a cancel or a new request. A request that fails after the freeze lets
  the wallet go again before it answers.
- **The wallet follows the row** (round 5, R-1 wallet safety): a deletion in
  force (`freezing`, `scheduled`, `purging`, `purged`) always has a frozen
  wallet, and a cancelled or absent one never does. One function
  (`reconcileWallet`) enforces it: it reads the row and freezes or unfreezes
  to match, idempotently, acts only on a wallet of the provider the server
  runs (the person's current wallet, so one opened during the 30 days is
  frozen too), and never throws. It holds no transaction, no pooled connection
  and no lock while the provider answers (round 6): it reads the row, asks the
  provider, reads the row again, and acts again if the row changed (3 rounds at
  most). Every request that can change the row or the wallet ends with it (a
  repeat cancel and a refused `DELETE` included), and the hourly sweep runs it
  for every row in force whatever its age and for every cancelled row until one
  reconcile was confirmed for it (`AccountDeletion.walletSyncedAt`), so a
  freeze or unfreeze whose answer was lost, or that the provider refused, is
  put right within the hour.
  A repeat `DELETE /account` on a row the purge has finished answers the date
  it was due and schedules nothing.
- **`POST /account/cancel-deletion`** (the person's own token; WAWU ID sends
  the new one when they sign in) unfreezes the wallet, brings back exactly the
  hidden pieces, resumes push and answers `200 { cancelled, walletUnfrozen,
  contentRestored }`. With nothing scheduled it changes nothing and answers
  `cancelled: false`. If the provider does not answer the unfreeze it answers
  `503` having changed nothing, and can be called again (the wallet is frozen
  again if that call was applied and only its answer was lost).
  `walletUnfrozen` is `true` only when the provider confirmed the unfreeze
  after the cancel; if it could not, the cancel stands with `false` and the
  hourly sweep lets the wallet go. Once the purge has
  started it answers `200 { cancelled: false, deletionInProgress: true,
  message }` (data may already be gone, so it is never answered as restored);
  the app shows `message` as it is.
- **After the 30 days** an hourly sweep (`account-deletion-purge`) looks at
  the money once more (a balance, hold or earning that appeared keeps the
  account; `AccountDeletion.purgeBlockedBy` says why), then claims the row
  (`purging`; no cancel from here), releases held points, deletes the Hub's
  data (`AccountPurgeService`, points first), asks WAWU ID to anonymise the
  identity, and marks the row `purged` only when all of that worked. A table
  that would not clear, or WAWU ID not answering, leaves the row `purging`
  (`purgeBlockedBy` says which) and the next pass carries on; WAWU ID is not
  asked before the Hub's side is done.
- **Buyers keep what they paid for, from the DELETE on** (owner ruling, 16 Oct
  2026; lead rulings 17 Oct 2026). A piece with a completed paid purchase is
  hidden from everything public (`removed`) the moment the deletion is
  scheduled, and still opens on `GET /content/:id`, `GET /content/:id/detail`
  and `GET /content/:id/media` for each buyer with a completed purchase and
  for nobody else: the creator, a buyer whose purchase is pending, failed or a
  tip, and a signed-out caller get `404`. A non-buyer also gets `404` on that
  piece's comments (read, post, like), on save and on rate. Every other
  removed piece answers exactly as before. A cancel puts the pieces back as
  they were. At the purge the piece stays whole (title and description as
  bought, with any email address or phone number in them replaced by
  `[removed]`; files, lessons and frames), and loses the creator: its creator
  id becomes `deleted-account`, its slug and tags go. File keys are not
  renamed (they carry the creator's id in the path but are never shown as
  text). Pieces with only a pending, failed or tip purchase are stripped to
  "Removed content" and re-keyed to `deleted-account` too. `AccountDeletion.purgeNote`
  says how many pieces were kept this way.

## 26. Earnings land in the wallet by themselves (WALLET-16)

R-11: a sale's 85% reaches the payee's wallet without anyone tapping anything,
and a creator without a wallet keeps earning: the money waits and is moved the
day they open one. R-55 (owner, 16 Oct 2026): a creator's earnings go to their
wallet ONCE A DAY, in one transfer per creator, and a day's total under N200
waits for the next day (the rules are in the bullets below: "The move",
"One transfer a day" and "A refusal gets a person after 72 hours"). Section 18 does this for a held kind (the hold's
release); this section does it for every other kind with a payee (an unlock, a
tip, a legal fee, school fees). The provider's balance is still the only
balance (MONEY-11): nothing here is added up into one, and the routes say
"earned" and "waiting", never "balance".

- **What an earning is.** The payee's 85% (R-5, rounded down to the kobo, as
  recorded on the payment: `WalletPayment.payeeShareKobo`) of a finished sale.
  An ordinary sale is finished when its payment is `completed`, what was paid
  for is delivered (or has nothing to deliver: `openKey` is given up, section
  14) and neither `reviewSince` nor `chargeReviewSince` is set; a delivery or a
  charge in question waits for a person, and its earning with it. A held kind
  is earned once the owning feature has RELEASED its hold to the payee
  (section 18; earned at once, `waiting` until the provider confirmed the
  move); a hold nobody has decided is `held` (money paid, not earned), a
  refunded one is the payer's. WAWU's own sales (credits, ticks, bills: no payee), a share under a
  kobo, and the web's Flutterwave sales (`GET /content/mine/earnings`, which is
  unchanged) are not earnings here.
- **Routes** (`src/money/earnings/`, `no-store`, from our own records of the
  sales: they never call the provider, so neither answers
  `provider_unreachable`). **Not behind the wallet gate**: a creator with no
  wallet reads them (no `409 wallet_not_open`), because that is the person who
  has to see the money waiting. Any signed-in person reads their own and only
  their own; a person with no sales gets zeros.
  - `GET /money/earnings?month=YYYY-MM` (`EarningsView`): `allTime` and
    `thisMonth` (each `earnedKobo`, `sales` and `streams`, one entry per kind
    sold, largest first; the streams add up to `earnedKobo` exactly), `month`
    (YYYY-MM in Africa/Lagos time, the current month unless asked), `waiting`
    (`count`, `amountKobo`: earned and not in the wallet yet, part of `allTime`),
    `held` (paid for, not earned yet) and `walletOpen` (the caller has a wallet
    of the provider this server runs; false with money waiting is "Open your
    wallet" on W39). Every figure comes from one statement, so they always agree.
  - `GET /money/earnings/content?month=&cursor=&limit=` (`EarningContentPage`):
    that month piece by piece (`kind`, `targetId`, `title` as the piece last
    sold, `earnedKobo`, `sales`, `lastAt`), largest first, then kind, then
    target. Every page together adds up to the month's `thisMonth.earnedKobo`.
    The cursor is `e1.` plus base64url of the month and the last row's figure,
    kind and target; one the server did not write, or one given for another
    month, is a plain `400` ("cursor is not one this list gave.").
  - A month is the Africa/Lagos calendar month of when the sale completed (a
    release's time for a held kind). `month` that is not `YYYY-MM`, or is year
    0000, is a plain `400` ("month must look like 2026-09").
- **The move** (`EarningSettlementService`, exported by `MoneyModule`; nothing
  else moves an earning, no client request does). One row per finished
  ordinary sale records what it earned (`EarningSettlement`, made by the
  sweep; the payment id is unique). The earnings travel in `EarningMove`
  (R-55): ONE row, and one transfer, per creator per day. The payee's 85% of
  every sale in it moves from WAWU's own account (the account the sales were
  paid into) to the payee's wallet by a wallet-to-wallet transfer through the
  seam (`walletToWallet`; a book transfer on Nuvion, section 14). The 15% is
  WAWU's and stays. The provider's charge on the transfer is WAWU's, paid from
  its 15% (R-31): the payee receives the whole total, and WAWU pays the charge
  once per creator per day, not once per sale (G-703). The charge is on the
  merchant-side ledger row and on the move's `providerFeeKobo`.
- **One transfer a day** (R-55). A day is the Africa/Lagos calendar day.
  The sweep makes a creator's move for the day when, all at once: they have
  earnings no move has taken yet (`moveId` null), a wallet of the provider
  this server runs, a total of those earnings of at least the floor
  (`EARNINGS_MOVE_MIN_KOBO`, default 20000 = N200; a total of exactly the floor
  moves), no open move (owed, not in review), and no move made or landed today
  (a retried move that lands today is the day's transfer). A total under the
  floor waits and is added to the next day's; it is still earned and still
  counted under `waiting`. The move takes every such earning of one account of
  WAWU's, oldest first, up to the provider's cap on one transfer
  (`MERCHANT_MAX_PER_TXN_KOBO`) and 1000 earnings; the rest wait for the next
  day. One earning that alone is over the cap goes to review, never split. The
  earnings in a move are fixed when it is made: those that arrive later wait
  for the next. An earning whose sale stops being a finished one before the
  move is sent leaves it for review, and the move is made again without it,
  under the next reference. All of a move's earnings land together, in one
  write with the move.
- **Exactly once.** The provider sees one reference per move,
  `wawu-earn-d-<YYYYMMDD of the Lagos day>-<24 hex of sha256 of the creator's
  id>` (45 characters, inside Nuvion's 64; a later try adds `-2`, `-3`). The
  move row is unique per creator and day, so two servers make one, and only
  one open move per creator and provider exists (a partial unique index).
  The move is handed over by a lease (`sentAt`) only one caller wins, taken
  with the move's row locked and its sales read FOR SHARE so a review mark set
  meanwhile is seen (nothing is sent) or waits. A replay, the sweep and a
  second Hub process asking at once, or a restart therefore send one move. The
  database holds the same rules (the migrations' CHECKs and triggers): one row
  per sale, a row only for a completed payment of this payee for exactly the
  payee's share, never for a payment that has a hold (and no hold for a payment
  that has a row), what is owed and to whom never changes, a landed row never
  changes; an earning joins only a move of the same person and provider that
  has not been sent; the first refusal's time and the review mark are never
  moved once set.
- **The provider's record is the truth** (the same rules as sections 14 and
  18). A move whose outcome is unknown (a timeout, a 5xx, a transfer accepted
  and not finished, a repeated reference, a Hub killed between the provider's
  answer and our write) is `pending`: the provider is asked about our reference
  (`reconcileSend` on WAWU's own account, backing off 1, 2, 4 ... 60 minutes),
  the move is never sent again and never read as "nothing moved". Past
  `PAYMENT_REVIEW_AFTER_HOURS` (72) with no answer it goes to review
  (`reviewSince`): out of the sweep, the money where it is, a person decides.
  Only the provider's own record that the move FAILED starts a new try, under
  a new reference (`...-2`); a record that it completed and was then REVERSED,
  or that another amount moved, is review. The move, and with it every earning
  in it, is `landed` only when the provider confirmed the transfer, and each
  sale's `payeeSettledAt` is set in the same write.
- **Waiting is not failing** (`waiting` on the earning; the earning stays
  `owed` and the money stays in WAWU's account):
  - `payee_wallet`: the person has no wallet of this provider yet. Their
    earnings are marked so and no move is made for them (R-11: they keep
    earning); the first sweep after the person HAS a wallet makes their move,
    which takes everything waiting, so the money is moved the day the wallet
    opens, within a minute of it. No review bound. A wallet of the other
    provider is not a place to send to.
  - `recipient_frozen`: the provider refuses a move into a frozen wallet (G-10).
    Paid on unfreeze, tried hourly.
  - `funds`: the provider says WAWU's own account cannot cover the move: an
    error in the log on every try.
  - `provider`: the provider is out of reach or not set up, one of its limits
    was hit, or it is another provider's sale (written before a switch of
    `WALLET_PROVIDER`; this server sends nothing for it). A request that
    provably never reached the provider (`requestNotSent`) is this, and is
    sent again under the same reference.
  - `not_supported`: the running provider has no way to make this move yet
    (a Nuvion adapter without its book transfers, NUV-05). An error in the log on every
    try saying so; the earning waits and lands once the provider can.
  - `refused`: the provider refused and nothing moved; retried under the same
    reference. See the next bullet for when a person looks. A frozen wallet, a
    missing wallet and an unreachable provider have no such bound.
- **A refusal gets a person after 72 hours** (R-55, F3). The FIRST time the
  provider refuses a move with nothing moved (`waiting` `refused`, or its own
  record that the transfer failed) the move's `firstRefusedAt` is written, once.
  `EARNINGS_REFUSED_REVIEW_AFTER_HOURS` (default 72) after that moment, if the
  move has not landed and nothing is in flight, it goes to review
  (`reviewSince`, set once; out of the sweep, the money where it is). Later
  refusals do not restart the count and make no second review; the look after a
  refusal is never set later than the 72nd hour, so the review is not up to an
  hour late. It is a clock on time, not a count of tries.
- **The sweep** (`EarningSettlementService.sweep`, every minute, where
  ScheduleModule.forRoot() is loaded) first makes the earning of every finished
  ordinary sale of the running provider that has none, then makes the day's
  move for every creator who is ready for it (see "One transfer a day"), then
  walks every due move by a keyset cursor (creation time, then id) with no cap
  on the rows it looks at, stopping only at the end or when its time
  (`EARNING_SWEEP_BUDGET_MS`, 45 s) is used. The first sale of a day that
  brings a creator's total to the floor is moved in the next pass; sales after
  that wait for the next day's move.
- **The ledger.** On confirmation one pair is written under the move's
  reference, category `earning`: WAWU's account `out` (with the provider's
  charge) and the payee's wallet `in`, for the whole transfer, so the ledger
  equals the provider's record. A move of ONE sale keeps that sale's link and
  names its payer (the history groups unlock earnings by that link, section 6;
  WAWU when the payer's account is gone); a move of several sales has no link
  and comes from WAWU. Best effort, like every ledger write after the money
  moved; the signed delivery and the status check write them too.
- **For the nightly check (MONEY-16):** `EarningSettlementService.owedTotals()`
  is the count and the sum, in kobo, of the earnings still `owed` for the
  running provider (those in a move that has not landed, and those no move has
  taken yet). That money is in WAWU's account beside the open holds
  (`WalletHoldService.openTotals()`) and WAWU's own shares. Compared with the
  provider's own balance, never shown as one.
- **Account deletion.** The payee's id on an earning is a `COUNTERPARTY`: the
  payer's payment and the share it owes survive (BACKEND_GAPS G-702 for what is
  owed to an account that is gone).
- **Not here** (BACKEND_GAPS G-700 to G-702): refunding or reversing a sale
  after its earning landed; credits' host shares and event hosts' payouts
  (WALLET-17). The daily move is for ordinary sales: a held kind's release
  (section 18) is still its own transfer. G-703 is answered by the daily move.
- **The sweep pays only sales made on or after a start time** (lead ruling,
  17 Oct 2026; the owner may override). The start is the setting
  `EARNINGS_SWEEP_START` (ISO 8601 with a zone) when it is set, else the moment
  this code first reached the environment, stored once in `EarningSweepStart`
  (one row, written by its migration; a missing row is written by the first
  sweep that finds it missing, and never changed after). A finished sale with a
  payee made before the start gets no earning from the sweep, ever: it is not
  paid by surprise on deploy. `GET /admin/money/earnings/before-start`
  (superadmin and finance, `limit` and `cursor`, oldest first) lists those sales
  for a person to decide; it moves nothing and cannot mark one paid. It is a
  cursor page (section 6): `data` is `{ startsAt, source, count, items,
  nextCursor }`, `count` being how many such sales there are in all. It is not
  called `total` because the response interceptor rewrites any `items` beside a
  numeric `total` as an offset page and would drop the cursor and the start. A sale at
  exactly the start is paid; the millisecond before it is not.

## 27. Foreign accounts, swaps and crypto sends (WALLET-21, R-83, R-84)

Dollar, euro, pound, Canadian dollar, dirham and cedi accounts, and USDT, USDC
and RLUSD (RLUSD on Ethereum only), on Nuvion, beside the naira wallet. Every
route is under `/api/hub/money/fx` and needs an open naira wallet (R-6, the
identity checks happen once). Amounts follow section 1a: an integer in the
smallest unit in a `...Minor` field, always beside a currency field. Through
`WALLET_PROVIDER` only: a provider without foreign accounts (Fintava) answers
`409 currency_not_supported` on every route. The nine currencies and their
`decimals` come from `GET /money/fx/currencies`, which also says what an admin
has switched off (draw only what is on, R-47).

| Route | What it does |
| --- | --- |
| `GET /money/fx/currencies` | the nine currencies (code, name, `decimals`, chains, `enabled`) and the three product switches (`openAccount`, `swap`, `cryptoSend`) |
| `GET /money/fx/accounts` | the person's accounts: the provider's balance (`availableMinor`, `bookedMinor`; null if it cannot be asked) and the receiving details |
| `POST /money/fx/accounts` | opens one (`currency`, and `chain` for a stablecoin); always 201, and asking again for one the person has returns it |
| `GET /money/fx/accounts/{id}` | one account |
| `GET /money/fx/accounts/{id}/transactions` | the account's statement lines, newest first, cursor page (section 6) |
| `POST /money/fx/quotes` | a quote between two of the person's accounts (or the naira wallet): rate, both amounts, WAWU's fee, the provider's real `expiresAt` |
| `POST /money/fx/swaps` | swaps at a held quote: `Idempotency-Key`, PIN or device approval; `GET /money/fx/swaps/{id}` to poll |
| `GET /money/fx/sends/quote` | what a crypto send costs before the PIN (`accountId`, `currency`, `chain`, `amountMinor`; the currency must be the account's) |
| `POST /money/fx/sends` | sends USDT, USDC or RLUSD to an outside address on the account's chain (`accountId`, `currency`, `chain`, `address`, `amountMinor`): `Idempotency-Key`, PIN; `GET /money/fx/sends/{id}` to poll |

Admin (`/api/hub/admin/money/fx`, superadmin and finance only):
`GET people/{wawuUserId}/accounts`, `GET operations` (swaps and sends, filters
`wawuUserId`, `kind`, `status`, a cursor page), `GET operations/{id}`, and
`POST accounts/{id}/freeze` and `/unfreeze` (a reason; one audit row each).
`GET currencies` (OPS-27, read only) answers the nine currencies with the places
each counts (`decimals`, so a coin is shown as the Hub counts it), the switch
(`enabled`), WAWU's fee on a swap and on a crypto send (`swapFeeMinor`,
`sendFeeMinor`, 0 until named) and the daily limit (`dailyLimitMinor`, null for
none), the three product switches, and the naira side (`swapFeeKobo`,
`dailyLimitKobo`). The switches change in `PATCH /admin/plan-settings`
(`fx.currency.<CODE>.on`, `fx.product.<product>.on`); fees and limits are config.

**Errors.** The usual money errors (section 3) plus, for these routes:
`fx_switched_off` (409: a currency or a product is off), `quote_expired` (409:
the provider's hold has passed or the quote was used; ask for a new one),
`account_frozen` (423), `fx_account_not_open` (409), `address_invalid` (422: the
address is not one a wallet on that chain has), `chain_mismatch` (422: the
send's chain is not the account's), and `provider_declined` (409: the provider
refused in words of its own, carried in `message`; nothing moved). Figures in
an error use `balanceMinor`, `totalMinor`, `shortfallMinor`, `limitMinor`,
`remainingTodayMinor` and `currency`.

**What the app is told, and not.** A stablecoin account holds one chain's
wallet address, so USDT on two chains is two accounts (the app groups them by
`currency`). A quote's hold is the provider's (`expiresAt`), never a fixed
number. The provider's own fee on a send is named only when it takes the send,
so `GET /money/fx/sends/quote` has `providerFeeMinor: null` and the receipt
carries what was charged. WAWU's fee per currency comes from config and is 0
until the owner names it (R-10).

**Where an account's details stand** (fix round 1, verifier M2). Each account has
`detailsStatus`: `ready` (issued and active), `pending` (the provider is issuing
them) or `unavailable` (the provider would not issue them just now), and
`detailsNote`, the provider's own words when `unavailable` (null otherwise).
The app says exactly that and promises no arrival: on dev CAD and AED answer
503 every time. An account whose details were never seen is asked again on
every read.

**WAWU's fee** (R-10, fix round 1, verifier H1). A swap or a send is charged the
fee in the source currency, on top, as a second transfer under the operation's
reference plus `-fee`. Out of naira it is a transfer to WAWU's operational
account, the way a naira send's fee is collected; out of another currency it is
a transfer to `FX_FEE_COLLECTOR_<CODE>_BAN`. The leg counts as paid only when the
provider says it completed. A fee the provider refuses is tried again under a
new reference (`-fee-2`, `-fee-3`); after three refusals it is given back (the
operation's `wawuFeeMinor` becomes 0 and the admin view shows `feeLeg:
uncollected`). A fee whose answer was lost or is unfinished stays `owed` and is
asked again under the same reference.

---

## 28. Capital (NUV-12, R-84)

The provider's investment products, from the wallet, in naira: a fixed return
(a principal, a rate the provider locks at purchase, a term of 7 to 180 days)
or a share offering (whole shares at a fixed price, held for a lock period).
Routes under `/capital` (the app) and `/admin/capital/orders` (the
dashboard). `WalletProvider.capital` is the only way in; a provider without it
(Fintava) leaves every route answering `409 capital_unavailable`.

| Route | What it does |
|---|---|
| `GET /capital/availability` | `{ available, holding }`: `available` is Capital on (plan setting `capital.enabled`, default off since R-97) and the provider serves it, so new orders can be made; `holding` is the person holds an order that is not over. The app draws the Wallet tab row, and any other way into Capital, only when `holding` is true (R-97: WAWU offers no investments). No wallet needed. |
| `GET /capital/products?kind=&cursor=` | The products in naira with their terms (rate, term, early exit, deductions, sale window, minimum and maximum). Each says `orderable` and, when it is not, why (`sold_out`, `sale_closed`, `not_open_yet`, `unavailable`). A kind the provider has that is not served here (private equity) is left out. The provider's own description of a product is **not** served (it is marketing and can promise what WAWU does not): a product is its terms, plus its name, its issuer's name and its documents. |
| `GET /capital/products/{id}` | The same, with `documents` (every one is agreed to when ordering) and `terms`: WAWU's own limits and fee rule. |
| `POST /capital/orders` | Reserves for 15 minutes at the provider's quote. **No money moves, no PIN.** `Idempotency-Key` makes a double tap reserve once. Body `{ productId, amountKobo, lockInvestment?, agreedToDocuments: true }`. `201` with the order (`reserved`). |
| `POST /capital/orders/{id}/confirm` | The only step that takes the money. `Idempotency-Key`, the PIN or a device approval. Before the PIN and with no try used: not the caller's order, `reservation_expired`, `capital_unavailable` (held), the daily limit, `insufficient_funds`. `201` with the order: `invested`, or `confirming` when the provider has not finished (read it again; it is never charged twice). |
| `GET /capital/orders?show=holding|ended` | The person's orders, newest first. |
| `GET /capital/orders/{id}` | One order, the holding read from the provider now. |
| `GET /capital/orders/{id}/transactions` | The holding's movements (purchase, each day's interest, payout). |
| `GET /capital/orders/{id}/withdrawal` | What leaving now pays: interest so far, the penalty on an early exit, deductions, net payout. Read only. |
| `POST /capital/orders/{id}/withdrawal` | Starts the payout (early exit, or the full payout once matured; the provider picks). `Idempotency-Key` and the PIN. `201` with the order, `paying_out`. |
| `GET /capital/portfolio` | Invested, return so far and value now, as the provider totals them. Never a sum of our rows. |

Words and figures: a rate, a term, a penalty and a payout are the provider's
own, shown as stated; a figure the provider does not give is `null`, never
zero; nothing is promised. Amounts are kobo (naira only until the other
currency accounts are built: a product in another currency is not listed).

**Controls (owner-asked).** On or off: the plan setting `capital.enabled`
(default 0 since R-97: WAWU offers no investments, so Capital is closed unless an admin switches it on). Off closes new orders only (`products`, `POST /capital/orders`, and the confirmation of a reservation still held answer `409 capital_unavailable`); the portfolio, the orders, a holding's movements, the withdrawal preview and `POST .../withdrawal` keep answering, so a person who holds something can still take it out. Limits and WAWU's fee are settings read at boot:
`CAPITAL_MIN_KOBO`, `CAPITAL_MAX_KOBO`, `CAPITAL_DAILY_MAX_KOBO` (unset: none
of ours) and `CAPITAL_WAWU_FEE_KOBO` plus `CAPITAL_WAWU_FEE_BPS` (default 0,
R-10). A fee is quoted on the reservation (`feeKobo`, `totalKobo`), checked
against the balance, and taken once after the purchase as its own transfer to
WAWU's account (a fixed reference; the sweep retries a fee that could not be
taken, and the investment never waits for it). The admin routes (superadmin and
finance; each act writes an audit row) list orders and `freeze` (the person
cannot confirm or withdraw), `unfreeze` and `cancel` (only a reservation: the
provider has no call to undo an investment that is made).
`GET /admin/capital/orders/settings` (OPS-27, read only) answers the switch
(`enabled`), the three limits (`minKobo`, `maxKobo`, `dailyMaxKobo`, null for
none) and WAWU's fee (`feeFlatKobo`, `feeBasisPoints`).

**The ledger.** The purchase is one `out` row (reference `wawu-cap-<order>`),
the payout one `in` row (`wawu-cap-payout-<order>`), the fee one `out` row
(`wawu-capfee-<order>`, counterparty "WAWU's fee"), each other counterparty "Capital · <product>". A delivery
of the provider's `capital-*` transfer adds its transfer id to the same row.
A reservation that expires writes nothing.

**What dev showed that the docs do not say** (mobile `docs/nuvion/DEV-RESULTS.md`,
"Capital"): a second confirm of an approved order is `400` invalid for state
(not the first result), so the order is read before anything is said; a
payout settles in seconds on dev; `capital-transactions` filters by the
capital account's id; share offerings carry `availability.orderable` and
`reason`.

## 29. The WAWU card (WALLET-31, R-84)

Virtual and single-use dollar cards that Nuvion issues, funded from the
person's own account, Nuvion converting at use. Routes under `/money/cards`
(the controller is `MoneyCardsController`, `src/money/cards/`), every one
behind the wallet gate (`wallet_not_open`, `wallet_opening`, `wallet_frozen`).
There is no physical card (Nuvion issues none), no card PIN, no channel
switches and no spending limits (Nuvion serves none): those are not routes.

- **Nothing of the card's secrets is stored or logged.** The answer to a
  card being made, and every list or status read, carries no number, expiry
  or CVV. `POST /money/cards/{id}/reveal` reads them from Nuvion, each time,
  behind the PIN or a fingerprint approval, answers `Cache-Control:
  no-store`, and keeps nothing.
- **`POST /money/cards`** takes `Idempotency-Key`, the PIN or a biometric
  approval, and `{ kind: "virtual" | "single_use", name? }`. Nuvion takes its
  fee from the person's account when it makes the card (dev, 24 Oct 2026:
  65,772 kobo for either kind), WAWU's fee is 0 (R-10; a value above 0 is not
  collected as a send's fee is, see "Round 1" below). Answers `201` with
  a `CardView`: `active`, or `pending` when Nuvion has not confirmed it (it
  is found again by its reference, never made twice; `pending` rows are
  looked for when the list is read). The same key and body answer the first
  result again (`Idempotent-Replayed: true`) without checking the PIN. A
  refusal gives the key back. Cards switched off, a limit and
  `fees_not_set` are answered before the PIN is looked at. A funding account
  that cannot pay Nuvion's fee is `402 insufficient_funds` with the fee in
  the message.
- **`GET /money/cards/quote`**: `{ enabled, currency, kinds, fee, limits,
  canCreate }`, the fee as `FeeBreakdown` (Nuvion's plus WAWU's, both from
  settings: `NUVION_FEE_CARD_CREATE` has no default and `WAWU_FEE_CARD_KOBO`
  defaults to 0). `fees_not_set` as every fee quote.
- **`GET /money/cards`**: `{ enabled, cards }`, newest first. `enabled` is the
  plan setting `cards.enabled` (1 or 0, default 1, admin-editable): while 0
  nothing new is made and the app draws nothing for cards, but a card held can
  still be frozen or blocked. **`GET /money/cards/{id}`** and
  **`GET /money/cards/{id}/transactions`** (cursor page of payments,
  reversals and refunds; empty for a blocked card, which Nuvion no longer
  lists).
- **`POST /money/cards/{id}/freeze`** and **`DELETE /money/cards/{id}`**
  (block for good: Nuvion soft-deletes the card, so block and delete are one
  action) need no PIN, so a lost card is stopped at once; both are safe to
  repeat. **`POST /money/cards/{id}/unfreeze`** needs the PIN or a fingerprint.
  A card support froze answers `409 card_blocked` to the person's unfreeze.
- A card is the person's own: another person's id is `404 not_found`.
- New money error codes: `cards_unavailable` (503: switched off, not built
  for the running provider, or Nuvion refused the request and nothing was
  taken), `card_limit_reached` (409: `WALLET_CARD_MAX_ACTIVE`, default 5, or
  `WALLET_CARD_MAX_PER_DAY`, default 10; Default (lead), owner may override),
  `card_blocked` (409: the card is blocked for good, still being made, or
  frozen by support).
- **Support** (`admin/money/cards`, superadmin and finance, audited in
  `AdminOpsAudit` as `wallet_card_frozen`, `_unfrozen`, `_cancelled`):
  `GET` (filter by `state` or `wawuUserId`, cursor page), `POST {id}/freeze`,
  `POST {id}/unfreeze`, `POST {id}/cancel`. By account id only: no number,
  name or phone is read or returned.
  `GET settings` (OPS-27, read only) answers the switch (`enabled`, the plan
  setting `cards.enabled`), Nuvion's fee and WAWU's fee in kobo
  (`providerFeeKobo`, null while unset; `wawuFeeKobo`) and the two counts
  (`maxActive`, `maxPerDay`).
- Nuvion's own events (`cards.created`, `.frozen`, `.unfrozen`, `.deleted`)
  keep the Hub's row in step (`src/nuvion/handlers/cards.handler.ts`); a
  frozen or unfrozen event is followed by reading the card's status, so a late
  one cannot undo a newer change.

### Round 1 changes to section 29 (WALLET-31, 24 Oct 2026)

- **WAWU's own fee on a card is collected** like WAWU's fee on a send (FIX-52):
  after the card exists, one transfer under the card's reference plus `-fee`
  from the person's account to WAWU's, its ledger side (money in on WAWU's
  account) written once, the provider answering a repeat with the original.
  Before anything is claimed the wallet's balance is read and a wallet that
  cannot cover both fees is `402 insufficient_funds` (the key is free). A fee
  transfer that is not confirmed never undoes the card: it is tried again each
  time the card is read (`WalletCard.feeCollectedAt` null means owed).
  `WAWU_FEE_CARD_KOBO` above 0 is therefore a working setting (a provider that
  cannot move a fee as its own transfer answers `fees_not_set`).
- **A single-use card Nuvion blocked after its payment is `used`**
  (`CardStatus` gains `used`): it cannot be frozen, unfrozen or shown (`409
  card_blocked`), its payments are still listed, and it no longer counts as
  held. A card Nuvion blocked that is not single-use is `frozen`.
- **`POST /money/cards/{id}/reveal` has its own count**: 5 a minute per person,
  then `429 card_reveal_rate_limited` with `retryAfterSeconds`, after the wallet
  gate and before the PIN.
- While cards are off (`enabled: false`) a person's existing cards are still
  listed and can be frozen, blocked and read; only making a card is refused.
- A repeated admin unfreeze or cancel changes nothing and writes no second
  audit row.
- A `cards.*` delivery is stored without any key that could hold a number, CVV
  or expiry. Deleting an account blocks every card the person still holds first
  (the row is OWNED and goes with the account).

---

## 30. Send abroad (NUV-11, R-84)

A person pays a foreign bank account or a mobile money wallet from any of their accounts. Every route is under `/api/hub/money/abroad`, needs an open wallet (R-6): a naira wallet, or (WALLET-42, R-87) a world wallet, whose person can send only from a foreign account they hold (see "From a foreign account" below). It reaches the provider only through `WALLET_PROVIDER` (its `abroad` side; a provider without one, Fintava, answers `409 currency_not_supported`), and follows section 1a for amounts (`...Minor` beside a currency field; WAWU's fee is naira, `wawuFeeKobo`).

| Route | What it does |
| --- | --- |
| `GET /money/abroad/corridors` | the product switch (`enabled`), WAWU's fee, and the countries: each with its currency, whether it is `available` (and why not), and its ways (`bank`, `mobile_money`), schemes and the exact fields to ask for each (key, label, kind, pattern, hint, options) |
| `GET /money/abroad/banks/{country}` | the provider's bank directory for one country (a `bank` field's picker) |
| `GET /money/abroad/sources` | the accounts to send from, with the provider's balance read now |
| `GET`, `POST /money/abroad/recipients`, `DELETE /money/abroad/recipients/{id}` | saved recipients; saving takes the country, the way, the scheme when there is a choice, the name on the account and exactly the corridor's fields; only the last four characters are kept here; 201 first, 200 for one already saved |
| `POST /money/abroad/quotes` | what a send delivers and costs: the provider's rate and real hold when the currencies differ (a WAWU hold of 10 minutes when they are the same), both amounts, WAWU's fee; `side` says which amount was typed |
| `POST /money/abroad/sends` | sends at a held quote, once: `Idempotency-Key` and PIN or device approval; answers 201 with the send (`sending` or `pending` until the provider decides; poll `GET /money/abroad/sends/{id}`); the same key and body answer the first result again |
| `GET /money/abroad/sends`, `GET /money/abroad/sends/{id}` | the person's sends, newest first (cursor page, section 6), and one send |

Admin (`/api/hub/admin/money/abroad`, superadmin and finance only): `GET sends` (filters `wawuUserId`, `status`, a cursor page), `GET sends/{id}`, `POST sends/{id}/cancel`, `POST people/{wawuUserId}/freeze` and `/unfreeze` (a reason; one `AbroadAdminAudit` row each; a repeat changes nothing and writes no second row). Cancel stands only for a send the provider never received, found by a complete search of its records; the provider has no cancel call, so a send it holds is `409 send_not_cancellable`.

**Errors.** The usual money errors (section 3) plus `fx_switched_off` (the product is off), `account_frozen` (423, the person is frozen), `quote_expired`, `fx_account_not_open`, `provider_declined`, and four of this task: `corridor_not_supported` (422), `recipient_details_invalid` (422, the refused fields by key in `reason.fields`), `rate_unavailable` (409, the provider has no rate for the pair now) and `send_not_cancellable` (409). `amount_out_of_range` carries `minimumMinor` or `maximumMinor` and the `currency` they are in.

**Settings** (admin, group "Send abroad"): `abroad.enabled` (1, on), `abroad.wawu_fee_kobo` (0, R-10), `abroad.wawu_fee_foreign` (lines like `GBP BANK 100` or `USD MOBILE_MONEY 150`: WAWU's fee for a send from a foreign account, in that currency's smallest unit; none until named, WALLET-42), `abroad.max_per_send` and `abroad.max_per_day` (lines like `USD 500000`, none until named), `abroad.corridors_off` (two-letter codes; Uganda, Mexico, Singapore and Hong Kong while the provider's dev server refuses them).

**The partner's fee (round 1, R-10: the person pays it on top, shown before the PIN).** The provider's quote has no fee and names its own only on the transfer it takes, so the quote's `providerFeeMinor` is the figure configured for the corridor (`ABROAD_PROVIDER_FEE_<CURRENCY>_<BANK or MOBILE_MONEY>`, `.env.example`), in the sending currency's smallest unit, or null when none is configured. The funds check counts the amount, that fee and, from the naira wallet, WAWU's fee. The receipt carries what the provider really charged (`applicable_fee`); when it is not the configured figure the send is flagged `feeDiffers` for the admin list so the figure can be corrected.

**WAWU's fee when a send does not stand.** A send that fails or is reversed after WAWU's fee was taken gives it back, once: `<reference>-fee-back` from WAWU's account to the person's wallet, the amount the fee leg's own completed record moved. A leg is done only when the provider's record says it completed; a reference the provider failed is replaced (`-2`, then `-3`) in a later pass; three failed references, or a day, hold it for a person with the fee still owed (`wawuFeeBackOwed` on the admin list).

**Fees not set, funds, and deleting an account (round 1).** The quote and the send run `FeesSetGuard` first, like every other quote and money-moving route (NUV-07): `503 fees_not_set` before the wallet gate, the key or the PIN while the running provider's fees are unset. The quote moves nothing, so its documented codes are the gate's, `fees_not_set` and the corridor's; its funds check still answers `402 insufficient_funds` (the amount, the partner's fee and WAWU's fee against the account), which the money-moving coverage spec does not let a quote list. The send documents the full debit set. A send the provider has not finished, or whose WAWU fee is still to be taken or given back, holds an account deletion as `payment_in_progress`; the account data map classes the sends, quotes, recipients and the freeze as the person's own (deleted with them, after an empty wallet) and the admin audit rows as kept, and the data export names them as left out until statements (G-130).

**A fee question always ends (round 2).** WAWU's fee on a send is open until it is taken (and, on a send that did not stand, given back) or closed. The sweep reads, and never makes, the fee leg of a send that failed or was reversed while the leg was still on its way: a leg that completed is marked taken and given back once, one that never completed closes the question quietly (`nothing_taken`), one still on its way a day on is held for a person. A fee that could not be taken from a send that went through is written off after the last try (`not_taken`, a `fee_not_taken` row in `AbroadAdminAudit` by `system`). A give-back or a fee the sweep gives up on is held for a person (`fee_held` row, `feeBackHeld` in the admin list) and stops holding an account deletion, which counts only what the sweep is still trying. Finance finds open ones with `GET /admin/money/abroad/sends?feeOpen=true` and closes one with `POST /admin/money/abroad/sends/{id}/settle-fee` (`outcome` `not_taken` or `paid_back`, a reason; superadmin and finance; one audit row; a repeat changes nothing; `409` for a fee the partner's record shows was taken, a give-back still on its way, a send not decided yet, or nothing owed). The provider's status word is applied with a compare-and-set on the status read, so a cancel that commits in between is never undone, and a fee is not taken from a send already reversed. The quote lists `402 insufficient_funds` again (it reads the balance and moves nothing; `money-moving-coverage.spec.ts` names it).

**From a foreign account (WALLET-42, R-87).** A person with a world wallet has no naira account, so every `/money/abroad` route takes their wallet (the gate hands the seam an empty wallet id and the entity as the customer) and they can send only from a foreign account they hold, in the send's source currency: a quote from the naira wallet is `409 fx_account_not_open` ("You have no naira account. Send from one of your other currency accounts.") and one from a currency they do not hold is the same code ("You do not have a USD account to send from."). A person with a naira wallet may send from a foreign account of theirs too. **WAWU's fee follows the account the money leaves, for everyone** (lead ruling, owner may override): from the naira wallet it is the naira fee (`wawuFeeKobo`, `abroad.wawu_fee_kobo`, section above); from a foreign account it is that currency's fee, `wawuFeeMinor` on the quote and the send (`wawuFeeKobo` is then 0), from `abroad.wawu_fee_foreign` per currency and way, charged on top with the partner's fee and counted before the PIN (`insufficient_funds`). A fee in a currency whose collecting account is not configured (`FX_FEE_COLLECTOR_<CODE>_BAN`, the one the swap fee uses) is not offered (`409 currency_not_supported`), never taken from naira. It is the same fee legs as the naira fee (`<reference>-fee` to WAWU's collecting account in that currency, `<reference>-fee-back` to the account when the send does not stand, the same reference generations, once each), made through the abroad side's `feeLeg` and found by `findFeeLeg`. The naira wallet is never read or moved for a world person. Nuvion's partner fee is charged on top of the amount in the source currency (dev, GBP: 112 pence to Ghana mobile money, 200 pence to a UK bank), and a transfer Nuvion fails returns amount and fee to the account (docs/nuvion/DEV-RESULTS.md in the mobile repo).

**What the app is told, and not.** A stablecoin account holds one chain's
wallet address, so USDT on two chains is two accounts (the app groups them by
`currency`). A quote's hold is the provider's (`expiresAt`), never a fixed
number. The provider's own fee on a send is named only when it takes the send,
so `GET /money/fx/sends/quote` has `providerFeeMinor: null` and the receipt
carries what was charged. WAWU's fee per currency comes from config and is 0
until the owner names it (R-10).

**Where an account's details stand** (fix round 1, verifier M2). Each account has
`detailsStatus`: `ready` (issued and active), `pending` (the provider is issuing
them) or `unavailable` (the provider would not issue them just now), and
`detailsNote`, the provider's own words when `unavailable` (null otherwise).
The app says exactly that and promises no arrival: on dev CAD and AED answer
503 every time. An account whose details were never seen is asked again on
every read.

**WAWU's fee** (R-10, fix round 1, verifier H1). A swap or a send is charged the
fee in the source currency, on top, as a second transfer under the operation's
reference plus `-fee`. Out of naira it is a transfer to WAWU's operational
account, the way a naira send's fee is collected; out of another currency it is
a transfer to `FX_FEE_COLLECTOR_<CODE>_BAN`. The leg counts as paid only when the
provider says it completed. A fee the provider refuses is tried again under a
new reference (`-fee-2`, `-fee-3`); after three refusals it is given back (the
operation's `wawuFeeMinor` becomes 0 and the admin view shows `feeLeg:
uncollected`). A fee whose answer was lost or is unfinished stays `owed` and is
asked again under the same reference.

---

## 28. Capital (NUV-12, R-84)

The provider's investment products, from the wallet, in naira: a fixed return
(a principal, a rate the provider locks at purchase, a term of 7 to 180 days)
or a share offering (whole shares at a fixed price, held for a lock period).
Routes under `/capital` (the app) and `/admin/capital/orders` (the
dashboard). `WalletProvider.capital` is the only way in; a provider without it
(Fintava) leaves every route answering `409 capital_unavailable`.

| Route | What it does |
|---|---|
| `GET /capital/availability` | `{ available, holding }`: `available` is Capital on (plan setting `capital.enabled`, default off since R-97) and the provider serves it, so new orders can be made; `holding` is the person holds an order that is not over. The app draws the Wallet tab row, and any other way into Capital, only when `holding` is true (R-97: WAWU offers no investments). No wallet needed. |
| `GET /capital/products?kind=&cursor=` | The products in naira with their terms (rate, term, early exit, deductions, sale window, minimum and maximum). Each says `orderable` and, when it is not, why (`sold_out`, `sale_closed`, `not_open_yet`, `unavailable`). A kind the provider has that is not served here (private equity) is left out. The provider's own description of a product is **not** served (it is marketing and can promise what WAWU does not): a product is its terms, plus its name, its issuer's name and its documents. |
| `GET /capital/products/{id}` | The same, with `documents` (every one is agreed to when ordering) and `terms`: WAWU's own limits and fee rule. |
| `POST /capital/orders` | Reserves for 15 minutes at the provider's quote. **No money moves, no PIN.** `Idempotency-Key` makes a double tap reserve once. Body `{ productId, amountKobo, lockInvestment?, agreedToDocuments: true }`. `201` with the order (`reserved`). |
| `POST /capital/orders/{id}/confirm` | The only step that takes the money. `Idempotency-Key`, the PIN or a device approval. Before the PIN and with no try used: not the caller's order, `reservation_expired`, `capital_unavailable` (held), the daily limit, `insufficient_funds`. `201` with the order: `invested`, or `confirming` when the provider has not finished (read it again; it is never charged twice). |
| `GET /capital/orders?show=holding|ended` | The person's orders, newest first. |
| `GET /capital/orders/{id}` | One order, the holding read from the provider now. |
| `GET /capital/orders/{id}/transactions` | The holding's movements (purchase, each day's interest, payout). |
| `GET /capital/orders/{id}/withdrawal` | What leaving now pays: interest so far, the penalty on an early exit, deductions, net payout. Read only. |
| `POST /capital/orders/{id}/withdrawal` | Starts the payout (early exit, or the full payout once matured; the provider picks). `Idempotency-Key` and the PIN. `201` with the order, `paying_out`. |
| `GET /capital/portfolio` | Invested, return so far and value now, as the provider totals them. Never a sum of our rows. |

Words and figures: a rate, a term, a penalty and a payout are the provider's
own, shown as stated; a figure the provider does not give is `null`, never
zero; nothing is promised. Amounts are kobo (naira only until the other
currency accounts are built: a product in another currency is not listed).

**Controls (owner-asked).** On or off: the plan setting `capital.enabled`
(default 0 since R-97: WAWU offers no investments, so Capital is closed unless an admin switches it on). Off closes new orders only (`products`, `POST /capital/orders`, and the confirmation of a reservation still held answer `409 capital_unavailable`); the portfolio, the orders, a holding's movements, the withdrawal preview and `POST .../withdrawal` keep answering, so a person who holds something can still take it out. Limits and WAWU's fee are settings read at boot:
`CAPITAL_MIN_KOBO`, `CAPITAL_MAX_KOBO`, `CAPITAL_DAILY_MAX_KOBO` (unset: none
of ours) and `CAPITAL_WAWU_FEE_KOBO` plus `CAPITAL_WAWU_FEE_BPS` (default 0,
R-10). A fee is quoted on the reservation (`feeKobo`, `totalKobo`), checked
against the balance, and taken once after the purchase as its own transfer to
WAWU's account (a fixed reference; the sweep retries a fee that could not be
taken, and the investment never waits for it). The admin routes (superadmin and
finance; each act writes an audit row) list orders and `freeze` (the person
cannot confirm or withdraw), `unfreeze` and `cancel` (only a reservation: the
provider has no call to undo an investment that is made).
`GET /admin/capital/orders/settings` (OPS-27, read only) answers the switch
(`enabled`), the three limits (`minKobo`, `maxKobo`, `dailyMaxKobo`, null for
none) and WAWU's fee (`feeFlatKobo`, `feeBasisPoints`).

**The ledger.** The purchase is one `out` row (reference `wawu-cap-<order>`),
the payout one `in` row (`wawu-cap-payout-<order>`), the fee one `out` row
(`wawu-capfee-<order>`, counterparty "WAWU's fee"), each other counterparty "Capital · <product>". A delivery
of the provider's `capital-*` transfer adds its transfer id to the same row.
A reservation that expires writes nothing.

**What dev showed that the docs do not say** (mobile `docs/nuvion/DEV-RESULTS.md`,
"Capital"): a second confirm of an approved order is `400` invalid for state
(not the first result), so the order is read before anything is said; a
payout settles in seconds on dev; `capital-transactions` filters by the
capital account's id; share offerings carry `availability.orderable` and
`reason`.

## 29. The WAWU card (WALLET-31, R-84)

Virtual and single-use dollar cards that Nuvion issues, funded from the
person's own account, Nuvion converting at use. Routes under `/money/cards`
(the controller is `MoneyCardsController`, `src/money/cards/`), every one
behind the wallet gate (`wallet_not_open`, `wallet_opening`, `wallet_frozen`).
There is no physical card (Nuvion issues none), no card PIN, no channel
switches and no spending limits (Nuvion serves none): those are not routes.

- **Nothing of the card's secrets is stored or logged.** The answer to a
  card being made, and every list or status read, carries no number, expiry
  or CVV. `POST /money/cards/{id}/reveal` reads them from Nuvion, each time,
  behind the PIN or a fingerprint approval, answers `Cache-Control:
  no-store`, and keeps nothing.
- **`POST /money/cards`** takes `Idempotency-Key`, the PIN or a biometric
  approval, and `{ kind: "virtual" | "single_use", name? }`. Nuvion takes its
  fee from the person's account when it makes the card (dev, 24 Oct 2026:
  65,772 kobo for either kind), WAWU's fee is 0 (R-10; a value above 0 is not
  collected as a send's fee is, see "Round 1" below). Answers `201` with
  a `CardView`: `active`, or `pending` when Nuvion has not confirmed it (it
  is found again by its reference, never made twice; `pending` rows are
  looked for when the list is read). The same key and body answer the first
  result again (`Idempotent-Replayed: true`) without checking the PIN. A
  refusal gives the key back. Cards switched off, a limit and
  `fees_not_set` are answered before the PIN is looked at. A funding account
  that cannot pay Nuvion's fee is `402 insufficient_funds` with the fee in
  the message.
- **`GET /money/cards/quote`**: `{ enabled, currency, kinds, fee, limits,
  canCreate }`, the fee as `FeeBreakdown` (Nuvion's plus WAWU's, both from
  settings: `NUVION_FEE_CARD_CREATE` has no default and `WAWU_FEE_CARD_KOBO`
  defaults to 0). `fees_not_set` as every fee quote.
- **`GET /money/cards`**: `{ enabled, cards }`, newest first. `enabled` is the
  plan setting `cards.enabled` (1 or 0, default 1, admin-editable): while 0
  nothing new is made and the app draws nothing for cards, but a card held can
  still be frozen or blocked. **`GET /money/cards/{id}`** and
  **`GET /money/cards/{id}/transactions`** (cursor page of payments,
  reversals and refunds; empty for a blocked card, which Nuvion no longer
  lists).
- **`POST /money/cards/{id}/freeze`** and **`DELETE /money/cards/{id}`**
  (block for good: Nuvion soft-deletes the card, so block and delete are one
  action) need no PIN, so a lost card is stopped at once; both are safe to
  repeat. **`POST /money/cards/{id}/unfreeze`** needs the PIN or a fingerprint.
  A card support froze answers `409 card_blocked` to the person's unfreeze.
- A card is the person's own: another person's id is `404 not_found`.
- New money error codes: `cards_unavailable` (503: switched off, not built
  for the running provider, or Nuvion refused the request and nothing was
  taken), `card_limit_reached` (409: `WALLET_CARD_MAX_ACTIVE`, default 5, or
  `WALLET_CARD_MAX_PER_DAY`, default 10; Default (lead), owner may override),
  `card_blocked` (409: the card is blocked for good, still being made, or
  frozen by support).
- **Support** (`admin/money/cards`, superadmin and finance, audited in
  `AdminOpsAudit` as `wallet_card_frozen`, `_unfrozen`, `_cancelled`):
  `GET` (filter by `state` or `wawuUserId`, cursor page), `POST {id}/freeze`,
  `POST {id}/unfreeze`, `POST {id}/cancel`. By account id only: no number,
  name or phone is read or returned.
  `GET settings` (OPS-27, read only) answers the switch (`enabled`, the plan
  setting `cards.enabled`), Nuvion's fee and WAWU's fee in kobo
  (`providerFeeKobo`, null while unset; `wawuFeeKobo`) and the two counts
  (`maxActive`, `maxPerDay`).
- Nuvion's own events (`cards.created`, `.frozen`, `.unfrozen`, `.deleted`)
  keep the Hub's row in step (`src/nuvion/handlers/cards.handler.ts`); a
  frozen or unfrozen event is followed by reading the card's status, so a late
  one cannot undo a newer change.

### Round 1 changes to section 29 (WALLET-31, 24 Oct 2026)

- **WAWU's own fee on a card is collected** like WAWU's fee on a send (FIX-52):
  after the card exists, one transfer under the card's reference plus `-fee`
  from the person's account to WAWU's, its ledger side (money in on WAWU's
  account) written once, the provider answering a repeat with the original.
  Before anything is claimed the wallet's balance is read and a wallet that
  cannot cover both fees is `402 insufficient_funds` (the key is free). A fee
  transfer that is not confirmed never undoes the card: it is tried again each
  time the card is read (`WalletCard.feeCollectedAt` null means owed).
  `WAWU_FEE_CARD_KOBO` above 0 is therefore a working setting (a provider that
  cannot move a fee as its own transfer answers `fees_not_set`).
- **A single-use card Nuvion blocked after its payment is `used`**
  (`CardStatus` gains `used`): it cannot be frozen, unfrozen or shown (`409
  card_blocked`), its payments are still listed, and it no longer counts as
  held. A card Nuvion blocked that is not single-use is `frozen`.
- **`POST /money/cards/{id}/reveal` has its own count**: 5 a minute per person,
  then `429 card_reveal_rate_limited` with `retryAfterSeconds`, after the wallet
  gate and before the PIN.
- While cards are off (`enabled: false`) a person's existing cards are still
  listed and can be frozen, blocked and read; only making a card is refused.
- A repeated admin unfreeze or cancel changes nothing and writes no second
  audit row.
- A `cards.*` delivery is stored without any key that could hold a number, CVV
  or expiry. Deleting an account blocks every card the person still holds first
  (the row is OWNED and goes with the account).

---

## 30. Send abroad (NUV-11, R-84)

A person pays a foreign bank account or a mobile money wallet from any of their accounts. Every route is under `/api/hub/money/abroad`, needs an open wallet (R-6): a naira wallet, or (WALLET-42, R-87) a world wallet, whose person can send only from a foreign account they hold (see "From a foreign account" below). It reaches the provider only through `WALLET_PROVIDER` (its `abroad` side; a provider without one, Fintava, answers `409 currency_not_supported`), and follows section 1a for amounts (`...Minor` beside a currency field; WAWU's fee is naira, `wawuFeeKobo`).

| Route | What it does |
| --- | --- |
| `GET /money/abroad/corridors` | the product switch (`enabled`), WAWU's fee, and the countries: each with its currency, whether it is `available` (and why not), and its ways (`bank`, `mobile_money`), schemes and the exact fields to ask for each (key, label, kind, pattern, hint, options) |
| `GET /money/abroad/banks/{country}` | the provider's bank directory for one country (a `bank` field's picker) |
| `GET /money/abroad/sources` | the accounts to send from, with the provider's balance read now |
| `GET`, `POST /money/abroad/recipients`, `DELETE /money/abroad/recipients/{id}` | saved recipients; saving takes the country, the way, the scheme when there is a choice, the name on the account and exactly the corridor's fields; only the last four characters are kept here; 201 first, 200 for one already saved |
| `POST /money/abroad/quotes` | what a send delivers and costs: the provider's rate and real hold when the currencies differ (a WAWU hold of 10 minutes when they are the same), both amounts, WAWU's fee; `side` says which amount was typed |
| `POST /money/abroad/sends` | sends at a held quote, once: `Idempotency-Key` and PIN or device approval; answers 201 with the send (`sending` or `pending` until the provider decides; poll `GET /money/abroad/sends/{id}`); the same key and body answer the first result again |
| `GET /money/abroad/sends`, `GET /money/abroad/sends/{id}` | the person's sends, newest first (cursor page, section 6), and one send |

Admin (`/api/hub/admin/money/abroad`, superadmin and finance only): `GET sends` (filters `wawuUserId`, `status`, a cursor page), `GET sends/{id}`, `POST sends/{id}/cancel`, `POST people/{wawuUserId}/freeze` and `/unfreeze` (a reason; one `AbroadAdminAudit` row each; a repeat changes nothing and writes no second row). Cancel stands only for a send the provider never received, found by a complete search of its records; the provider has no cancel call, so a send it holds is `409 send_not_cancellable`.

**Errors.** The usual money errors (section 3) plus `fx_switched_off` (the product is off), `account_frozen` (423, the person is frozen), `quote_expired`, `fx_account_not_open`, `provider_declined`, and four of this task: `corridor_not_supported` (422), `recipient_details_invalid` (422, the refused fields by key in `reason.fields`), `rate_unavailable` (409, the provider has no rate for the pair now) and `send_not_cancellable` (409). `amount_out_of_range` carries `minimumMinor` or `maximumMinor` and the `currency` they are in.

**Settings** (admin, group "Send abroad"): `abroad.enabled` (1, on), `abroad.wawu_fee_kobo` (0, R-10), `abroad.wawu_fee_foreign` (lines like `GBP BANK 100` or `USD MOBILE_MONEY 150`: WAWU's fee for a send from a foreign account, in that currency's smallest unit; none until named, WALLET-42), `abroad.max_per_send` and `abroad.max_per_day` (lines like `USD 500000`, none until named), `abroad.corridors_off` (two-letter codes; Uganda, Mexico, Singapore and Hong Kong while the provider's dev server refuses them).

**The partner's fee (round 1, R-10: the person pays it on top, shown before the PIN).** The provider's quote has no fee and names its own only on the transfer it takes, so the quote's `providerFeeMinor` is the figure configured for the corridor (`ABROAD_PROVIDER_FEE_<CURRENCY>_<BANK or MOBILE_MONEY>`, `.env.example`), in the sending currency's smallest unit, or null when none is configured. The funds check counts the amount, that fee and, from the naira wallet, WAWU's fee. The receipt carries what the provider really charged (`applicable_fee`); when it is not the configured figure the send is flagged `feeDiffers` for the admin list so the figure can be corrected.

**WAWU's fee when a send does not stand.** A send that fails or is reversed after WAWU's fee was taken gives it back, once: `<reference>-fee-back` from WAWU's account to the person's wallet, the amount the fee leg's own completed record moved. A leg is done only when the provider's record says it completed; a reference the provider failed is replaced (`-2`, then `-3`) in a later pass; three failed references, or a day, hold it for a person with the fee still owed (`wawuFeeBackOwed` on the admin list).

**Fees not set, funds, and deleting an account (round 1).** The quote and the send run `FeesSetGuard` first, like every other quote and money-moving route (NUV-07): `503 fees_not_set` before the wallet gate, the key or the PIN while the running provider's fees are unset. The quote moves nothing, so its documented codes are the gate's, `fees_not_set` and the corridor's; its funds check still answers `402 insufficient_funds` (the amount, the partner's fee and WAWU's fee against the account), which the money-moving coverage spec does not let a quote list. The send documents the full debit set. A send the provider has not finished, or whose WAWU fee is still to be taken or given back, holds an account deletion as `payment_in_progress`; the account data map classes the sends, quotes, recipients and the freeze as the person's own (deleted with them, after an empty wallet) and the admin audit rows as kept, and the data export names them as left out until statements (G-130).

**A fee question always ends (round 2).** WAWU's fee on a send is open until it is taken (and, on a send that did not stand, given back) or closed. The sweep reads, and never makes, the fee leg of a send that failed or was reversed while the leg was still on its way: a leg that completed is marked taken and given back once, one that never completed closes the question quietly (`nothing_taken`), one still on its way a day on is held for a person. A fee that could not be taken from a send that went through is written off after the last try (`not_taken`, a `fee_not_taken` row in `AbroadAdminAudit` by `system`). A give-back or a fee the sweep gives up on is held for a person (`fee_held` row, `feeBackHeld` in the admin list) and stops holding an account deletion, which counts only what the sweep is still trying. Finance finds open ones with `GET /admin/money/abroad/sends?feeOpen=true` and closes one with `POST /admin/money/abroad/sends/{id}/settle-fee` (`outcome` `not_taken` or `paid_back`, a reason; superadmin and finance; one audit row; a repeat changes nothing; `409` for a fee the partner's record shows was taken, a give-back still on its way, a send not decided yet, or nothing owed). The provider's status word is applied with a compare-and-set on the status read, so a cancel that commits in between is never undone, and a fee is not taken from a send already reversed. The quote lists `402 insufficient_funds` again (it reads the balance and moves nothing; `money-moving-coverage.spec.ts` names it).

**From a foreign account (WALLET-42, R-87).** A person with a world wallet has no naira account, so every `/money/abroad` route takes their wallet (the gate hands the seam an empty wallet id and the entity as the customer) and they can send only from a foreign account they hold, in the send's source currency: a quote from the naira wallet is `409 fx_account_not_open` ("You have no naira account. Send from one of your other currency accounts.") and one from a currency they do not hold is the same code ("You do not have a USD account to send from."). A naira person keeps every route as it was and may send from a foreign account of theirs too. WAWU's fee for a person with no naira wallet is taken from the same account, in its own currency: `wawuFeeMinor` on the quote and the send (the naira fee, `wawuFeeKobo`, is then 0), from `abroad.wawu_fee_foreign` per currency and way, charged on top with the partner's fee and counted before the PIN (`insufficient_funds`). A fee in a currency whose collecting account is not configured (`FX_FEE_COLLECTOR_<CODE>_BAN`, the one the swap fee uses) is not offered (`409 currency_not_supported`). It is the same fee legs as the naira fee (`<reference>-fee` to WAWU's collecting account in that currency, `<reference>-fee-back` to the account when the send does not stand, the same reference generations, once each), made through the abroad side's `feeLeg` and found by `findFeeLeg`; a person with a naira wallet is not changed. The naira wallet is never read or moved for a world person. Nuvion's partner fee is charged on top of the amount in the source currency (dev, GBP: 112 pence to Ghana mobile money, 200 pence to a UK bank), and a transfer Nuvion fails returns amount and fee to the account (docs/nuvion/DEV-RESULTS.md in the mobile repo).

**What the app is told, and not.** A send is a row first (`sending`); a lost answer is found again by its reference (`wawu-abroad-<id>`), never sent a second time; a send nobody can find after 30 minutes is `needs_review` and waits for a person. WAWU's fee is taken from the naira wallet after the provider takes the send; one that cannot be taken is tried again by the sweep, never fails the send, and shows as owed in the admin list. An admin cancels only a send the provider never had, at least a minute old, under a row lock; a cancelled send is never reopened.

---

## 31. A wallet for a person outside Nigeria (WALLET-41, R-87)

A person whose country of residence is not Nigeria opens a wallet without a
BVN. Nuvion checks them with their own country's ID document and a liveness
check (the same two steps as section 22 of Open your wallet: the documents
route and the hosted selfie). Their first account is a foreign one; they have
no naira account, and every naira route answers them `409 wallet_not_open`
("You have no naira account. Use your other currency accounts.").
A person in Nigeria keeps the BVN wallet (R-6) and is not touched by any of
this.

| Route | What it does |
| --- | --- |
| `GET /money/world/countries` | the countries a person can say they live in (`code`, English `name`), from the platform's region data, Nigeria among them; cached a day. GEO-02's `GET /geo/countries` replaces it when it lands (G-WALLET-41-5) |
| `GET /money/world/options?country=XX` | what a person living in that country is offered: `available` (and `unavailableReason`), `suggested` (the currency the country is first offered, from config), `choices` (every fiat currency, each `enabled` or not), `openFee` (WAWU's fee to open, `amountMinor` beside `currency`, default 0). Needs no wallet. No provider call |
| `POST /money/wallet/open` | the same route, with `countryCode` (not `NG`) and optionally `firstCurrency` and `nationality`. No `bvn`, `nin` or `checkHandle`. `idType`, `idNumber`, the address and the proof of address are that country's. The phone on the account must carry its country code |
| `GET /money/wallet` | adds `world` (`country`, `firstCurrency`, `state`, `accountOpenedAt`) for such a person. `state` is `open` once the first foreign account is, `account` stays null, `accountNumberStatus` `none`. `review` is the same review as for a Nigerian opening |
| `POST /money/world/first-account` | opens the first account of an approved person when Nuvion's notice has not: it asks Nuvion where the review stands (not our own record), records an approval as the notice would, and opens the account. Body `{ currency? }` changes the first currency while none is open. Answers the wallet, as `GET /money/wallet`. Safe to repeat |
| every `/money/fx/*` route | open to an open wallet of any kind, naira or world: a person outside Nigeria swaps between their foreign accounts and coins and sends coins out with no naira wallet. A swap with a naira side is `409 fx_account_not_open` ("You have no naira account"). Every `/money/abroad` route takes a world wallet too, for a send from a foreign account (section 30, WALLET-42) |

Admin (`/api/hub/admin/money/world`, superadmin and finance only):
`GET openings` (filters `country` and `stage`, a cursor page; no name,
document or number), and `POST openings/{wawuUserId}/freeze`, `/unfreeze` and
`/cancel` (a reason; one audit row each, in the same transaction). A freeze
stops the person's foreign accounts paying out and stops a new one opening; an
unfreeze lets go only of the accounts that freeze froze. A cancel stops an
opening that is not open yet and lets go of its claim on the ID document; an
open wallet is frozen, not cancelled (a cancel of one is `409 wallet_already_open`).

**Residence decides** (round 1; R-87, R-85). The Hub reads the country of
residence the account carries (WAWU ID's `countryCode` claim now, GEO-02's
`/me/location` once it lands), not the request and not the phone. A world
opening needs a stored residence that is not Nigeria, and the `countryCode`
sent must be it: no stored country is `409 residence_not_set`, a person who
lives in Nigeria or names another country is `409 residence_mismatch`, each
with a plain sentence. A person who lives in Nigeria opens with their BVN. A
+234 number abroad is allowed (Nigerians abroad).

**One document, one wallet.** A world opening has no BVN to claim, so it
claims the ID document: the keyed hash of the document's country and the
number with letters and digits only, in upper case, whatever kind of document
is said (held like a BVN's: unique; let go when the opening ends or expires).
The document's country is the `nationality` sent (the passport's issuing
country). A passport without one is `400 passport_country_required` ("Tell us
which country issued your passport.", `reason.fields` `["nationality"]`),
refused before anything is claimed, sent or counted. The form collects no
separate issuing country for a licence or a national ID, so for those the same
field is used and the country of residence stands in when none is sent. Where
the account says it lives does not make a second wallet from the same
passport. The number itself is never stored or logged.
The refusal for a document someone else holds says "ID", never "BVN".

**What Nuvion asks for is Nuvion's to say.** The app asks for the ID document,
the proof of address and the selfie, and for whatever else Nuvion's own refusal
names: a refused opening is `409 account_not_opened` with `reason.fields`, the
names of the fields Nuvion pointed at (for example `person.ssn`), never a
value. Dev asks for nothing beyond the document (docs/nuvion/DEV-RESULTS.md,
WALLET-41); production may ask for a US person's SSN (Nuvion's docs say so).

**Errors.** The usual money errors (section 3) plus `residence_not_set` and `residence_mismatch` (409, above), `passport_country_required` (400, above), `world_switched_off` (409:
the admin switch of the whole product is off), `world_limit_reached` (429: the
day's cap on new openings is reached), `country_not_supported` (422: no
opening is taken from that country), `fx_switched_off` (a currency is off) and
`currency_not_supported` (409: this server's wallet provider holds no foreign
accounts). A provider refusal of the first account is `provider_declined` with
its words (dev: AED for a person in the United Arab Emirates, USD details for
Kenya); the person picks another first currency.

**Config** (all read at start; a bad value stops the server): `WORLD_FIRST_
CURRENCY_MAP` (for example `KE:GHS`) and `WORLD_FIRST_CURRENCY_DEFAULT` (the
table is R-87's by default), `WORLD_OPEN_FEE_<CODE>_MINOR` (default 0, R-10;
quoted by `options`, not yet collected: G-WALLET-41-4), `WORLD_OPEN_DAILY_LIMIT`
(new openings per UTC day, all countries; unset is none) and `WORLD_BLOCKED_
COUNTRIES`. The admin switch is the setting `world.open.on`.
