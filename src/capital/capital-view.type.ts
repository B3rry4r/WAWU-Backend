/**
 * What the Capital routes answer (task NUV-12, R-84). Every amount is whole
 * kobo (Capital is naira only until the other currency accounts are built).
 * A rate is the provider's own decimal (0.18 is 18% a year). A figure the
 * provider did not give is `null`, never zero. Nothing here is a balance:
 * the wallet's balance is read from the provider on its own route.
 */

export type CapitalProductKind = 'fixed_return' | 'share_offering';

export interface CapitalDeductibleView {
  name: string;
  /** A fraction for `percentage` (0.1 is 10%), or whole kobo for `flat`. */
  value: number;
  valueType: 'flat' | 'percentage';
  appliesTo: 'principal' | 'interest';
}

export interface CapitalRateBandView {
  name: string;
  rate: number;
  minKobo: number | null;
  maxKobo: number | null;
}

export interface CapitalDocumentView {
  name: string;
  /** A hosted page or file; the app opens it in the browser. */
  url: string;
}

/** One product, with the terms the provider states. */
export interface CapitalProductView {
  id: string;
  kind: CapitalProductKind;
  name: string;
  /** The smallest and largest amount the product takes (the provider's terms). */
  minKobo: number | null;
  maxKobo: number | null;
  /** Fixed return: days the money is held. */
  tenorDays: number | null;
  /** Fixed return: the yearly rate, 0.18 for 18%. The top band when bands exist. */
  annualRate: number | null;
  rateBands: CapitalRateBandView[];
  /** Fixed return: whether leaving early is allowed, and from which day. Null when the provider does not say. */
  allowEarlyWithdrawal: boolean | null;
  earliestWithdrawalDays: number | null;
  deductibles: CapitalDeductibleView[];
  /** The sale window, when the provider sets one. */
  opensAt: string | null;
  closesAt: string | null;
  /** Share offering. */
  issuerName: string | null;
  offerPriceKobo: number | null;
  lockPeriodDays: number | null;
  /** Whether an order can be started now, and why not when it cannot. */
  orderable: boolean;
  notOrderableReason:
    'sold_out' | 'sale_closed' | 'not_open_yet' | 'unavailable' | null;
  /** Detail view only: every document the person agrees to when ordering. */
  documents: CapitalDocumentView[];
}

export interface CapitalProductPageView {
  items: CapitalProductView[];
  nextCursor: string | null;
}

/** What WAWU's settings add to a product: the limits and the fee rule (zero by default). */
export interface CapitalTermsView {
  /** WAWU's own limits on one order, null when none is set. */
  wawuMinKobo: number | null;
  wawuMaxKobo: number | null;
  /** WAWU's fee on top of the order: a flat amount and a share in basis points. Both 0 when there is no fee. */
  wawuFeeFlatKobo: number;
  wawuFeeBasisPoints: number;
}

export interface CapitalProductDetailView extends CapitalProductView {
  terms: CapitalTermsView;
}

/** The terms the provider locked when the order was reserved. */
export interface CapitalQuoteView {
  /** What leaves the wallet for the product. */
  totalDebitKobo: number;
  principalKobo: number | null;
  tenorDays: number | null;
  lockedRate: number | null;
  /** The rate applies for the whole term: true when the person chose to lock the money (no early exit). */
  locked: boolean | null;
  allowEarlyWithdrawal: boolean | null;
  earliestWithdrawalDays: number | null;
  /** The share of interest taken on an early exit, 0.25 for 25%. */
  penaltyRate: number | null;
  deductibles: CapitalDeductibleView[];
  /** Share offering. */
  requestedShares: number | null;
  allocatedShares: number | null;
  unallocatedKobo: number | null;
  offerPriceKobo: number | null;
  baseCostKobo: number | null;
  brokerageFeeKobo: number | null;
  crossDealFeeKobo: number | null;
  lockPeriodDays: number | null;
}

/**
 * Where an order stands, in one word for the screen:
 * - `reserved`: held for the person for a few minutes, nothing taken yet;
 * - `confirming`: the PIN was accepted, the provider is finishing;
 * - `invested`: the money is in the product;
 * - `matured`: the term is over and the payout can be started;
 * - `paying_out`: a payout has started and is being settled;
 * - `paid_out`: the payout (or refund) has been settled;
 * - `expired`, `rejected`, `cancelled`, `failed`: nothing was taken;
 * - `review`: the provider is checking the order; nothing more to do.
 */
