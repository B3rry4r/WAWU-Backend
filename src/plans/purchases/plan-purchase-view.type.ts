import type {
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';
import type {
  MyTierSummaryView,
  PlanCurrency,
  PlanEventPassView,
} from '../plans-view.type';
import type { PlanPaymentKind, PlanPurchaseKind } from './plan-purchase-terms';

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

/** One tier purchase: what was bought, where its payment stands and, once paid, what it gave. */
export interface PlanPurchaseView {
  /** The wallet payment's id: poll `GET /plans/purchases/{id}` with it. */
  id: string;
  kind: PlanPurchaseKind;
  tierId: string;
  /** The tier an upgrade moved from; null for the other kinds. */
  fromTierId: string | null;
  /** The checkout bump (extra points) was bought with it. */
  bump: boolean;
  method: 'wallet';
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
