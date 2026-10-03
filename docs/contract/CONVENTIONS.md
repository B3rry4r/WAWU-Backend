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
(MONEY-11), which reads the caller's wallet from `FintavaWallet` (no row:
`409 wallet_not_open`) and asks Fintava on every request; `GET /money/identity`,
`POST /money/identity/bvn` and `PUT /money/identity/occupation` (KYC-01),
Open your wallet's identity step (section 8). A served route and a declared one may share a
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
  `money-contract.spec.ts` checks every one).
- A balance is only ever Fintava's (`GET /money/wallet/balance`,
  `availableBalance`). No route sums ledger rows and calls the result a
  balance.

## 2. Phone numbers: `+234`, normalised by the server

- **Out:** every phone a money route returns is E.164, `+2348031234567`. A
  masked phone keeps the prefix: `+234 803 *** 4412`.
- **In:** the server accepts any common Nigerian mobile form and normalises
  it before it compares, stores or forwards it: `08031234567`,
  `8031234567`, `2348031234567`, `+2348031234567`, with spaces, dashes and
  brackets ignored. The pattern the backend already validates Nigerian mobiles
  with is `^(\+?234|0)[789][01]\d{8}$` (`src/health-plan/dto/health-plan.dto.ts`);
  the bare 10-digit form is added because people type it.
- **Why the server does it:** nothing normalises a phone today. WAWU ID stores
  it as typed (`register.dto.ts` only checks 7 to 20 characters) and the
  token's `phone` claim carries it as typed (WAWU ID's own tests hold both
  `+2348012345678` and `2348000000001`). So the Hub never trusts the stored
  form: it normalises every phone it reads before comparing.
- A phone matches only in full (recipient search never matches part of a
  number). A value that is not a Nigerian mobile after normalising does not
  match anything; in a field that must be a phone it is a 400.
- Fintava wants its own forms: the phone check takes local `0...`, SMS takes
  `234...`. The Fintava client converts from E.164.

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
| `reset_code_invalid` | 400 | wrong or expired reset code | `triesLeft` |
| `insufficient_funds` | 402 | balance below the total (MONEY-19, W13, H17) | `balanceKobo`, `totalKobo`, `shortfallKobo` |
| `daily_limit_exceeded` | 403 | the send or purchase passes today's limit; stopped before money moves | `totalKobo`, `remainingTodayKobo` |
| `amount_out_of_range` | 400 | below the minimum, or above `MERCHANT_MAX_PER_TXN_KOBO` on money through WAWU's merchant wallet | `minimumKobo`, `maximumKobo` |
| `quote_changed` | 409 | `expectedTotalKobo` differs from the server's total | `feeQuote` or `paymentQuote` |
| `name_check_failed` | 422 | the bank did not confirm the account | |
| `recipient_not_found` | 404 | no such WAWU user | |
| `recipient_has_no_wallet` | 409 | they have not opened a wallet | |
| `recipient_blocked` | 403 | a block between the two people | |
| `self_transfer` | 400 | sending to yourself | |
| `bank_transfers_blocked` | 403 | sending to a bank is not allowed for this person now (W18) | `blockedBy` |
| `target_not_found` | 404 | the thing being paid for does not exist | |
| `target_not_payable` | 409 | it exists but cannot be bought now (already owned, sold out, closed) | |
| `not_found` | 404 | no such transfer, payment, hold or transaction for this caller | |
| `bvn_not_confirmed` | 422 | Fintava did not confirm the BVN (unknown or invalid) (KYC-01) | `checksLeft` |
| `bvn_phone_mismatch` | 422 | the BVN's phone is not the account's phone (A14); nothing from the BVN record is answered | `checksLeft` |
| `phone_not_nigerian` | 422 | the account's phone is not a Nigerian mobile, so no BVN can match it; Fintava is not asked | |
| `identity_checks_exhausted` | 429 | the person has used today's BVN checks | `retryAfterSeconds` |
| `bvn_not_checked` | 409 | A5's occupation, or a selfie match, sent before a BVN check passed; or a selfie match with a BVN other than the one that passed, or one whose BVN check was replaced by another while it was being matched | |
| `wallet_already_open` | 409 | a BVN check or selfie match from someone whose wallet is open | |
| `selfie_not_matched` | 422 | Fintava did not match the selfie to the BVN photo (A16) (KYC-02) | `checksLeft` |
| `selfie_checks_exhausted` | 429 | the person has used today's selfie matches (A16 and the retry rule); Fintava is not asked | `retryAfterSeconds` |
| `selfie_already_matched` | 409 | a selfie match from someone whose selfie already matched against their current BVN check | |
| `selfie_required` | 409 | account opening before a selfie matched against the BVN check whose BVN and NIN were sent (MONEY-12) | |
| `identity_has_wallet` | 409 | account opening for a BVN or phone another WAWU account opened a wallet with, or whose Fintava account another WAWU account holds; nothing is sent | |
| `account_not_opened` | 422 | Fintava refused the details sent (a validation or identity refusal, such as a blacklisted NIN), or the account has no email; nothing was created and the person may try again | |

