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
  /**
   * "Usually replies in": the median minutes this creator took to answer
   * their last answered paid questions (G-146). Null until they have answered
   * enough of them for a figure to mean anything, so the sheet leaves the
   * line out rather than say a number that is mostly chance.
   */
  usualReplyMinutes: number | null;
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
 * to their wallet in their move of the day (R-11, R-55). `refunding` and
 * `refunded`: the price and the payment's charge go back to the payer's wallet.
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
