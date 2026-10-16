import type { CreditPack } from '../../../generated/prisma/enums';
import type { CreditPackBadge } from '../credit-packs';
import type {
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';

/**
 * What the wallet credit purchase routes answer (INBOX-16). Credits are a
 * count, never naira (R-5): `credits` and `creditBalance` are whole numbers of
 * credits. `priceKobo` is the pack's price in kobo; what the person pays on
 * top (the provider's charge, R-10) is in `payment`.
 */

/** One pack on sale: the server's table, so the sheet never carries a price of its own. */
export interface CreditPackView {
  pack: CreditPack;
  /** The count of WAWU Credits the pack gives. */
  credits: number;
  /** The pack's price in kobo, before the provider's charge. */
  priceKobo: number;
  /** The tag the sheet draws on the pack (`popular`, `best_value`); null: none. */
  badge: CreditPackBadge | null;
}

/** `GET /credits/packs`. */
export interface CreditPackListView {
  packs: CreditPackView[];
}

/** `GET /credits/purchase/wallet/quote`: the pay sheet (I28) for one pack. */
export interface CreditWalletQuoteView extends CreditPackView {
  /** The wallet payment quote: price, the provider's charge, total, balance, shortfall and its token. */
  payment: PaymentQuoteView;
}

/**
 * `pending`: the payment is still confirming, or it is confirmed and the
 * credits are being added (`payment.delivered` says which; the app polls).
 * `paid`: the credits are added. `failed`: the provider refused it; nothing
 * moved. `reversed`: the money went back to the buyer; no credits were added.
 */
export type CreditWalletPurchaseStatus =
  'pending' | 'paid' | 'failed' | 'reversed';

/** One pack bought from the wallet: what was bought, where its payment stands and, once paid, the credits. */
export interface CreditWalletPurchaseView extends CreditPackView {
  /** The wallet payment's id: poll `GET /credits/purchase/wallet/{id}` with it. */
  id: string;
  method: 'wallet';
  status: CreditWalletPurchaseStatus;
  /** What the app shows beside a purchase that is not finished; null otherwise. */
  statusMessage: string | null;
  /** The wallet payment: the provider's charge, the total taken and its reference. */
  payment: PaymentView;
  /**
   * The person's credits once this purchase had landed (a count), as of this
   * answer; null until `status` is `paid`. `GET /credits` is the live count.
   */
  creditBalance: number | null;
  createdAt: string;
  paidAt: string | null;
}
