import { WalletProviderError } from './wallet-provider-error';
import type { WalletProviderName } from './wallet-provider.interface';

/**
 * Capital on the wallet provider seam (task NUV-12, R-84): the provider's
 * fixed-return and share-offering products. The money layer reaches them only
 * through `WalletProvider.capital`; a provider with none leaves the member
 * out (the Fintava adapter has none), and the layer answers "not available".
 *
 * Every amount is a whole number in the smallest unit of the order's
 * `currency` (kobo for NGN). A rate is a decimal as the provider states it
 * (0.18 is 18% a year). Nothing here is worked out by WAWU: a rate, a term, a
 * penalty or a payout is the provider's own word, and an absent figure stays
 * `null` rather than becoming zero.
 */

/** The product kinds this build serves. A kind the provider adds later is not listed. */
export const CAPITAL_PRODUCT_TYPES = [
  'FIXED_RETURN',
  'SHARE_OFFERING',
] as const;
export type CapitalProductType = (typeof CAPITAL_PRODUCT_TYPES)[number];

export interface CapitalDeductible {
  name: string;
  /** A fraction for `percentage` (0.1 is 10%), or whole minor units for `flat`. */
  value: number;
  valueType: 'flat' | 'percentage';
  appliesTo: 'principal' | 'interest';
}

export interface CapitalRateBand {
  name: string;
  rate: number;
  minMinor: number | null;
  maxMinor: number | null;
}

export interface CapitalDocument {
  name: string;
  url: string;
}

/**
 * The provider's free text (a product's own description, a status reason) is NOT carried: it is marketing or
 * the provider's voice, and it can promise ("guaranteed", "grow your money with confidence") what WAWU does not.
 * A product is shown as its terms, in our words; only its name, its issuer and its documents' names pass.
 */
export interface CapitalProduct {
  id: string;
  type: CapitalProductType;
  name: string;
  currency: string;
  /** The sale window, when the provider sets one. */
  startsAt: string | null;
  endsAt: string | null;
  minMinor: number | null;
  maxMinor: number | null;
  /** Fixed return only. */
  tenorDays: number | null;
  earliestWithdrawalDays: number | null;
  annualRate: number | null;
  rateBands: CapitalRateBand[];
  /** Fixed return only: whether leaving early is allowed. Null when the provider does not say. */
  allowEarlyWithdrawal: boolean | null;
  deductibles: CapitalDeductible[];
  /** The detail view only. */
  documents: CapitalDocument[];
  /** Share offering only. */
  share: {
    issuerName: string | null;
    offerPriceMinor: number | null;
    lockPeriodDays: number | null;
    prospectusUrl: string | null;
    stage: string | null;
  } | null;
  /** Share offering only. `orderable` is the provider's own word when it gives one. */
  availability: {
    status: string | null;
    orderable: boolean | null;
    reason: string | null;
    quantity: number | null;
  } | null;
}

export interface CapitalQuote {
  type: CapitalProductType;
  currency: string;
  /** What leaves the wallet for the product, fees of the provider's included. */
  totalDebitMinor: number;
  principalMinor: number | null;
  tenorDays: number | null;
  lockedRate: number | null;
  rateSource: string | null;
  dayCount: number | null;
  locked: boolean | null;
  allowEarlyWithdrawal: boolean | null;
  earliestWithdrawalDays: number | null;
  penaltyRate: number | null;
  deductibles: CapitalDeductible[];
  /** Share offering. */
  requestedMinor: number | null;
  requestedShares: number | null;
  allocatedShares: number | null;
  unallocatedMinor: number | null;
  offerPriceMinor: number | null;
  baseCostMinor: number | null;
  brokerageFeeMinor: number | null;
  crossDealFeeMinor: number | null;
  lockPeriodDays: number | null;
}

export interface CapitalReservation {
  orderId: string;
  expiresAt: string;
  currency: string;
  quote: CapitalQuote;
}

export interface CapitalConfirmation {
  orderId: string;
  status: string;
  capitalAccountId: string | null;
  userCapitalAccountId: string | null;
}

/** The holding an approved order opened. */
export interface CapitalAccount {
  id: string;
  type: CapitalProductType;
  currency: string;
  /** Last four digits only. */
  numberLast4: string | null;
  lifecycle: string | null;
  payoutStatus: string | null;
  principalMinor: number | null;
  lockedRate: number | null;
  dayCount: number | null;
  tenorDays: number | null;
  startedAt: string | null;
  maturesAt: string | null;
  earlyActionAt: string | null;
  accruedMinor: number | null;
  dueInterestMinor: number | null;
  grossInterestMinor: number | null;
  totalDeductionsMinor: number | null;
  expectedNetPayoutMinor: number | null;
  netPayoutMinor: number | null;
  settlementAt: string | null;
  /** Share offering. */
  sharesPurchased: number | null;
  unitsHeld: number | null;
  baseCostMinor: number | null;
  totalDebitedMinor: number | null;
  lockExpiresAt: string | null;
  currentValueMinor: number | null;
  pendingRefundMinor: number | null;
}

