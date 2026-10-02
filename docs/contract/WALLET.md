# The Naira wallet contract

Task MONEY-04, 2 Oct 2026. The routes the mobile wallet screens are built
against, before the Fintava client exists. Rules every route follows (kobo,
`+234`, the error shape, `Idempotency-Key`, the PIN header, cursor pages) are
in [`CONVENTIONS.md`](CONVENTIONS.md). The routes are declared in code
(`src/money/`) and appear in `contract/openapi.json` marked
`x-wawu-served: false` until the task named in `x-wawu-built-by` serves them
(CONVENTIONS.md section 0). Nothing here is wired to Fintava, and no existing
route changed.

Section 3 maps every wallet artboard's data needs to these routes. Section 4
lists where the canvas and Fintava's real behaviour disagree, for the owner
to rule; the contract resolves none of them, it only keeps room for either
answer.

## 1. Routes

All under `/api/hub`, all behind the WAWU ID bearer token, all reading the
caller from the token.

| Method and path | Response (`data`) | Request | Served by |
|---|---|---|---|
| `GET /money/wallet` | `WalletView` | | MONEY-12 (state from MONEY-13, `pin` from MONEY-09, `beneficiaryCount` from WALLET-14) |
| `GET /money/wallet/balance` | `WalletBalanceView` | | MONEY-11 (served) |
| `GET /money/pin` | `PinStateView` | | MONEY-09 |
| `POST /money/pin` | `PinStateView` | `SetPinDto` | MONEY-09 |
| `PUT /money/pin` | `PinStateView` | `ChangePinDto`, `X-Transaction-Pin` (current) | MONEY-09 |
| `POST /money/pin/verify` | `PinStateView` | `X-Transaction-Pin` | MONEY-09 |
| `POST /money/pin/reset` | `PinResetView` | | MONEY-14 |
| `POST /money/pin/reset/confirm` | `PinStateView` | `ConfirmPinResetDto` | MONEY-14 |
| `GET /money/banks` | `BankView[]` | | WALLET-09 |
| `POST /money/banks/name-check` | `AccountNameView` | `NameCheckDto` | WALLET-09 |
| `GET /money/recipients?q=` | `RecipientView[]` (at most 20) | | WALLET-08 |
| `GET /money/recipients/recent` | `RecipientView[]` (at most 10) | | WALLET-08 |
| `GET /money/beneficiaries` | `BeneficiaryView[]` | | WALLET-14 |
| `POST /money/beneficiaries` | `BeneficiaryView` | `CreateBeneficiaryDto` | WALLET-14 |
| `DELETE /money/beneficiaries/{id}` | `null` | | WALLET-14 |
| `GET /money/payout-account` | `PayoutAccountView` or `null` | | WALLET-14 |
| `PUT /money/payout-account` | `PayoutAccountView` | `PayoutAccountDto` | WALLET-14 |
| `GET /money/fees/quote?kind=&amountKobo=` | `FeeQuoteView` | | WALLET-15 |
| `POST /money/transfers/wawu` | `TransferView` | `WawuTransferDto`, `Idempotency-Key`, `X-Transaction-Pin` | WALLET-07 |
| `POST /money/transfers/bank` | `TransferView` | `BankTransferDto`, `Idempotency-Key`, `X-Transaction-Pin` | WALLET-09 |
| `GET /money/transfers/{id}` | `TransferView` | | WALLET-07 |
| `GET /money/payments/quote?kind=&targetId=&amountKobo=` | `PaymentQuoteView` | | MONEY-17 |
| `POST /money/payments` | `PaymentView` | `PaymentDto`, `Idempotency-Key`, `X-Transaction-Pin` | MONEY-17 |
| `GET /money/payments/{id}` | `PaymentView` | | MONEY-19 |
| `GET /money/holds?role=&cursor=&limit=` | `HoldPage` | | MONEY-18 |
| `GET /money/holds/{id}` | `HoldView` | | MONEY-18 |
| `GET /money/transactions?filter=&q=&month=&group=&cursor=&limit=` | `TransactionPage` | | MONEY-15 |
| `GET /money/transactions/summary?month=` | `MonthlySummaryView` | | MONEY-15 |
| `GET /money/transactions/{id}` | `TransactionView` | | MONEY-15 |

