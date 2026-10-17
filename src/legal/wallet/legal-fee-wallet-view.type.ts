import type { PaymentQuoteView, PaymentView } from '../../money/money-view.type';

/**
 * What the wallet legal fee routes answer (LEGAL-05, S19, S22, S26). Kobo
 * throughout; what the person pays on top (the provider's charge, R-10) is in
 * `payment`.
 */

/** Which fee of a request is being paid: the consultation, or the work. */
export type LegalFeeStage = 'consultation' | 'service';

/** `GET /legal/requests/:id/pay/wallet/quote`: the pay sheet for the fee that is due. */
export interface LegalFeeWalletQuoteView {
  requestId: string;
  stage: LegalFeeStage;
  /** What the fee is for, as the request names it. */
  title: string;
  /** The fee in kobo: the price WAWU set in admin when it was quoted (R-14). */
  priceKobo: number;
  payment: PaymentQuoteView;
}

/**
 * `pending`: the payment is still confirming, or it is confirmed and the
 * request is being moved on (the app polls). `paid`: the fee is paid and the
 * request has moved on. `failed`: the provider refused it; nothing moved.
 * `reversed`: the money went back to the payer. `refunded`: the fee could not
 * be applied (the request was cancelled, the booked hour was given up, or the
 * fee was paid another way), and the price is going back.
 */
export type LegalFeeWalletStatus =
  'pending' | 'paid' | 'failed' | 'reversed' | 'refunded';

export interface LegalFeeWalletView {
  /** The wallet payment's id: poll `GET /legal/requests/{id}/pay/wallet/{paymentId}` with it. */
  id: string;
  method: 'wallet';
  requestId: string;
  stage: LegalFeeStage;
  title: string;
  status: LegalFeeWalletStatus;
  statusMessage: string | null;
  priceKobo: number;
  /** Where the request stands now (`LegalRequest.status`). */
  requestStatus: string | null;
  payment: PaymentView;
  createdAt: string;
  paidAt: string | null;
}
