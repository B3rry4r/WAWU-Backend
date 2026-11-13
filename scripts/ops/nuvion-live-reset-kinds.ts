/**
 * NUV-LIVE (R-138): every kind of row that holds a Nuvion id or a `provider` column, and what the one-off
 * command nuvion-live-reset.ts does to it. The schema-walk spec (src/money/tests/ops-nuvion-live-reset-schema-walk
 * .contract.spec.ts) fails when a model with a Nuvion id, a `provider` column or a BVN claim is not classified here.
 *
 * Why relabel and not only close: the Hub's sweeps and reads pick a row by its `provider` column (a server acts only
 * on rows of the provider it runs, src/wallet-provider/provider-rows.ts). The test system and the live system are both
 * `nuvion`, so a test row would be acted on after the keys change. A retired row says `nuvion_test`, which no server
 * runs. Why close as well: some paths read a row by status alone (the payment sweep has no provider filter), so every
 * row in motion is also made final, and its retry timers, review marks and fee-owed flags are cleared.
 *
 * Nothing here calls a provider. The command is database only.
 */

/** The `provider` value a retired row gets. No server runs it (rowProvider() answers `other` for it). */
export const RETIRED_PROVIDER = 'nuvion_test';

/** The words stamped on a row the command closes. No em-dash: a person may read it. */
export const CLOSED_WORDS = 'Closed: the test system was retired.';

export type KindAction =
  /** The row is removed. */
  | 'deleted'
  /** The row is made final with no provider call (cancelled, failed, refunded as test) and relabelled. */
  | 'closed'
  /** Only the `provider` column changes. The row is final already. */
  | 'relabelled'
  /** Only the Nuvion id columns are emptied. The row stays. */
  | 'cleared'
  /** Carries no id of its own; it follows the row it hangs from (named in `why`). */
  | 'follows'
  /** Has a provider-looking column that is not the wallet provider's; not touched. */
  | 'untouched';

export interface Kind {
  action: KindAction;
  why: string;
}