A withdrawal (W17) is `POST /money/transfers/bank` to the payout account; it
has no route of its own. Releasing or refunding a hold is never a client
request: the owning feature does it (MONEY-18), so holds are read-only here.
Every refusal each route can give is listed on its operation in the contract,
by status, with the `reason.code` values (CONVENTIONS.md section 3).

### Lead rulings, 2 Oct 2026 (round 2 of MONEY-04)

1. **The ₦10,000,000 cap is the merchant wallet's, and only the merchant
   wallet's.** It is Fintava's per-transaction cap on WAWU's merchant account
   (`limits.md`). It applies only to money that goes through WAWU's merchant
   wallet: wallet payments (`POST /money/payments`, quoted by
   `GET /money/payments/quote`), holds and their release or refund
   (MONEY-18), and payouts from WAWU (WALLET-17, school payouts). It does not
   apply to a customer's own send (`/money/transfers/wawu`,
   `/money/transfers/bank`, a withdrawal); those are bounded by the daily
   limit. The figure is read from config, `MERCHANT_MAX_PER_TXN_KOBO`
   (`.env.example`, `1000000000`), never a constant. Above it the answer is
   `400 amount_out_of_range` with `maximumKobo`, not a plain validation 400:
   request DTOs bound amounts only by what a JSON number carries exactly.
   Refuse, never split: splitting is not built.
2. **A purchase counts toward the daily limit, like a send.** It debits the
   buyer's wallet the same way. `GET /money/payments/quote` carries
   `withinDailyLimit` and `remainingTodayKobo`, and `POST /money/payments`
   declares `403 daily_limit_exceeded`, exactly as the transfers do. Whether
   Fintava's tier limit counts wallet to wallet purchases is Fintava's to
   confirm (section 4, item 4; question 16 in the mobile repo's
   `docs/fintava/naira-api.md`).
3. **History groups what W26 draws as one row.** The canvas decides the UI,
   so the contract serves W26's "Unlock · Lighting night shoots · 3 buyers ·
   +₦7,500.00". The rule, following W26 (rows grouped under a day label):
   - unlock earnings (`category: earning`, link kind `content_unlock`) of the
     **same content piece** on the **same Africa/Lagos day** become one row
     when there are two or more;
   - that row's `amountKobo`, `fee` and `totalKobo` are the sums, its
     `createdAt` is the latest unlock (`group.lastAt`), its `link` is the
     piece, its `description` carries the count, and `group` is
     `{ key, count, firstAt, lastAt }`;
   - `GET /money/transactions?group=<key>` lists the unlocks in it, one per
     row (cursor-paged like the history);
   - nothing else groups: tips, sends, bills, refunds and every money-out row
     stay one row per movement, and `group` is null on them;
   - filters and search see the grouped row (an unlock group is `money_in`
     and `content`); the monthly summary sums movements, so grouping never
     changes it.
   MONEY-15 builds it.

### Pay from wallet: what `targetId` is

`kind` is fixed by this contract. `targetId` is the id the owning feature
hands the app before payment; the column below is what each feature returns
for that today, and the owning task confirms or changes it when it moves its
payment onto the wallet.