The same table is `MONEY_ERROR_STATUS` in `src/money/money-contract.ts`; each
operation in the contract lists the codes it can answer with, grouped by
status.

## 4. `Idempotency-Key` on every request that moves money

**Which requests:** `POST /money/transfers/wawu`, `POST /money/transfers/bank`
and `POST /money/payments`, and every money-moving route added later. Without
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
7. Keys are kept for at least 24 hours (MONEY-17 sets the purge in config).

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
  (config, provisional 30). A try is counted before the hash is compared, so
  tries sent at the same moment cannot get past five together. A right PIN
  resets the count; so does the end of a lock; a reset by code
  (`/money/pin/reset/confirm`, MONEY-14) clears the lock.
- **The guard removes the header** from the request once read (`headers` and
  `rawHeaders`), so nothing that runs after it can log or report it. An
  idempotent replay must not check the PIN again (section 4, rule 3), so
  whatever answers replays runs before the guard.
- **Fintava has no wallet PIN** (only card PINs), so this PIN guards WAWU's
  API, not the account at Fintava.
- **Face ID** (W11, W35) is MONEY-14's: a biometric approval on a registered
  device stands in for the PIN. The header name `X-Device-Approval` is
  reserved for it; MONEY-14 declares device registration and the approval
  format, and a debit then carries one of the two headers.
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

## 7. Everything else

- **The caller is the token.** No money route takes the wawuUserId of whose
  wallet to act on (`WalletController`'s rule, kept).
- **No wallet yet** (R-6, MONEY-13): `GET /money/wallet` answers 200 with
  `state: "not_open"` so the Wallet tab can open "Open your wallet"; every
  other money route answers `409 wallet_not_open` (`wallet_opening` while
  the account is being created, `423 wallet_frozen` when frozen).
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
  birth, gender, phone or photo, or the address. The prefill is answered
  once and not kept. The steps after this one take them from the app again:
  MONEY-12's account opening checks the BVN and the NIN with
  `WalletIdentityService.matchesCheckedIdentity` (the NIN is required);
  KYC-02's selfie, sent the BVN only, uses `checkedBvn`.
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
  `beneficiaryCount` is 0 until WALLET-14 serves beneficiaries. While an
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
  asked for a customer with the phone (`/customers/details`): one nobody
  holds is recorded as the person's account instead of making a second; one
  another WAWU account holds is `409 identity_has_wallet`; an answer that
  cannot be read is `503 provider_unreachable` with nothing created.
- **A lost answer** (timeout, 5xx, a 2xx without the customer, or a refusal
  saying the customer exists) leaves the opening `unknown`, answered as
  `opening`. It is reconciled with Fintava on the next open request and by
  a sweep every 30 seconds (also for an `opening` row whose request never
  finished): a customer found for the phone, by `/customers/details` or in
  the newest-first `/customers/list` back to a little before the attempt,
  is recorded as the person's account. It counts as not created only when
  the details lookup gives Fintava's own `404 ["Customer not found"]`
  (`sandbox/32-money12-account.md`) AND the list has no row for the phone
  AND the money timeout plus `FINTAVA_RESEND_SAFETY_MS` has passed since the
  create was sent; then the opening is `failed` and the person's next open
  request sends a new create. Anything else waits: `{}`, `data: null`, any
  other 404, a failed or unreadable list. A found account another WAWU
  account holds leaves the opening `conflict` (shown as `opening`), logged
  for review.
- **Refusals.** A validation refusal or an identity refusal (a blacklisted
  NIN) is `422 account_not_opened`; the merchant gate, a refused key or any
  other refusal is `503 provider_unreachable`. Both leave the opening
  `failed`, and the next request is a new attempt.
- **Without settings.** No `FINTAVA_*` or no `IDENTITY_HASH_KEY`: the open
  answers `503 provider_unreachable` and sends nothing; `GET /money/wallet`
  still answers; the sweep does nothing.