export const KIND_TABLE: Record<string, Kind> = {
  // ---- fee engine (FEE-01) ----
  MoneyFeeRecord: {
    action: 'deleted',
    why: 'One row per test transaction: its amount, fee and what the test provider charged. Gone with the test transactions, so the live fee report starts empty.',
  },
  ProviderRate: {
    action: 'untouched',
    why: "Its `provider` column names whose rate it is (the owner's copy of Nuvion's commercials), not the wallet provider of a row. Rates are configuration and stay.",
  },
  // ---- wallet existence, identity and BVN claims: deleted ----
  FintavaWallet: {
    action: 'deleted',
    why: 'A row of provider nuvion says the person has a wallet. Gone, so the wallet screen answers "no wallet yet" and no balance read goes to Nuvion with a test id.',
  },
  FintavaWalletOpening: {
    action: 'deleted',
    why: 'Holds the BVN hash and phone (both unique) that refuse a second opening. Gone, so the same BVN and phone open again, from the beginning.',
  },
  NuvionEntity: {
    action: 'deleted',
    why: "The person's entity, account and account number at Nuvion's test system. Live Nuvion does not know them.",
  },
  NuvionOnboarding: {
    action: 'deleted',
    why: 'Submission and liveness progress of a test entity. The identity check starts again.',
  },
  NuvionDocument: {
    action: 'deleted',
    why: 'Uploaded-document state of a test entity. Only the state is kept here (the file went to Nuvion), so nothing is lost.',
  },
  WalletIdentity: {
    action: 'deleted',
    why: 'The identity check result (BVN hash, last four, verified phone). R-138: each person does the identity check again on live.',
  },
  SelfieMatchAttempt: {
    action: 'deleted',
    why: 'Selfie attempts tied to the BVN hash of the identity check that starts again.',
  },
  BvnCheckAttempt: {
    action: 'deleted',
    why: 'Attempt counters of the identity check that starts again, so a person is not rate limited by test attempts.',
  },
  NuvionBookTransfer: {
    action: 'deleted',
    why: "A log of book transfers between test accounts (no provider column; its ids are test ids). Removed when either end is a retired entity or WAWU's test operational account.",
  },
  FintavaLedgerEntry: {
    action: 'deleted',
    why: "A person's own ledger rows are deleted: history is read by the current account number, so a live wallet would never show them, but the daily limits add up a person's rows with no account filter. Their reference and notice rows go with them (cascade). WAWU's own account rows (no person) are relabelled and stop pending timers.",
  },
  // ---- money in motion: closed with no provider call, and relabelled ----
  WalletPayment: {
    action: 'closed',
    why: "pending becomes failed; completed and not yet delivered becomes delivered-as-test (fulfilledAt set); open key freed; timers and review marks cleared; relabelled. What was bought stays the buyer's.",
  },
  WalletHold: {
    action: 'closed',
    why: "held becomes refunded-as-test (the table's own refund shape, no transfer), or released-as-test when a release was already chosen (the table forbids changing a chosen action; no transfer, no earning made); relabelled, so no release, refund, host share or event payout can pay it.",
  },
  WalletTransfer: {
    action: 'closed',
    why: 'pending becomes failed; the fee-transfer-due flag is cleared; relabelled.',
  },
  AddMoneySession: {
    action: 'closed',
    why: 'created, awaiting_user and processing become cancelled; fee-collected stamped so no fee is taken; relabelled.',
  },
  EarningSettlement: {
    action: 'deleted',
    why: "Every earning settlement is wallet money of the test system (a sale's payment, or a host share of wallet-bought credits). Deleted, owed or landed, so no sweep, retry or webhook can pay it and the earnings screen shows no test earning.",
  },
  EarningMove: {
    action: 'deleted',
    why: "The day's move of test earnings (the table forbids a provider change). Deleted with its settlements; a landed test move would also block a live move the same Lagos day.",
  },
  EarningDeduction: {
    action: 'relabelled',
    why: 'A debt to be taken from future earnings. A test debt (a community pass refund, or a store SANDBOX purchase) is relabelled so it is never taken from live earnings; the take rows stay. A debt from a refund of a REAL store purchase is real money: it stays, is listed, and is taken from the next live move.',
  },
  StoreEarning: {
    action: 'closed',
    why: 'Only an earning of a store SANDBOX purchase (not Nuvion money, but test money all the same): owed or sending becomes cancelled, relabelled. An earning of a real store purchase is never touched: it stays owed, is listed, and lands on the live wallet of that person (R-11). It holds no Nuvion id.',
  },
  StoreEarningPayout: {
    action: 'closed',
    why: 'Of a store sandbox purchase only: pending becomes cancelled, timers cleared, relabelled. A payout of a REAL store purchase that is not final (paid or cancelled) holds the TEST merchant and destination account numbers and would be sent from them on live: it is never touched, and it REFUSES its person (listed by row). A final one is history and is left alone.',
  },
  PointConversion: {
    action: 'closed',
    why: "held becomes cancelled and the points hold is released back to its lots in the same transaction (the table's own rule, as the service cancels). The table forbids a provider change, and a cancelled row is never selected.",
  },
  CommunityPassRefund: {
    action: 'closed',
    why: 'pending becomes refunded-as-test (settledAt set, notified stamped so no false message goes out); relabelled.',
  },
  SchoolSettlement: {
    action: 'closed',
    why: 'pending, sent or review becomes paid (payout) or refunded (refund) as test; waiting and timers cleared; relabelled.',
  },
  WalletCard: {
    action: 'closed',
    why: 'Any card not cancelled or failed becomes cancelled; fee stamped collected so no fee is taken; relabelled.',
  },
  CapitalOrder: {
    action: 'closed',
    why: 'Any order not in a final state becomes cancelled; the fee owed flag becomes none; the Nuvion order, account and transfer ids are emptied; relabelled.',
  },
  FxOperation: {
    action: 'closed',
    why: 'pending becomes failed; relabelled.',
  },
  FxQuote: {
    action: 'closed',
    why: 'A quote at a test rate: marked used and expired; relabelled.',
  },
  FxAccount: {
    action: 'relabelled',
    why: 'A foreign-currency account at the test system. Reads are by provider, so a relabelled row is not an account on live.',
  },
  FxMovement: {
    action: 'relabelled',
    why: 'A recorded movement at the test system. Final history, relabelled.',
  },
  AbroadSend: {
    action: 'closed',
    why: 'Any send in motion becomes cancelled; the fee give-back and fee settle flags are stamped done so no fee is paid back or taken. No provider column, so it is picked by person.',
  },
  AbroadQuote: {
    action: 'closed',
    why: 'An unused quote is marked used and expired.',
  },
  AbroadRecipient: {
    action: 'closed',
    why: 'Holds a test counterparty and payment detail id. Marked removed, so it is not offered or sent to; the person adds it again on live.',
  },
  // ---- caches of Nuvion ids on a row that stays ----
  MoneyBeneficiary: {
    action: 'cleared',
    why: 'A saved payee. The Nuvion bank code, check time, counterparty and payment detail are emptied, so the name check runs again before the first live send. The payee stays.',
  },
  MoneyPayoutAccount: {
    action: 'cleared',
    why: 'A payout bank account. Same: the cached Nuvion ids and check time are emptied (six columns). The account stays. It is not counted as real money (only its cache is touched).',
  },
  SchoolPayee: {
    action: 'cleared',
    why: "Where a school is paid. Its Nuvion counterparty and payment detail ids (test ids) are emptied; the bank, account and name stay. The first live school payout sends from WAWU's live account and makes a fresh counterparty, and the school's bank name check path (school-payee.service.ts) caches the new ones. The row belongs to a school, not a person, so it is cleared with the unowned rows.",
  },
  // ---- logs of the test system ----
  MoneyCheckRun: {
    action: 'relabelled',
    why: "The nightly check's own log. Relabelled so tonight's run on live is not suppressed by the unique (provider, night, sequence), and a running test lease is never resumed.",
  },
  NuvionReconcileFinding: {
    action: 'closed',
    why: 'An open finding about a test account is resolved (resolvedAt set). History stays.',
  },
  NuvionWebhookEvent: {
    action: 'closed',
    why: 'A stored delivery from the test system that is pending or failed is marked processed with a note and its retry and claim cleared, so the dispatcher never replays it. History stays.',
  },
  // ---- rows that follow a row above ----
  WalletPaymentFx: {
    action: 'follows',
    why: "The currency side of a WalletPayment. Its fee sweep selects by the payment's provider and status, both closed above.",
  },
  MoneyReceipt: {
    action: 'deleted',
    why: 'A receipt code of a ledger row that is deleted.',
  },
  // ---- provider-looking columns that are not the wallet provider's ----
  AccountDeletion: {
    action: 'untouched',
    why: 'The audit record; walletProvider only names the provider.',
  },
  BillPayment: {
    action: 'untouched',
    why: "Flutterwave bill (providerReference is the biller's). Real money.",
  },
  HealthSubscription: {
    action: 'untouched',
    why: 'Flutterwave plan (providerReference). Real money.',
  },
  EventOrder: {
    action: 'untouched',
    why: "paymentProvider names who took the payment. A ticket paid from a wallet is held in a WalletHold, closed above; the order and the ticket stay the buyer's.",
  },
  WalletBill: {
    action: 'follows',
    why: "A bill (fintavaTransactionId, fintavaReference are Fintava's purchase record). Bills ride on Fintava only (R-45): a Nuvion server answers a bill target_not_payable, so no Nuvion-era bill exists. A bill has no provider column; its late-success look joins the bill's WalletPayment and acts only on that payment's provider, and its delivery runs from the payment. Probed in ops-nuvion-live-reset-bills.contract.spec.ts: a bill hung on a retired payment is neither looked for nor delivered.",
  },
  PaymentWebhookReceipt: {
    action: 'untouched',
    why: "A Flutterwave delivery log keyed by tx_ref (transactionId is Flutterwave's). Real money, not a Nuvion row.",
  },
  StorePurchase: {
    action: 'untouched',
    why: "The store's own transaction id (storeTransactionId), App Store or Play. Not a wallet provider id. A purchase the store marked sandbox has its earnings cancelled (StoreEarning, StoreEarningPayout); the purchase stays.",
  },
  FintavaWebhookEvent: {
    action: 'untouched',
    why: "A stored delivery from Fintava (fintavaStatus is Fintava's). Not a Nuvion row; the Fintava webhook is not run on a Nuvion server.",
  },
  PlanSettingNuvionFixBackup: {
    action: 'untouched',
    why: 'A backup of plan settings written by a past fix; no id, no money.',
  },
  EmailRecipient: {
    action: 'untouched',
    why: "providerId is the email provider's id.",
  },
  EmailEvent: {
    action: 'untouched',
    why: "Resend email delivery events; providerId is the email's id at Resend.",
  },
  AiToolJob: {
    action: 'untouched',
    why: 'providerRef is an AI vendor job id.',
  },
  AiClonedVoice: {
    action: 'untouched',
    why: 'providerVoiceId is an AI vendor id.',
  },
  ReceptionistAgent: {
    action: 'untouched',
    why: 'providerAgentId is an AI vendor id.',
  },
  ReceptionistKnowledge: {
    action: 'untouched',
    why: 'providerDocId is an AI vendor id.',
  },
  MoviePartnerMovie: {
    action: 'untouched',
    why: 'provider is the movie catalogue source.',
  },
  MoviePartnerSync: {
    action: 'untouched',
    why: 'provider is the movie catalogue source.',
  },
  MoviePartnerLink: {
    action: 'untouched',
    why: 'provider is the movie catalogue source.',
  },
  MoviePartnerConsent: {
    action: 'untouched',
    why: 'provider is the movie catalogue source.',
  },
};