| `kind` | Moved by | `targetId` | Payer sets amount | Held (R-19) |
|---|---|---|---|---|
| `content_unlock` | HOME-15 | the content piece id (`POST /content/:id/unlock`) | no | no |
| `tip` | HOME-14 | the creator's wawuUserId (`POST /tips` takes `creatorWawuId`); `note` is the tip's message | yes, `amountKobo` | no |
| `credit_pack` | INBOX-16 | the pack: `starter`, `popular` or `pro` (`POST /credits/purchase`) | no | no |
| `verification` | ME-18 | the tick: `creator` or `professional` | no | no |
| `legal_fee` | LEGAL-05 | the legal request id | no | no |
| `school_fee` | SCHOOLS-07 | the enrolment order id | no | no |
| `paid_dm` | INBOX-17 | the message id `POST /dm/:creatorWawuId/send` returns | no | until the creator answers |
| `event_ticket` | EVENTS-07 | the order id `POST /events/:id/orders` returns | no | until the event takes place |
| `bill` | BILLS-04 | the bill id `POST /bills/init` returns | no | until the biller delivers |

## 2. The named schemas (G-1)

Every success body and every nested object in these routes is a named schema
in `components.schemas`, so the app gets one type per shape:
`WalletView`, `WalletAccountView`, `WalletLimitsView`, `BankTransferAccessView`,
`WalletBalanceView`, `PinStateView`, `PinResetView`, `BankView`,
`AccountNameView`, `RecipientView`, `MoneyPartyView`, `BankAccountView`,
`BeneficiaryView`, `PayoutAccountView`, `FeeBreakdown`, `FeeQuoteView`,
`TransferView`, `TransferTimelineEntry`, `TransferReversalView`,
`PaymentQuoteView`, `PaymentView`, `HoldView`, `HoldPage`, `TransactionView`,
`TransactionCounterpartyView`, `TransactionLinkView`, `TransactionGroupView`,
`TransactionPage`,
`MonthlySummaryView`, and for errors `MoneyErrorEnvelope` and
`MoneyErrorReason`. Request bodies are named too (`SetPinDto`,
`WawuTransferDto`, `BankTransferDto`, `PaymentDto` and the rest).
`src/money/tests/money-contract.spec.ts` fails if a money success body
becomes an inline object.

Every field ending in `Kobo` is `"type": "integer"` (round 2). The rule goes
by name, so it also reaches four served admin finance schemas
(`AdminFinanceMoneyView`, `AdminFinanceStreamTotalsView`,
`AdminFinanceCreditsAttributionView`, `AdminFinanceTransactionView`: 12 fields
that were `number`). Those values are already whole kobo on the wire, and
openapi-typescript generates `number` for both, so no client type and no
response changes; the protected route suite was run again on it.

G-1 for the routes that existed before this task is not done here (section 5).

## 3. Every wallet artboard's data needs, mapped

Artboards are those listed in the mobile repo's `tasks/WALLET-*.md`,
`MONEY-*.md` and `KYC-*.md`. Data needs are the analysis's
(`docs/analysis/evidence/A1.json` to `A4.json`), as changed by the designer
brief (`docs/designer/BRIEF.md`) and the rulings.

### Launch

