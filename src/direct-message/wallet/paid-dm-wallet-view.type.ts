import type {
  MoneyPartyView,
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';
import type { PaidQuestionStatus } from './paid-dm-wallet-rules';

/**
 * What the wallet routes for a paid question answer (INBOX-17, I3 to I5).
 * Kobo throughout; what the person pays on top (the provider's charge, R-10)
 * is in `payment`.
 */

/** The question being asked, as the pay sheet (I3) shows it. */
export interface PaidQuestionDraftView {
  /** The question's id: `payment.targetId`, and later the id of the message in the thread. */
  id: string;
  creator: MoneyPartyView | null;
  text: string;
  /** The price: the creator's own. */
  priceKobo: number;
  /** How long the creator has to reply once the question is sent. */
  replyWindowHours: number;
}

/** `POST /dm/{creatorWawuId}/send/wallet` and `GET /dm/send/wallet/{id}/quote`: the pay sheet. */
export interface PaidQuestionQuoteView {
  question: PaidQuestionDraftView;
  /** The wallet payment's quote: price, the provider's charge, total, balance, shortfall and its token. */
  payment: PaymentQuoteView;
}

/**
 * A paid question as it stands. `asked`: sent, held by WAWU until the creator
 * answers or `deadlineAt` passes. `answered`: the creator's 85% is on its way
 * to their wallet (R-11). `refunding` and `refunded`: the price goes back to
 * the payer's wallet, never the provider's charge on the payment (R-10).
 */
export interface PaidQuestionWalletView {
  /** The question's id (also the message id once it is sent). */
  id: string;
  method: 'wallet';
  status: PaidQuestionStatus;
  statusMessage: string | null;
  creator: MoneyPartyView | null;
  text: string;
  priceKobo: number;
  replyWindowHours: number;
  /** When the creator's window closes; null until the question is sent. */
  deadlineAt: string | null;
  /** The wallet payment (with its hold once confirmed); null while unpaid. */
  payment: PaymentView | null;
  createdAt: string;
  /** When the question was sent to the creator; null until then. */
  sentAt: string | null;
}