export type CapitalOrderStatus =
  | 'reserved'
  | 'confirming'
  | 'invested'
  | 'matured'
  | 'paying_out'
  | 'paid_out'
  | 'expired'
  | 'rejected'
  | 'cancelled'
  | 'failed'
  | 'review';

/** Why a withdrawal cannot be started now. */
export type CapitalWithdrawBlock =
  | 'too_early'
  | 'locked'
  | 'not_allowed'
  | 'in_progress'
  | 'frozen'
  | 'not_invested'
  | 'not_for_this_product';

/** The holding an approved order opened. */
export interface CapitalHoldingView {
  /** Last four digits of the holding's number. */
  numberLast4: string | null;
  /** The provider's word for the state (ACTIVE, MATURED, ...), for support. */
  lifecycle: string | null;
  payoutStatus: 'pending' | 'completed' | 'failed' | null;
  principalKobo: number | null;
  lockedRate: number | null;
  tenorDays: number | null;
  startedAt: string | null;
  maturesAt: string | null;
  /** From this moment an early exit may be asked for; null when it cannot be. */
  earlyExitFrom: string | null;
  /** Interest earned so far, as the provider works it out now. */
  accruedKobo: number | null;
  /** What the provider projects at maturity. These are the provider's figures, not a promise by WAWU. */
  expectedGrossInterestKobo: number | null;
  expectedDeductionsKobo: number | null;
  expectedPayoutKobo: number | null;
  /** The payout once a withdrawal has been started. */
  payoutKobo: number | null;
  settlesAt: string | null;
  /** Share offering. */
  sharesPurchased: number | null;
  unitsHeld: number | null;
  costKobo: number | null;
  lockEndsAt: string | null;
  currentValueKobo: number | null;
  pendingRefundKobo: number | null;
}

export interface CapitalOrderView {
  id: string;
  status: CapitalOrderStatus;
  productId: string;
  productName: string;
  kind: CapitalProductKind;
  /** What the person asked to invest. */
  amountKobo: number;
  /** The provider's quote, once reserved. */
  quote: CapitalQuoteView | null;
  /** WAWU's fee, 0 unless the owner has set one. */
  feeKobo: number;
  /** What the wallet is debited in all: the product plus WAWU's fee. */
  totalKobo: number;
  expiresAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
  /** Set while an admin has stopped withdrawals on this order. */
  frozen: boolean;
  holding: CapitalHoldingView | null;
  canWithdraw: boolean;
  withdrawBlockedBy: CapitalWithdrawBlock | null;
  /** The words the provider gave for a refused or expired order, when it gave any. */
  note: string | null;
}

export interface CapitalOrderPageView {
  items: CapitalOrderView[];
  nextCursor: string | null;
}

export interface CapitalPortfolioView {
  /** Money in products now (kobo), summed by the provider. */
  investedKobo: number;
  /** Interest earned so far, or null when the provider cannot value a holding yet. */
  returnKobo: number | null;
  /** Invested plus return, or null for the same reason. */
  valueKobo: number | null;
  /** Orders that hold money now. */
  holdings: number;
  /** Currencies the provider reports that this build does not show. */
  otherCurrencies: number;
}

export interface CapitalTransactionView {
  id: string;
  /** The provider's word: PURCHASE, DAILY_ACCRUAL, WITHDRAWAL, MATURITY_PAYOUT, ... */
  event: string;
  amountKobo: number;
  /** The day an accrual is for, when it is one. */
  accruedOn: string | null;
  occurredAt: string | null;
}

export interface CapitalTransactionPageView {
  items: CapitalTransactionView[];
  nextCursor: string | null;
}

/** What leaving now would pay, as the provider works it out. */
export interface CapitalWithdrawalPreviewView {
  /** True when this is the early exit (a penalty on interest), false at maturity. */
  early: boolean;
  grossInterestKobo: number;
  penaltyRate: number;
  penaltyKobo: number;
  deductionsKobo: number;
  netPayoutKobo: number;
  daysHeld: number;
}