| Artboard | Data it needs | Contract entry |
|---|---|---|
| W1 Wallet | Naira balance in kobo, from the bank | `GET /money/wallet/balance` → `availableKobo` |
| | account number, bank name ("WAWU · Loma Bank") | `GET /money/wallet` → `account.accountNumber`, `account.bankName` |
| | latest transactions | `GET /money/transactions?limit=3` → `items` |
| | card summary; Dollar and Crypto tabs | after launch (WALLET-22, WALLET-21): not in this contract |
| | bill tiles | the bills routes (`/bills/*`, BILLS tasks): not money-contract data |
| W4 Wallet loading | as W1; account number hidden until the balance loads | the same two reads; the order is the app's |
| W5 New account | open account, account number, ₦0.00, no rows | `GET /money/wallet` → `state: open`, `account`; balance `availableKobo: 0`; `TransactionPage.items: []` |
| W6 Can't reach account | a typed "provider unreachable", tiles still usable | `GET /money/wallet/balance` → `503 provider_unreachable`; `GET /money/wallet` never calls Fintava, so it still answers |
| W7 Send to a WAWU user | search by name, @handle, phone; id, name, handle, avatar, tick | `GET /money/recipients?q=` → `RecipientView` (phone normalised to `+234`, full match only) |
| | recent recipients | `GET /money/recipients/recent` |
| | whether they have a wallet | search returns wallet holders only (WALLET-08 scope); a send to anyone else is `409 recipient_has_no_wallet` |
| W8 Send to a bank | bank list | `GET /money/banks` |
| | name check before Continue | `POST /money/banks/name-check` → `AccountNameView`; `422 name_check_failed` |
| | saved beneficiaries, "My payout account" | `GET /money/beneficiaries`; `GET /money/payout-account` |
| W9 Amount | live balance; recipient; note | `GET /money/wallet/balance`; `RecipientView` from W7; `WawuTransferDto.note` |
| W10 Review | fee breakdown per transfer type; total; "They get" | `GET /money/fees/quote` → `fee` (`providerFeeKobo` + `wawuFeeKobo` = `totalFeeKobo`), `totalKobo`, `amountKobo` |
| W11 PIN | PIN checked on the debit itself; tries left; lock | `X-Transaction-Pin` on the transfer; `403 pin_incorrect.triesLeft`, `423 pin_locked.lockedUntil`; `GET /money/pin` |
| | Face ID instead of the PIN | MONEY-14; header `X-Device-Approval` reserved, routes not declared yet (section 5) |
| W12 Receipt | status, fee, total paid, reference, time | the transfer response, then `GET /money/transfers/{id}` → `TransferView` |
| | Save as beneficiary | `POST /money/beneficiaries` |
| | Share receipt | after launch (WALLET-12) |
| W13 Not enough | balance and the total, server-checked | `GET /money/wallet/balance` with `FeeQuoteView.totalKobo`; on send `402 insufficient_funds` → `balanceKobo`, `totalKobo`, `shortfallKobo` |
| W14 Send failed | final status and reason | `TransferView.status` (`failed`, `reversed`), `failureReason` |
| | what came back, a kept charge as its own row | `TransferView.reversal` → `returnedKobo`, `keptKobo`, `reversedAt` |
| | reference, amount | `reference`, `totalKobo` |
| | Try again | a new `POST /money/transfers/bank` with a new `Idempotency-Key` |
| W15 Add money | account name, number, bank name; licence line | `GET /money/wallet` → `account` (`licenceLine`, `depositInsuranceLine` from config, null hides) |
| | card, USSD, from Dollar | after launch (WALLET-25, WALLET-26, WALLET-21): not in this contract |
| W17 Withdraw | balance | `GET /money/wallet/balance` |
| | default destination with bank code | `GET /money/payout-account` |
| | fee breakdown, "Your bank gets" | `GET /money/fees/quote?kind=bank_transfer` |
| | Withdraw, then PIN | `POST /money/transfers/bank` to the payout account |
| | "Arrives in a few minutes" | nothing backs it: no field (section 4, item 7) |
| W18 Withdraw waiting on KYC | allowed or not, and why | `WalletView.bankTransfers` → `allowed`, `blockedBy`; on send `403 bank_transfers_blocked.blockedBy` |
| | KYC submission date and status | the existing `GET /api/hub/kyc` (not a money route) |
| W19 Withdraw on its way | timeline with a time per step | `TransferView.timeline` (`requested`, `sent_to_bank`, `completed`) |
| | fee breakdown, total paid, reference | `fee`, `totalKobo`, `reference` |
| W26 History | rows across every kind of movement, cursor pages | `GET /money/transactions` → `TransactionPage` |
| | one row for several unlocks of the same piece ("Unlock · Lighting night shoots · 3 buyers · +₦7,500.00") | `TransactionView.group` (`count`, `key`); `GET /money/transactions?group=<key>` lists its unlocks (Lead ruling 3, section 1) |
| | per row: counterparty, avatar, description, signed amount, time | `TransactionView.counterparty`, `description`, `direction` + `totalKobo`, `createdAt` |
| | filter chips; search | `filter` (`all`, `money_in`, `money_out`, `bills`, `content`); `q` |
| | In and Out this month | `GET /money/transactions/summary?month=` → `inKobo`, `outKobo` |
| W27 Transaction detail | type, counterparty, linked content, destination, reference, fee breakdown | `GET /money/transactions/{id}` → `category`, `counterparty`, `link`, `fee`, `reference` |
| | Report a problem (support chat with the reference) | no support route exists: gap (section 5) |
| W28 No results | a filtered, empty month | `filter=bills&month=2026-09` → `items: []` |
| W35 Wallet settings | limits row (fill or hide) | `WalletView.limits` (null hides; section 5: no task fills it yet) |
| | PIN last changed | `WalletView.pin.changedAt` |
| | beneficiaries count | `WalletView.beneficiaryCount` |
| | account details | `WalletView.account` |
| | Face ID toggle | MONEY-14 (section 5) |
| | Cards; Statements | after launch (WALLET-22, WALLET-27); W38 is hidden at launch |
| W36 PIN create | set; confirm | `POST /money/pin` (`pin`, `pinConfirmation`); change is `PUT /money/pin` |
| W37 PIN reset | code to the phone on file, resend timer | `POST /money/pin/reset` → `sentTo`, `resendAvailableAt`, `expiresAt` |
| | code check, then W36 | `POST /money/pin/reset/confirm` (`code`, `newPin`, `newPinConfirmation`) |
| W39 Earnings | earned, by stream, by content | WALLET-16 (`GET /content/mine/earnings` today); not a money-contract route |
| | paid DM money still held for the creator | `GET /money/holds?role=payee` |
| A21 Payout bank | bank list, name check | `GET /money/banks`, `POST /money/banks/name-check` |
| | name against the BVN name | `PayoutAccountView.matchesBvnName` |
| | save | `PUT /money/payout-account` |
| A26 BVN and NIN, A14 BVN phone differs | BVN check, NIN kept for opening, phone compare, checks left | `POST /money/identity/bvn` → `BvnCheckView`; `422 bvn_phone_mismatch` (A14), `bvn_not_confirmed`, `429 identity_checks_exhausted` (KYC-01, CONVENTIONS.md section 8) |
| A5 Confirm your details | name, date of birth, gender from the BVN; occupation | `BvnCheckView.prefill` (answered once, not stored); `PUT /money/identity/occupation`; the address goes to account opening (MONEY-12), not stored |
| A6 Selfie, A16 Face doesn't match | face match against the BVN photo (not a liveness check), retries | `POST /money/identity/selfie` `{ bvn, image }` → `SelfieMatchView`; `422 selfie_not_matched` (A16, with `checksLeft`), `429 selfie_checks_exhausted` (A16 and the retry rule), `409 bvn_not_checked` (KYC-02, CONVENTIONS.md section 8) |
| A7 Matched | face-match result; account being opened | `SelfieMatchView.matchedAt` (KYC-02); `GET /money/identity/selfie`; then `GET /money/wallet` → `state: opening` |
| A8 Wallet open | account name, number, bank name | `GET /money/wallet` → `account` |
| | limit (a row that can hide; no "Tier 1") | `WalletView.limits` (null hides) |
| | Create your transaction PIN | `WalletView.pin.isSet` |
| A9 Create PIN, A10 Confirm PIN | set; a mismatch | `POST /money/pin`; `400 pin_mismatch` (no state drawn; the app shows the message) |
| H14 Unlock sheet (MONEY-03), W10 "Pay from wallet" | price, Fintava's charge, total, balance | `GET /money/payments/quote` → `priceKobo`, `fee`, `totalKobo`, `balanceKobo` |
| | over today's limit, stopped before the PIN | `PaymentQuoteView.withinDailyLimit`, `remainingTodayKobo`; on pay `403 daily_limit_exceeded` (Lead ruling 2) |
| H17 Not enough in wallet | the shortfall including the charge | `PaymentQuoteView.shortfallKobo`; on pay `402 insufficient_funds.shortfallKobo` |
| H15 PIN (MONEY-02) | PIN on the payment; tries; lock | `X-Transaction-Pin` on `POST /money/payments`; `pin_incorrect`, `pin_locked` |
| H18 Couldn't confirm, E10 | still confirming, then paid or reversed | `PaymentView.status: pending`; poll `GET /money/payments/{id}` |
| M13 PIN in Me settings (MONEY-02) | PIN set and check | `GET /money/pin`, `POST /money/pin`, `POST /money/pin/verify` |

