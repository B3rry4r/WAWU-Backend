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
| `reset_code_invalid` | 400 | wrong or expired reset code | `triesLeft` |
| `insufficient_funds` | 402 | balance below the total (MONEY-19, W13, H17) | `balanceKobo`, `totalKobo`, `shortfallKobo` |
| `daily_limit_exceeded` | 403 | the send or purchase passes today's limit; stopped before money moves | `totalKobo`, `remainingTodayKobo` |
| `amount_out_of_range` | 400 | below the minimum, or above `MERCHANT_MAX_PER_TXN_KOBO` on money through WAWU's merchant wallet | `minimumKobo`, `maximumKobo` |
| `quote_changed` | 409 | `expectedTotalKobo` differs from the server's total | `feeQuote` or `paymentQuote` |
| `name_check_failed` | 422 | the bank did not confirm the account | |
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
| `identity_checks_exhausted` | 429 | the person has used today's BVN checks | `retryAfterSeconds` |
| `bvn_not_checked` | 409 | A5's occupation, or a selfie match, sent before a BVN check passed; or a selfie match with a BVN other than the one that passed, or one whose BVN check was replaced by another while it was being matched | |
| `wallet_already_open` | 409 | a BVN check or selfie match from someone whose wallet is open | |
| `selfie_not_matched` | 422 | Fintava did not match the selfie to the BVN photo (A16) (KYC-02) | `checksLeft` |
| `selfie_checks_exhausted` | 429 | the person has used today's selfie matches (A16 and the retry rule); Fintava is not asked | `retryAfterSeconds` |
| `selfie_already_matched` | 409 | a selfie match from someone whose selfie already matched against their current BVN check | |
| `selfie_required` | 409 | account opening before a selfie matched against the BVN check whose BVN and NIN were sent (MONEY-12) | |
| `identity_has_wallet` | 409 | account opening for a BVN or phone another WAWU account opened a wallet with, or whose Fintava account another WAWU account holds; nothing is sent | |
| `account_not_opened` | 422 | Fintava refused the details sent (a validation or identity refusal, such as a blacklisted NIN), or the account has no email; nothing was created and the person may try again | |
| `reset_codes_exhausted` | 429 | the person or the phone has had today's PIN reset texts (MONEY-14); nothing is sent | `retryAfterSeconds` |
| `device_approval_refused` | 403 | `X-Device-Approval` not accepted: not the registered phone, a wrong signature, a used, expired or another person's challenge, or no phone registered; never uses a PIN try (MONEY-14) | |
| `statement_rate_limited` | 429 | the person has asked for 5 statements in the last minute or 30 in the last hour (`STATEMENT_RATE_LIMITS`, PROVISIONAL), counted after the token is verified (WALLET-27) | `retryAfterSeconds` |
| `statement_busy` | 503 | two statements are already being built and no place came free within 5 s (`STATEMENT_CONCURRENCY`, PROVISIONAL) (WALLET-27) | `retryAfterSeconds` |
| `recipient_search_rate_limited` | 429 | the person has searched for recipients 20 times in the last minute, 120 in the last hour or 500 in the last day (`RECIPIENT_SEARCH_PERSON_LIMITS`, PROVISIONAL), counted after the token is verified (WALLET-08); also sent as the `Retry-After` header | `retryAfterSeconds` |
| `statement_too_large` | 400 | the period holds more movements than one statement lists (`STATEMENT_MAX_ROWS`, 50,000); counted before anything is written, and the person picks a shorter range (WALLET-27) | |
| `phone_held_by_other_identity` | 409 | account opening where Fintava already has a customer for the person's phone whose record does not carry the checked BVN (or carries none): nothing is adopted or created, and the opening stops for review (MONEY-12, BACKEND_GAPS G-37) | |

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
  owner may override. `false` is A21's flag: the account is saved and
  shown as not matching, not refused (mobile repo BACKEND_GAPS G-46 for
  what a withdrawal does with it). `null` when there is nothing to compare
  with: no passed check, no name kept, `IDENTITY_HASH_KEY` unset, the
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
- **Daily limit**: no task holds it (mobile repo BACKEND_GAPS G-7), so
  `withinDailyLimit` is `true` and `remainingTodayKobo` `null`.
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
  quote_changed` with the new quote in `reason.feeQuote`. An unset
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
  BACKEND_GAPS G-68) and sending it by email (the backend has no email
  sender; G-69).

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
