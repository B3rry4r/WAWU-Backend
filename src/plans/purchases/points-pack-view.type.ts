import type {
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';
import type { PlanCurrency } from '../plans-view.type';
import type {
  PlanPurchaseMethod,
  POINTS_PACK_KIND,
} from './plan-purchase-terms';
import type { PlanPurchaseTransferView } from './plan-purchase-view.type';

/**
 * What the points pack purchase answers (POINTS-02, PT4 to PT4c). They ride
 * the tier purchase's routes (`GET /plans/purchases/quote`, `POST
 * /plans/purchases`, `GET /plans/purchases/{id}`) with `kind: "points_pack"`,
 * and tell themselves apart from a tier's views by that `kind`. Amounts named
 * `...Minor` are whole numbers in the minor unit of `currency` (kobo for NGN);
 * the payment's own fields (`...Kobo`) are kobo. Points are a count, never a
 * naira figure.
 */

/**
 * `awaiting_transfer`: bought by bank transfer and the money has not reached
 * the wallet account yet (`transfer` says where to send it and how much is
 * still needed); nothing is taken until it covers the total. `pending`: the
 * payment is confirming, or it is confirmed and the points are being added
 * (`payment.delivered` says which; the app polls), or the money landed and the
 * purchase is being paid from the wallet. `paid`: the points were added.
 * `failed`: the provider refused it, or the purchase cannot be made any more
 * (`statusMessage` says why); nothing moved. `reversed`: the money went back
 * to the buyer; nothing was added. `expired`: the time to send the money ran
 * out; nothing was taken.
 */
export type PointsPackPurchaseStatus =
  'awaiting_transfer' | 'pending' | 'paid' | 'failed' | 'reversed' | 'expired';

/** What a paid pack gave: one lot of points. */
export interface PointsPackGrantView {
  /** The pack's own points. */
  points: number;
  /** The Founding Maker's extra points, rounded down; 0 for anyone else. */
  bonusPoints: number;
  /** `points` plus `bonusPoints`: the size of the lot. */
  totalPoints: number;
  /** The lot ends at this moment (ISO 8601). */
  expiresAt: string;
}

/** One points pack purchase, from the moment it is asked for to the points being added. */
export interface PointsPackPurchaseView {
  /**
   * The id to poll `GET /plans/purchases/{id}` with: the wallet payment's id,
   * or, for a purchase bought by transfer, the id it had while it waited for
   * the money (the same id before and after the money lands).
   */
  id: string;
  kind: typeof POINTS_PACK_KIND;
  packId: string;
  method: PlanPurchaseMethod;
  currency: PlanCurrency;
  /** The pack's price, never the provider's charge. */
  amountMinor: number;
  /** The pack's own points, as quoted. */
  points: number;
  /** The Founding Maker's extra points, as quoted; 0 for anyone else. */
  bonusPoints: number;
  status: PointsPackPurchaseStatus;
  /** What the app shows beside a purchase that is not finished; null otherwise. */
  statusMessage: string | null;
  /** The wallet payment: the provider's charge, the total taken and its reference. Null until the money is taken. */
  payment: PaymentView | null;
  /** Set while `status` is `awaiting_transfer`. */
  transfer: PlanPurchaseTransferView | null;
  /** Set once `status` is `paid`. */
  grant: PointsPackGrantView | null;
  createdAt: string;
  paidAt: string | null;
}

/** `GET /plans/purchases/quote?kind=points_pack&packId=`: the pay sheet (PT4) for one pack. */
export interface PointsPackQuoteView {
  kind: typeof POINTS_PACK_KIND;
  packId: string;
  currency: PlanCurrency;
  /** The pack's price. */
  packMinor: number;
  /** The pack's own points. */
  points: number;
  /** The extra percent the person's running tier gives on packs; 0 for anyone else. */
  bonusPercent: number;
  /** `points` times `bonusPercent`, rounded down to a whole point. */
  bonusPoints: number;
  /** `points` plus `bonusPoints`. */
  totalPoints: number;
  /** How many days the points last once added. */
  expiryDays: number;
  /** The wallet payment's kind to send with the quote token. */
  paymentKind: typeof POINTS_PACK_KIND;
  /** The wallet payment quote: price, the provider's charge, total, balance, shortfall and its token. */
  payment: PaymentQuoteView;
}