### After launch (not in this contract)

W2, W3, W20 to W23 (Dollar, crypto, swap: WALLET-21, WALLET-32, WALLET-33),
W16 (card top-up: WALLET-25), W24, W25 (QR: WALLET-20, WALLET-28), W29 to W34
(cards: WALLET-22, WALLET-31), W38 (statements: WALLET-27), W41 to W43
(receipt sharing: WALLET-12), A17 to A20 (limits and tiers: WALLET-19, held
for the owner by the designer brief). W40 is not built (R-11).

## 4. Where the canvas and Fintava disagree (for the owner)

Listed, not resolved. Each names what the canvas draws, what Fintava does
(with the evidence), and what the contract does so that either ruling fits.

1. **Fees are on top, and the canvas's are not Fintava's.** The canvas draws
   "Fee ₦10.00" on a bank send (W10, W11, W12), "Fee ₦25.00" on a withdrawal
   (W17, W19), "No fee" on an unlock (H14), "Bank transfer · Free" for adding
   money (W15). Fintava charges ₦40 per bank send, ₦23.25 or ₦15.75 per wallet
   to wallet move, ₦100 for electricity and cable (`fees.md`); R-10 adds
   WAWU's fee on top. Not confirmed by any real transfer (merchant inactive,
   `sandbox/13-`, `14-`): what Fintava actually takes, how a dashboard
   merchant charge shows up (`merchantComm` is the likely field), and whether
   receiving money into an account costs anything (the merchant settings
   `staticWalletFee`, `staticWalletCapFee` and `DebitStaticWallet` suggest it
   might; Fintava question 12). The contract carries a `FeeBreakdown` on every
   quote, transfer, payment and history row, filled from config.