export type Mode = 'persons' | 'orphans';

/** The Hub rows of one table that the command touches, in one SQL statement. */
export interface Step {
  /** Stable id used in counts. */
  id: string;
  model: string;
  verb: 'delete' | 'update';
  /** Quoted table name. */
  table: string;
  /**
   * SQL columns (qualified by nothing) that name the person. The rows picked are those where ANY names a person in the
   * set (mode persons), or where NONE does (mode orphans, with the set being the kept people).
   */
  party: string[];
  /** The guard that makes a second run find nothing and keeps real money out. No party condition here. */
  base: string;
  /** For an update: the SET list. */
  set?: string;
  /** A step that only runs for a person (rows with no provider column, or identity rows). Never for the unowned rows. */
  personOnly?: boolean;
  /** Not used to find people (a child table, or one with no party of its own). */
  noDiscover?: boolean;
  /** Replaces the party columns when finding people (a subquery). */
  discover?: string;
}

const P = `"provider" = 'nuvion'`;
export const SANDBOX_STORE_PURCHASES = `SELECT "id" FROM "StorePurchase" WHERE "environment" = 'sandbox'`;
const WORDS = `'${CLOSED_WORDS}'`;
const R = `'${RETIRED_PROVIDER}'`;
const caseHeld = (held: string, other: string, to: string) =>
  `CASE WHEN ${held} THEN ${to} ELSE ${other} END`;

