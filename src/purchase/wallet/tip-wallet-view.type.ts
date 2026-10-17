import type {
  MoneyPartyView,
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';

/**
 * What the wallet tip routes answer (HOME-14, H26 to H28). Kobo throughout;
 * what the person pays on top (the provider's charge, R-10) is in `payment`.
 */

/** `GET /tips/wallet/quote`: the pay sheet (H26) for one tip. */
export interface TipWalletQuoteView {
  creator: MoneyPartyView;
  amountKobo: number;
  /** The wallet payment quote: price, the provider's charge, total, balance, shortfall and its token. */
  payment: PaymentQuoteView;
}

/**
 * `pending`: the payment is still confirming, or it is confirmed and the tip
 * is being recorded (the app polls). `paid`: the tip is recorded and the
 * creator's 85% is on its way to their wallet (R-11). `failed`: the provider
 * refused it; nothing moved. `reversed`: the money went back to the payer.
 * `refunded`: the tip could not be delivered (the creator is gone or blocked
 * the payer since), and the amount is going back.
 */
export type TipWalletStatus =
  'pending' | 'paid' | 'failed' | 'reversed' | 'refunded';

export interface TipWalletView {
  /** The wallet payment's id: poll `GET /tips/wallet/{id}` with it. */
  id: string;
  method: 'wallet';
  status: TipWalletStatus;
  statusMessage: string | null;
  creator: MoneyPartyView | null;
  amountKobo: number;
  note: string | null;
  payment: PaymentView;
  createdAt: string;
  paidAt: string | null;
}