2. **Second-leg charges nobody has ruled on.** A purchase moves the buyer's
   money into WAWU's merchant wallet (the buyer pays Fintava's charge, R-10),
   and the creator's 85% then has to move from WAWU's wallet to the creator's
   (R-11): a second wallet to wallet move, charged ₦15.75 to ₦23.25 again.
   The same holds for releasing or refunding a hold (R-19) and for bills
   (`naira-api.md`, "Bills are paid from WAWU's merchant wallet"). Who pays
   that second charge (WAWU, the creator out of the 85%, or the buyer) is not
   ruled. On a ₦500 unlock the creator's ₦425 would cost ₦23.25 to move.
3. **No holds at Fintava.** The canvas treats paid DMs and tickets as money
   held in the payer's own wallet. Fintava cannot reserve part of a balance;
   R-19 moves the price into WAWU's merchant wallet. So the payer's balance
   drops at once (nothing shows as "reserved"), held money counts in WAWU's
   balance, and WAWU's ₦10,000,000 per-transaction cap (`limits.md`) bounds a
   single payment, hold or school-fee payout (refused above it, never split:
   Lead ruling 1). The contract shows holds as their own
   read-only list (`HoldView`, `GET /money/holds`), never inside the balance.
4. **Tiers and limits.** The canvas draws "Tier 1 · Limit ₦300,000 balance"
   (A8) and "Tier 2 account · ₦5,000,000 daily · BVN + NIN verified" (W35),
   "CBN tiers". Fintava's policy (`limits.md`): Tier 1 ₦50,000 a day (BVN),
   Tier 2 ₦500,000 a day (BVN and NIN), Tier 3 ₦5,000,000 a day (BVN, NIN,
   address, face). So the canvas's Tier 2 figure is Fintava's Tier 3, and
   A8's balance cap is not a limit Fintava documents (its limits are daily
   transaction limits). The API reports a tier only for the merchant
   (`TIER_3`, `sandbox/22-`); which tier a new customer gets, and whether the
   API reports it, is unknown. "Open your wallet" already collects everything
   Tier 3 asks for. The contract has `WalletView.limits` (null hides the row)
   and `daily_limit_exceeded`, figures from config. **Purchases:** Lead ruling 2
   counts a wallet purchase toward the daily limit like a send, but Fintava's
   policy only speaks of transaction limits; whether a wallet to wallet
   purchase into WAWU's merchant wallet counts toward the customer's tier
   limit is for Fintava to confirm (question 16).
