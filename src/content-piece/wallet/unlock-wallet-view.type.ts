import type {
  MoneyPartyView,
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';

/**
 * What the wallet unlock routes answer (HOME-15, H14 to H18). Kobo
 * throughout; what the person pays on top (the provider's charge, R-10) is in
 * `payment`.
 */

/** `GET /content/:id/unlock/wallet/quote`: the pay sheet (H14) for one piece. */
export interface UnlockWalletQuoteView {
  contentId: string;
  title: string;
  creator: MoneyPartyView | null;
  /** The piece's price in kobo, the server's own record of it. */
  priceKobo: number;
  /** The wallet payment quote: price, the provider's charge, total, balance, shortfall and its token. */
  payment: PaymentQuoteView;
}

/**
 * `pending`: the payment is still confirming, or it is confirmed and access is
 * being given (the app polls). `paid`: the piece is unlocked and
 * `fullAssetUrl` opens it. `failed`: the provider refused it; nothing moved.
 * `reversed`: the money went back to the payer. `refunded`: the piece could
 * not be unlocked (it was taken down, or the person already owned it), and the
 * price is going back.
 */
export type UnlockWalletStatus =
  'pending' | 'paid' | 'failed' | 'reversed' | 'refunded';

export interface UnlockWalletView {
  /** The wallet payment's id: poll `GET /content/{id}/unlock/wallet/{paymentId}` with it. */
  id: string;
  method: 'wallet';
  contentId: string;
  title: string;
  status: UnlockWalletStatus;
  statusMessage: string | null;
  priceKobo: number;
  /** True once access is given. */
  purchased: boolean;
  /** A fresh link to the full piece once `purchased`; null before. */
  fullAssetUrl: string | null;
  payment: PaymentView;
  createdAt: string;
  paidAt: string | null;
}
