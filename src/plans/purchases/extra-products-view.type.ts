import type {
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';
import type { PlanCurrency } from '../plans-view.type';
import type {
  EXTRA_PRODUCTS_KIND,
  PlanPurchaseMethod,
} from './plan-purchase-terms';
import type { PlanPurchaseTransferView } from './plan-purchase-view.type';

/**
 * What the extra products purchase answers (TIER-04, VF13). They ride the tier
 * purchase's routes (`GET /plans/purchases/quote`, `POST /plans/purchases`,
 * `GET /plans/purchases/{id}`) with `kind: "extra_products"`, and tell
 * themselves apart from the other views by that `kind`. Amounts named
 * `...Minor` are whole numbers in the minor unit of `currency` (kobo for NGN);
 * the payment's own fields (`...Kobo`) are kobo.
 */

/**
 * `awaiting_transfer`: bought by bank transfer and the money has not reached
 * the wallet account yet (`transfer` says where to send it and how much is
 * still needed); nothing is taken until it covers the total. `pending`: the
 * payment is confirming, or it is confirmed and the products are being added
 * (`payment.delivered` says which; the app polls), or the money landed and the
 * purchase is being paid from the wallet. `paid`: the products were added.
 * `failed`: the provider refused it, or the purchase cannot be made any more
 * (`statusMessage` says why); nothing moved. `reversed`: the money went back
 * to the buyer. `expired`: the time to send the money ran out; nothing was
 * taken.
 */
export type ExtraProductsPurchaseStatus =
  | 'awaiting_transfer'
  | 'pending'
  | 'paid'
  | 'failed'
  | 'reversed'
  | 'expired'
  | 'refunded';

/** What a paid purchase gave: more places to publish. */
export interface ExtraProductsGrantView {
  /** Products this purchase added. */
  productsAdded: number;
  /** All the extra products bought on the account, as they stand now. */
  extraProducts: number;
  /** Products the person may have published at once, as they stand now: the tier's own plus the extras. */
  productsAllowed: number;
}

/** One extra products purchase, from the moment it is asked for to the products being added. */
export interface ExtraProductsPurchaseView {
  /**
   * The id to poll `GET /plans/purchases/{id}` with: the wallet payment's id,
   * or, for a purchase bought by transfer, the id it had while it waited for
   * the money (the same id before and after the money lands).
   */
  id: string;
  kind: typeof EXTRA_PRODUCTS_KIND;
  method: PlanPurchaseMethod;
  currency: PlanCurrency;
  /** The add-on's price, never the provider's charge. */
  amountMinor: number;
  /** Products this purchase adds, as quoted. */
  products: number;
  status: ExtraProductsPurchaseStatus;
  /** What the app shows beside a purchase that is not finished; null otherwise. */
  statusMessage: string | null;
  /** The wallet payment: the provider's charge, the total taken and its reference. Null until the money is taken. */
  payment: PaymentView | null;
  /** Set while `status` is `awaiting_transfer`. */
  transfer: PlanPurchaseTransferView | null;
  /** Set once `status` is `paid`. */
  grant: ExtraProductsGrantView | null;
  createdAt: string;
  paidAt: string | null;
}

/** `GET /plans/purchases/quote?kind=extra_products`: the pay sheet (VF13) for the add-on. */
export interface ExtraProductsQuoteView {
  kind: typeof EXTRA_PRODUCTS_KIND;
  currency: PlanCurrency;
  /** The add-on's price. */
  extraMinor: number;
  /** Products the add-on adds. */
  products: number;
  /** Products the person may have published at once now. */
  productsAllowed: number;
  /** The same once the add-on is bought. */
  productsAllowedAfter: number;
  /** The wallet payment's kind to send with the quote token. */
  paymentKind: typeof EXTRA_PRODUCTS_KIND;
  /** The wallet payment quote: price, the provider's charge, total, balance, shortfall and its token. */
  payment: PaymentQuoteView;
}