export interface CapitalOrder {
  id: string;
  productId: string;
  type: CapitalProductType;
  currency: string;
  amountMinor: number;
  reservedQuantity: number | null;
  status: string;
  statusReason: string | null;
  expiresAt: string | null;
  confirmedAt: string | null;
  createdAt: string | null;
  account: CapitalAccount | null;
  agreements: CapitalDocument[];
}

export interface CapitalPortfolioLine {
  currency: string;
  investedMinor: number;
  returnMinor: number | null;
  valueMinor: number | null;
}

export interface CapitalTransaction {
  id: string;
  eventType: string;
  amountMinor: number;
  accruedOn: string | null;
  createdAt: string | null;
}

export interface CapitalWithdrawalPreview {
  grossInterestMinor: number;
  penaltyRate: number;
  penaltyMinor: number;
  deductionsMinor: number;
  netPayoutMinor: number;
  daysElapsed: number;
}

export interface CapitalPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CapitalListQuery {
  type?: CapitalProductType;
  status?: string;
  currency?: string;
  cursor?: string;
  limit?: number;
}

/** Whose wallet: the same `walletId` the seam's `getBalance` takes. */
export interface CapitalWallet {
  walletId: string;
}

/**
 * The words a refusal from the provider's capital calls is given, so the
 * money layer decides on a code and never reads a provider's own type:
 * - `reservation_expired`: the 15 minutes ran out (or the order is closed);
 * - `not_orderable`: sold out, outside its sale window, not offered to this
 *   person, or the amount is outside what the product takes;
 * - `withdrawal_not_available`: the provider says this holding cannot be
 *   withdrawn now (locked, too early, already paying out, early exit off);
 * - `already_processing`: a confirmation is still being settled; nothing was
 *   sent again.
 */
export const CAPITAL_REFUSALS = [
  'reservation_expired',
  'not_orderable',
  'withdrawal_not_available',
  'already_processing',
] as const;
export type CapitalRefusalCode = (typeof CAPITAL_REFUSALS)[number];

export class WalletProviderCapitalError extends WalletProviderError {
  readonly refusal: CapitalRefusalCode;
  /** The provider's field complaints, masked, in its words (never shown as they are). */
  readonly fields: string[];

  constructor(args: {
    refusal: CapitalRefusalCode;
    provider: WalletProviderName;
    operation: string;
    httpStatus?: number | null;
    fields?: string[];
    recordMayExist?: boolean;
  }) {
    super({
      kind:
        args.refusal === 'already_processing' ? 'outcome_unknown' : 'refused',
      provider: args.provider,
      operation: args.operation,
      httpStatus: args.httpStatus ?? null,
      messages: [`capital: ${args.refusal}`],
      recordMayExist: args.recordMayExist ?? false,
    });
    this.name = 'WalletProviderCapitalError';
    this.refusal = args.refusal;
    this.fields = args.fields ?? [];
  }
}

/**
 * What the provider offers for capital. `currencies` are the ones an order
 * can be funded in from the person's wallet (naira only until the other
 * currency accounts are built); a product in any other is never listed.
 */
export interface WalletProviderCapital {
  readonly currencies: readonly string[];
  listProducts(
    wallet: CapitalWallet,
    query: CapitalListQuery,
  ): Promise<CapitalPage<CapitalProduct>>;
  getProduct(
    wallet: CapitalWallet,
    productId: string,
  ): Promise<CapitalProduct | null>;
  /**
   * Reserves a product for 15 minutes (no money moves). The provider affirms
   * every document of the product for the person: the caller has shown them.
   */
  reserve(
    wallet: CapitalWallet,
    input: {
      productId: string;
      type: CapitalProductType;
      amountMinor: number;
      lockInvestment: boolean;
    },
  ): Promise<CapitalReservation>;
  /** The only call that moves money. Safe to repeat: the provider debits once. */
  confirm(wallet: CapitalWallet, orderId: string): Promise<CapitalConfirmation>;
  getOrder(
    wallet: CapitalWallet,
    orderId: string,
  ): Promise<CapitalOrder | null>;
  listOrders(
    wallet: CapitalWallet,
    query: CapitalListQuery,
  ): Promise<CapitalPage<CapitalOrder>>;
  portfolio(wallet: CapitalWallet): Promise<CapitalPortfolioLine[]>;
  transactions(
    wallet: CapitalWallet,
    capitalAccountId: string,
    query: CapitalListQuery,
  ): Promise<CapitalPage<CapitalTransaction>>;
  withdrawalPreview(
    wallet: CapitalWallet,
    orderId: string,
  ): Promise<CapitalWithdrawalPreview>;
  /** Starts the payout (early exit or maturity, the provider picks). Safe to repeat. */
  withdraw(wallet: CapitalWallet, orderId: string): Promise<CapitalOrder>;
}
