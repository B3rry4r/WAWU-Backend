import type {
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';
import type {
  MyTierSummaryView,
  PlanCurrency,
  PlanEventPassView,
} from '../plans-view.type';
import type {
  PlanPaymentKind,
  PlanPurchaseKind,
  PlanPurchaseMethod,
} from './plan-purchase-terms';

/**
 * What the tier purchase routes answer (TIER-03). Amounts named `...Minor` are
 * whole numbers in the minor unit of `currency` (kobo for NGN); the payment's
 * own fields (`...Kobo`) are kobo, as everywhere in the wallet.
 */

/**
 * `pending`: the payment is still confirming, or it is confirmed and the plan
 * is being opened (`payment.delivered` says which; the app polls). `paid`: the
 * plan is granted. `failed`: the provider refused it; nothing moved.
 * `reversed`: the money went back to the buyer; nothing was granted.
 * `refunded`: the payment was confirmed but the plan could not be granted (the
 * tier an upgrade came from ended while it confirmed, say), so the whole price
 * is going back to the buyer's wallet or has gone back (`statusMessage` says
 * which); nothing was granted, and the buyer may buy again at once.
 */
export type PlanPurchaseStatus =
  'pending' | 'paid' | 'failed' | 'reversed' | 'refunded';

/** What a paid purchase gave. */
export interface PlanPurchaseGrantView {
  /** The tier the person holds after it. */
  tier: MyTierSummaryView;
  activeFrom: string;
  /** The tier ends at this moment (ISO 8601). */
  activeUntil: string;
  productsAllowed: number;
  /** Bonus points this purchase added as one lot; 0 when it added none. */
  bonusPoints: number;
  bonusPointsExpireAt: string | null;
  /** The checkout bump's points, when it was bought; 0 otherwise. */
  bumpPoints: number;
  bumpPointsExpireAt: string | null;
  /** The event pass this purchase issued. */
  eventPass: PlanEventPassView | null;
  firstVoiceIntroIncluded: boolean;
}

/**
 * Where to send the money for a purchase waiting for a bank transfer, and how
 * much (TIER-05, VF6 "transfer details shown"). The account is the person's
 * own wallet account: WAWU runs no separate collection account (R-42).
 * Amounts are kobo.
 */
export interface PlanPurchaseTransferView {
  accountNumber: string;
  accountName: string;
  bankName: string;
  bankCode: string;
  /** The plan's price (with the bump's, when it is bought). */
  priceKobo: number;
  /** The bank's charge on the payment, shown as "Bank charge" (R-10, R-53). */
  bankChargeKobo: number;
  /** `priceKobo` plus `bankChargeKobo`: what the wallet must hold. */
  totalKobo: number;
  /** The wallet's available balance as the provider reports it now; null when it did not answer. */
  balanceKobo: number | null;
  /** `totalKobo` less the balance, never below 0; null when the balance is unknown. */
  amountNeededKobo: number | null;
  /** After this the purchase lapses (ISO 8601). */
  expiresAt: string;
}

/**
 * A purchase bought by bank transfer that has no wallet payment yet, or never
 * got one (TIER-05, VF6 "transfer details shown"). The same `id` reads
 * `PlanPurchaseView` from `GET /plans/purchases/{id}` once the money has
 * landed and the wallet payment exists.
 *
 * - `awaiting_transfer`: the money has not reached the wallet account yet;
 *   `transfer` says where to send it and how much is still needed. Nothing is
 *   taken until it covers the total.
 * - `pending`: the money landed and the purchase is being paid from the wallet.
 * - `expired`: the time to send the money ran out. Nothing was taken, and any
 *   money that was sent is in the wallet.
 * - `failed`: the purchase cannot be made any more (the price changed, the
 *   plan is no longer payable, it was paid another way, the person started the
 *   same purchase again); `statusMessage` says why and nothing was taken.
 */
export interface PlanTransferOrderView {
  id: string;
  kind: PlanPurchaseKind;
  tierId: string;
  fromTierId: string | null;
  bump: boolean;
  method: 'transfer';
  currency: PlanCurrency;
  /** The plan's price (or the upgrade's difference) plus the bump's, never the bank's charge. */
  amountMinor: number;
  status: 'awaiting_transfer' | 'pending' | 'expired' | 'failed';
  statusMessage: string | null;
  /** Null: nothing has been taken. */
  payment: PaymentView | null;
  /** Set while `status` is `awaiting_transfer`. */
  transfer: PlanPurchaseTransferView | null;
  /** Null: nothing is granted before it is paid. */
  grant: PlanPurchaseGrantView | null;
  createdAt: string;
  /** Null: it is not paid. */
  paidAt: string | null;
}

/** One tier purchase: what was bought, where its payment stands and, once paid, what it gave. */
export interface PlanPurchaseView {
  /**
   * The id to poll `GET /plans/purchases/{id}` with: the wallet payment's id,
   * or, for a purchase bought by transfer, the id it had while it waited for
   * the money (the same id before and after the money lands).
   */
  id: string;
  kind: PlanPurchaseKind;
  tierId: string;
  /** The tier an upgrade moved from; null for the other kinds. */
  fromTierId: string | null;
  /** The checkout bump (extra points) was bought with it. */
  bump: boolean;
  method: PlanPurchaseMethod;
  currency: PlanCurrency;
  /** The plan's price (or the upgrade's difference) plus the bump's, never the provider's charge. */
  amountMinor: number;
  status: PlanPurchaseStatus;
  /** What the app shows beside a purchase that is not finished; null otherwise. */
  statusMessage: string | null;
  /** The wallet payment: the provider's charge, the total taken and its reference. */
  payment: PaymentView;
  /** Set once `status` is `paid`. */
  grant: PlanPurchaseGrantView | null;
  createdAt: string;
  paidAt: string | null;
}

/** `GET /plans/purchases/quote`: the pay sheet (VF6) for one purchase. */
export interface PlanPurchaseQuoteView {
  kind: PlanPurchaseKind;
  tierId: string;
  fromTierId: string | null;
  bump: boolean;
  currency: PlanCurrency;
  /** The tier's price, or the difference on an upgrade. */
  planMinor: number;
  /** The checkout bump's price when it is bought, else 0. */
  bumpMinor: number;
  /** The checkout bump's points when it is bought, else 0. */
  bumpPoints: number;
  /** The wallet payment's kind to send with the quote token. */
  paymentKind: PlanPaymentKind;
  /** The wallet payment quote: price, the provider's charge, total, balance, shortfall and its token. */
  payment: PaymentQuoteView;
}

/**
 * The tier purchase still going through for the caller, if any (ME-13, M15:
 * "Paid, still confirming"). `purchase` is the same `PlanPurchaseView`
 * `GET /plans/purchases/{id}` answers, with `status: pending`: the payment is
 * still confirming, or it is confirmed and the plan is being opened. It is
 * null when nothing is going through, so a screen that is opened again after
 * a restart can say "don't pay again" instead of offering the purchase.
 * A purchase waiting for a bank transfer is not in it: nothing was paid yet.
 */
export interface PendingPlanPurchaseView {
  purchase: PlanPurchaseView | null;
}