/**
 * Order matters: children before parents, deletes of rows other rows reference before the rows they reference, and
 * each update that selects by `provider = 'nuvion'` is the last to touch the row.
 */
export const STEPS: Step[] = [
  {
    id: 'fee_records',
    model: 'MoneyFeeRecord',
    verb: 'delete',
    table: '"MoneyFeeRecord"',
    party: [],
    base: 'TRUE',
    noDiscover: true,
  },
  {
    id: 'book_transfers',
    model: 'NuvionBookTransfer',
    verb: 'delete',
    table: '"NuvionBookTransfer"',
    party: [],
    base: 'TRUE',
    noDiscover: true,
  },
  {
    id: 'ledger_receipts',
    model: 'MoneyReceipt',
    verb: 'delete',
    table: '"MoneyReceipt"',
    party: [],
    base: `"entryId" IN (SELECT "id" FROM "FintavaLedgerEntry" WHERE "walletKind" = 'user' AND ${P} AND __LEDGER_PARTY__)`,
    noDiscover: true,
  },
  {
    id: 'ledger_user_rows',
    model: 'FintavaLedgerEntry',
    verb: 'delete',
    table: '"FintavaLedgerEntry"',
    party: ['"wawuUserId"'],
    base: `"walletKind" = 'user' AND ${P}`,
  },
  {
    id: 'ledger_own_account_rows',
    model: 'FintavaLedgerEntry',
    verb: 'update',
    table: '"FintavaLedgerEntry"',
    party: ['"wawuUserId"'],
    base: P,
    set: `"provider" = ${R}, "nextCheckAt" = NULL`,
    noDiscover: true,
  },
  {
    id: 'earning_settlements',
    model: 'EarningSettlement',
    verb: 'delete',
    table: '"EarningSettlement"',
    party: ['"payeeWawuUserId"'],
    base: P,
  },
  {
    id: 'earning_moves',
    model: 'EarningMove',
    verb: 'delete',
    table: '"EarningMove"',
    party: ['"payeeWawuUserId"'],
    base: P,
  },
  {
    id: 'earning_deductions',
    model: 'EarningDeduction',
    verb: 'update',
    table: '"EarningDeduction"',
    party: ['"payeeWawuUserId"'],
    // Test money only: a debt from a community pass refund (a wallet row), or from a store SANDBOX purchase. A debt from
    // a refund of a real store purchase is real money and stays (stayingRows in nuvion-live-reset.ts lists it).
    base: `${P} AND ("passRefundId" IS NOT NULL OR "storePurchaseId" IN (${SANDBOX_STORE_PURCHASES}))`,
    set: `"provider" = ${R}`,
  },
  {
    id: 'store_payouts',
    model: 'StoreEarningPayout',
    verb: 'update',
    table: '"StoreEarningPayout"',
    party: ['"payeeWawuUserId"'],
    base: `${P} AND "storeEarningId" IN (SELECT e."id" FROM "StoreEarning" e WHERE e."storePurchaseId" IN (${SANDBOX_STORE_PURCHASES}))`,
    set: `"status" = ${caseHeld(`"status" = 'pending'`, `"status"`, `'cancelled'`)}, "nextAttemptAt" = NULL, "reviewSince" = NULL, "waiting" = NULL, "provider" = ${R}`,
  },
  {
    id: 'store_earnings',
    model: 'StoreEarning',
    verb: 'update',
    table: '"StoreEarning"',
    party: ['"payeeWawuUserId"'],
    base: `${P} AND "storePurchaseId" IN (${SANDBOX_STORE_PURCHASES})`,
    set: `"status" = ${caseHeld(`"status" IN ('owed', 'sending')`, `"status"`, `'cancelled'`)}, "cancelledAt" = ${caseHeld(`"status" IN ('owed', 'sending')`, `"cancelledAt"`, 'now()')}, "cancelReason" = ${caseHeld(`"status" IN ('owed', 'sending')`, `"cancelReason"`, `'nuvion_live_reset'`)}, "provider" = ${R}`,
  },
  {
    id: 'pass_refunds',
    model: 'CommunityPassRefund',
    verb: 'update',
    table: '"CommunityPassRefund"',
    party: ['"userWawuId"', '"hostWawuId"'],
    base: P,
    set: `"status" = 'refunded', "settledAt" = COALESCE("settledAt", now()), "waiting" = NULL, "nextAttemptAt" = NULL, "reviewSince" = NULL, "notifiedAt" = COALESCE("notifiedAt", now()), "provider" = ${R}`,
  },
  {
    id: 'school_settlements',
    model: 'SchoolSettlement',
    verb: 'update',
    table: '"SchoolSettlement"',
    party: [],
    base: `${P} AND "enrolmentId" IN (SELECT "id" FROM "SchoolEnrolment" WHERE __SCHOOL_PARTY__)`,
    set: `"status" = ${caseHeld(`"status" IN ('pending', 'sent', 'review')`, `"status"`, `CASE WHEN "action" = 'refund' THEN 'refunded' ELSE 'paid' END`)}, "paidAt" = ${caseHeld(`"status" IN ('pending', 'sent', 'review') AND "action" <> 'refund'`, `"paidAt"`, 'now()')}, "refundedAt" = ${caseHeld(`"status" IN ('pending', 'sent', 'review') AND "action" = 'refund'`, `"refundedAt"`, 'now()')}, "waiting" = NULL, "nextAttemptAt" = NULL, "reviewNote" = ${caseHeld(`"status" IN ('pending', 'sent', 'review')`, `"reviewNote"`, WORDS)}, "provider" = ${R}`,
    discover: `SELECT "wawuUserId" AS id FROM "SchoolEnrolment" WHERE "id" IN (SELECT "enrolmentId" FROM "SchoolSettlement" WHERE ${P})`,
  },
  {
    id: 'holds',
    model: 'WalletHold',
    verb: 'update',
    table: '"WalletHold"',
    party: ['"payerWawuUserId"', '"payeeWawuUserId"'],
    base: P,
    // A hold's action never changes once chosen (the table's trigger): a release in motion closes as released (no transfer), anything else as refunded.
    set: `"status" = ${caseHeld(`"status" = 'held'`, `"status"`, `CASE WHEN "action" = 'release' THEN 'released' ELSE 'refunded' END`)}, "action" = ${caseHeld(`"status" = 'held'`, `"action"`, `COALESCE("action", 'refund')`)}, "refundedKobo" = ${caseHeld(`"status" = 'held' AND "action" IS DISTINCT FROM 'release'`, `"refundedKobo"`, `"amountKobo"`)}, "settledAt" = ${caseHeld(`"status" = 'held'`, `"settledAt"`, 'now()')}, "actionReason" = ${caseHeld(`"status" = 'held'`, `"actionReason"`, `'nuvion_live_reset'`)}, "actionAt" = ${caseHeld(`"status" = 'held'`, `"actionAt"`, 'now()')}, "nextAttemptAt" = NULL, "reviewSince" = NULL, "waiting" = NULL, "provider" = ${R}`,
  },
  {
    id: 'payments',
    model: 'WalletPayment',
    verb: 'update',
    table: '"WalletPayment"',
    party: ['"payerWawuUserId"', '"payeeWawuUserId"'],
    base: P,
    set: `"status" = ${caseHeld(`"status" = 'pending'`, `"status"`, `'failed'`)}, "failureReason" = ${caseHeld(`"status" = 'pending'`, `"failureReason"`, WORDS)}, "fulfilledAt" = ${caseHeld(`"status" = 'completed' AND "fulfilledAt" IS NULL`, `"fulfilledAt"`, 'now()')}, "openKey" = NULL, "nextCheckAt" = NULL, "nextDeliveryAt" = NULL, "reviewSince" = NULL, "chargeReviewSince" = NULL, "debitReviewSince" = NULL, "provider" = ${R}`,
  },
  {
    id: 'transfers',
    model: 'WalletTransfer',
    verb: 'update',
    table: '"WalletTransfer"',
    party: ['"payerWawuUserId"', '"recipientWawuUserId"'],
    base: P,
    set: `"status" = ${caseHeld(`"status" = 'pending'`, `"status"`, `'failed'`)}, "failedAt" = ${caseHeld(`"status" = 'pending'`, `"failedAt"`, 'now()')}, "failureReason" = ${caseHeld(`"status" = 'pending'`, `"failureReason"`, WORDS)}, "feeTransferDue" = ${caseHeld(`"feeTransferDue" IS TRUE`, `"feeTransferDue"`, 'FALSE')}, "nextCheckAt" = NULL, "reviewSince" = NULL, "debitReviewSince" = NULL, "provider" = ${R}`,
  },
  {
    id: 'add_money',
    model: 'AddMoneySession',
    verb: 'update',
    table: '"AddMoneySession"',
    party: ['"wawuUserId"'],
    base: P,
    set: `"status" = ${caseHeld(`"status" IN ('created', 'awaiting_user', 'processing')`, `"status"`, `'cancelled'`)}, "feeCollectedAt" = COALESCE("feeCollectedAt", now()), "provider" = ${R}`,
  },
  {
    id: 'cards',
    model: 'WalletCard',
    verb: 'update',
    table: '"WalletCard"',
    party: ['"wawuUserId"'],
    base: P,
    set: `"state" = ${caseHeld(`"state" NOT IN ('cancelled', 'failed')`, `"state"`, `'cancelled'`)}, "cancelledAt" = ${caseHeld(`"state" NOT IN ('cancelled', 'failed') AND "cancelledAt" IS NULL`, `"cancelledAt"`, 'now()')}, "feeCollectedAt" = COALESCE("feeCollectedAt", now()), "provider" = ${R}`,
  },
  {
    id: 'capital_orders',
    model: 'CapitalOrder',
    verb: 'update',
    table: '"CapitalOrder"',
    party: ['"wawuUserId"'],
    base: P,
    set: `"state" = ${caseHeld(`"state" NOT IN ('expired', 'rejected', 'cancelled', 'failed')`, `"state"`, `'cancelled'`)}, "cancelledAt" = ${caseHeld(`"state" NOT IN ('expired', 'rejected', 'cancelled', 'failed') AND "cancelledAt" IS NULL`, `"cancelledAt"`, 'now()')}, "feeState" = ${caseHeld(`"feeState" = 'owed'`, `"feeState"`, `'none'`)}, "nuvionOrderId" = NULL, "capitalAccountId" = NULL, "userCapitalAccountId" = NULL, "purchaseTransferId" = NULL, "payoutTransferId" = NULL, "provider" = ${R}`,
  },
  {
    id: 'fx_operations',
    model: 'FxOperation',
    verb: 'update',
    table: '"FxOperation"',
    party: ['"wawuUserId"'],
    base: P,
    set: `"status" = ${caseHeld(`"status" = 'pending'`, `"status"`, `'failed'`)}, "failureReason" = ${caseHeld(`"status" = 'pending'`, `"failureReason"`, WORDS)}, "provider" = ${R}`,
  },
  {
    id: 'fx_quotes',
    model: 'FxQuote',
    verb: 'update',
    table: '"FxQuote"',
    party: ['"wawuUserId"'],
    base: P,
    set: `"usedAt" = COALESCE("usedAt", now()), "expiresAt" = LEAST("expiresAt", now()), "provider" = ${R}`,
  },
  {
    id: 'fx_movements',
    model: 'FxMovement',
    verb: 'update',
    table: '"FxMovement"',
    party: ['"wawuUserId"'],
    base: P,
    set: `"provider" = ${R}`,
  },
  {
    id: 'fx_accounts',
    model: 'FxAccount',
    verb: 'update',
    table: '"FxAccount"',
    party: ['"wawuUserId"'],
    base: P,
    set: `"provider" = ${R}`,
  },
  {
    id: 'abroad_sends',
    model: 'AbroadSend',
    verb: 'update',
    table: '"AbroadSend"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: `("status" IN ('sending', 'pending', 'needs_review') OR "feeGivenBackAt" IS NULL OR "feeSettledAt" IS NULL OR "feeBackHeldAt" IS NOT NULL)`,
    set: `"status" = ${caseHeld(`"status" IN ('sending', 'pending', 'needs_review')`, `"status"`, `'cancelled'`)}, "feeGivenBackAt" = COALESCE("feeGivenBackAt", now()), "feeSettledAt" = COALESCE("feeSettledAt", now()), "feeBackHeldAt" = NULL`,
  },
  {
    id: 'abroad_quotes',
    model: 'AbroadQuote',
    verb: 'update',
    table: '"AbroadQuote"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: `"usedAt" IS NULL AND "expiresAt" > now()`,
    set: `"usedAt" = now(), "expiresAt" = LEAST("expiresAt", now())`,
  },
  {
    id: 'abroad_recipients',
    model: 'AbroadRecipient',
    verb: 'update',
    table: '"AbroadRecipient"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: `"removedAt" IS NULL`,
    set: `"removedAt" = now()`,
  },
  {
    id: 'beneficiary_ids',
    model: 'MoneyBeneficiary',
    verb: 'update',
    table: '"MoneyBeneficiary"',
    party: ['"ownerWawuId"'],
    personOnly: true,
    base: `("nuvionBankCode" IS NOT NULL OR "nuvionCheckedAt" IS NOT NULL OR "nuvionCounterpartyId" IS NOT NULL OR "nuvionPaymentDetailId" IS NOT NULL)`,
    set: `"nuvionBankCode" = NULL, "nuvionCheckedAt" = NULL, "nuvionCounterpartyId" = NULL, "nuvionPaymentDetailId" = NULL`,
  },
  {
    id: 'payout_account_ids',
    model: 'MoneyPayoutAccount',
    verb: 'update',
    table: '"MoneyPayoutAccount"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: `("nuvionBankCode" IS NOT NULL OR "nuvionCheckedAt" IS NOT NULL OR "nuvionCounterpartyId" IS NOT NULL OR "nuvionPaymentDetailId" IS NOT NULL OR "nuvionOperationalCounterpartyId" IS NOT NULL OR "nuvionOperationalPaymentDetailId" IS NOT NULL)`,
    set: `"nuvionBankCode" = NULL, "nuvionCheckedAt" = NULL, "nuvionCounterpartyId" = NULL, "nuvionPaymentDetailId" = NULL, "nuvionOperationalCounterpartyId" = NULL, "nuvionOperationalPaymentDetailId" = NULL`,
  },
  // ---- wallet existence, identity and BVN claims (last) ----
  {
    id: 'nuvion_documents',
    model: 'NuvionDocument',
    verb: 'delete',
    table: '"NuvionDocument"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: 'TRUE',
  },
  {
    id: 'nuvion_onboarding',
    model: 'NuvionOnboarding',
    verb: 'delete',
    table: '"NuvionOnboarding"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: 'TRUE',
  },
  {
    id: 'nuvion_entities',
    model: 'NuvionEntity',
    verb: 'delete',
    table: '"NuvionEntity"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: 'TRUE',
  },
  {
    id: 'wallets',
    model: 'FintavaWallet',
    verb: 'delete',
    table: '"FintavaWallet"',
    party: ['"wawuUserId"'],
    base: P,
  },
  {
    id: 'openings',
    model: 'FintavaWalletOpening',
    verb: 'delete',
    table: '"FintavaWalletOpening"',
    party: ['"wawuUserId"'],
    base: P,
  },
  {
    id: 'wallet_identity',
    model: 'WalletIdentity',
    verb: 'delete',
    table: '"WalletIdentity"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: 'TRUE',
    noDiscover: true,
  },
  {
    id: 'selfie_attempts',
    model: 'SelfieMatchAttempt',
    verb: 'delete',
    table: '"SelfieMatchAttempt"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: 'TRUE',
    noDiscover: true,
  },
  {
    id: 'bvn_check_attempts',
    model: 'BvnCheckAttempt',
    verb: 'delete',
    table: '"BvnCheckAttempt"',
    party: ['"wawuUserId"'],
    personOnly: true,
    base: 'TRUE',
    noDiscover: true,
  },
  // ---- ids cached on a row that belongs to no person ----
  {
    id: 'school_payee_ids',
    model: 'SchoolPayee',
    verb: 'update',
    table: '"SchoolPayee"',
    party: [],
    base: `("counterpartyId" IS NOT NULL OR "paymentDetailId" IS NOT NULL)`,
    set: `"counterpartyId" = NULL, "paymentDetailId" = NULL`,
    noDiscover: true,
  },
  // ---- logs of the test system (no person) ----
  {
    id: 'money_check_runs',
    model: 'MoneyCheckRun',
    verb: 'update',
    table: '"MoneyCheckRun"',
    party: [],
    base: P,
    set: `"provider" = ${R}`,
    noDiscover: true,
  },
  {
    id: 'reconcile_findings',
    model: 'NuvionReconcileFinding',
    verb: 'update',
    table: '"NuvionReconcileFinding"',
    party: [],
    base: `"resolvedAt" IS NULL`,
    set: `"resolvedAt" = now()`,
    noDiscover: true,
  },
  {
    id: 'webhook_events',
    model: 'NuvionWebhookEvent',
    verb: 'update',
    table: '"NuvionWebhookEvent"',
    party: [],
    base: `"processingStatus" IN ('pending', 'failed')`,
    set: `"processingStatus" = 'processed', "note" = ${WORDS}, "nextAttemptAt" = NULL, "claimedUntil" = NULL, "processedAt" = COALESCE("processedAt", now())`,
    noDiscover: true,
  },
];

/** The points cash-out step has its own code (it releases a hold through the points service). */
export const POINT_CONVERSION_STEP = 'point_conversions';

/** Every model a step or a kind names; a step's model must be a kind. */
export function stepModels(): string[] {
  return [...new Set(STEPS.map((s) => s.model))];
}