5. **The bank is Loma Bank, not "Fintava MFB".** The canvas prints "Fintava
   MFB" (W1, W5, W15, W35, A8, W41) and a banner "Licensed by the CBN.
   Deposits insured by NDIC". Fintava's records say "Loma Bank", its bank list
   "LOMA BANK" (code `090620`), its account examples "Iyin Ekiti Microfinance
   Bank Limited (Loma Bank)" (`sandbox/01-`, `11-`, `naira-api.md`). The
   contract returns the bank name Fintava gave when the account opened and
   the licence and deposit-insurance lines from owner config (null hides
   them). Which of Fintava's three spellings to show, and the licence and
   NDIC wording, are the owner's (R-1, Fintava question 5).
6. **Refunds return the price, and reversals may keep a charge.** The canvas
   says "Nothing was taken" and "The full ₦25,010 is back" (W14), and refund
   copy elsewhere promises everything back. R-10's default: a refund returns
   the price, Fintava's charge is not returned. For a failed bank send, two
   things are open: whether Fintava's reversal (`debit_transfer_reversal`,
   payload unseen) returns its own ₦40, and whether WAWU's ₦25 comes back
   (R-10 does not say). The contract reports what actually came back
   (`TransferReversalView.returnedKobo` and `keptKobo`,
   `HoldView.refundedKobo`), never an assumed figure.
7. **Settlement times are not Fintava facts.** "It lands in seconds" (W15),
   "Arrives in a few minutes" (W17), "Usually within minutes" (W19), and W14's
   "the receiving bank did not confirm in time ... reversed automatically".
   Fintava documents none of these; a failed send shows only as a later
   `debit_transfer_reversal` webhook. The contract has no arrival-estimate
   field; W19's timeline steps carry real times only.
8. **A timed-out bank send cannot be retried safely.** W14 offers "Try again".
   `/bank/credit` takes no `CustomerReference` as far as the docs show
   (Fintava question 1), so after a timeout nobody knows whether the money
   left. The contract answers `pending` and MONEY-08 asks Fintava before
   anything is sent again; "Try again" is a new send with a new key, offered
   only once the first is `failed` or `reversed`.
9. **Is there still a KYC gate on bank sends (W18)?** The canvas says KYC
   gates payouts only. Today's code refuses any withdrawal unless the manual
   KYC is approved. With Fintava, everyone with a wallet has already passed
   BVN, NIN, address and a selfie match to open it (R-6). Whether W18 still
   happens is the owner's; the contract keeps `bankTransfers.blockedBy` and
   `bank_transfers_blocked` so either answer fits.
10. **Opening the account needs more than the canvas asks.** Fintava's create
    call requires the NIN and a full address (`naira-api.md`); the canvas
    draws BVN only, and A5 claims state and occupation come "From your BVN"
    (the BVN check returns neither). A6's "blink" is a liveness claim Fintava
    cannot back (a face match only, and a failed match still costs ₦10,
    `sandbox/05-`). Already carried by KYC-01 to KYC-03 and the designer
    brief; listed so the set is complete.
11. **Unconfirmed behaviour the screens assume.** A wallet to wallet send is
    drawn as instant (W12): Fintava's response shows both balances after, but
    none has run. History is drawn as the bank's record (W26): Fintava's
    customer history shape is unseen and its merchant history is cached for
    about 5 minutes, so the contract pages our ledger (MONEY-10) and money paid
    straight into the account appears once the `account_funded` webhook lands
    (WALLET-10).

## 5. Gaps this task found (not done here)

- **Daily limits have no owner task.** `limits.md` wants `TIER_LIMITS` in
  config, the day's limit and what is left on W35 and A8, and a send over it
  stopped before the PIN. The contract has the fields
  (`WalletView.limits`, `FeeQuoteView.withinDailyLimit`,
  `daily_limit_exceeded`), but no launch task fills them. Until one does,
  `limits` is null and the row is hidden.
- **Face ID approval routes** are MONEY-14's to declare (device registration,
  the `X-Device-Approval` format). Not declared here because the approval
  scheme (a device key signature or a biometric-gated secret) is MONEY-14's
  design.
- **The request that opens a wallet** (MONEY-12) is not declared. KYC-01
  settled where the checked identity lives: on the Hub, as keyed hashes and
  last 4 digits only (CONVENTIONS.md section 8), so MONEY-12's request
  carries the BVN, NIN, address and A5's name and date of birth from the app
  again and checks the BVN and NIN with
  `WalletIdentityService.matchesCheckedIdentity`, and that the selfie
  matched after the last BVN check with `SelfieMatchService.selfieMatched`
  (KYC-02). The result is declared
  (`WalletView.state`, `account`).
- **W27 "Report a problem"** needs a support conversation that carries a
  transaction reference; no such route exists in the backend.
- **G-1 for the routes that existed before.** The served contract still
  inlines duplicated shapes: the Flutterwave checkout config is inline on 6
  responses (`bills/init`, `care/subscriptions/init`,
  `legal/requests/{id}/consultation`, `legal/requests/{id}/payment/init`,
  `services/cac/apply`, `events/{id}/orders`) and inside 3 named schemas
  (`DmSendInitResponse`, `ShopCheckoutView`, `VerificationCheckoutView`)
  although `FlutterwaveConfigResponse` exists; Prisma model rows returned
  directly are inlined (one legal request shape 14 times); and the
  `Paginated<T>` shape is inlined 12 times (on the five optional-paging lists
  as a second `oneOf` branch with `items`, although the wire carries an array
  and a `pagination` block). Fixing them retypes protected routes' contract
  entries, so it is a separate task with a V3 run, not part of the wallet
  contract.
- **Nullable named fields on served routes read as never null.** The
  enricher writes `Named | null` as `{ $ref, nullable: true }`; OpenAPI 3.0
  ignores a `$ref`'s siblings, so openapi-typescript generates plain `Named`.
  The wallet contract uses `{ allOf: [{ $ref }], nullable: true }`
  (`scripts/enrich-contract.js`, limited to `src/money/`), which keeps the
  null. Eleven served fields still use the old form and so tell clients a
  nullable field is never null: `BlockedAccount.blockedUser`,
  `DirectMessage.otherParty`, `ServiceApplicationOpsDetailView.submission`,
  `AdminFinanceTransactionView.creator`, `AdminFinanceTransactionView.buyer`,
  `AdminFinanceWalletView.payoutSubaccount`,
  `AdminFinanceWalletDetailView.payoutSubaccount`, `Comment.author`,
  `CommunityMessage.sender`, `IntakeView.brief`, `IntakeDetailView.brief`.
  Correcting them changes generated client types for live routes, so it goes
  with the G-1 task above. (Round 2: the first count said eight and missed
  the three `AdminFinance*` fields.)
