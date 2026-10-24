import type {
  MoneyPartyView,
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';

/**
 * What the pass routes answer (INBOX-24, R-63; I30, I31). Kobo throughout;
 * what the person pays on top (the wallet provider's charge and WAWU's fee,
 * R-10) is in `payment`.
 */

/** `GET /communities/:id/pass`: the pass as the caller stands with it. Needs no wallet. */
export interface CommunityPassView {
  communityId: string;
  /** True when this room sells a monthly pass. False for an open room and for a private room that keeps the older join requests. */
  sellsPass: boolean;
  /** The host's price for one pass, in kobo; null when the room sells none. */
  priceKobo: number | null;
  /** Days one pass lasts (30, R-63). */
  periodDays: number;
  /** When the caller's pass ends (ISO 8601); null when they never had one. */
  passUntil: string | null;
  /** True while the caller's pass has not ended. */
  active: boolean;
  /** True when the caller has held a pass here and can pay for the next one. */
  canRenew: boolean;
  /** True when the caller can pay for a pass now: the room sells one and the caller is not its host. */
  canBuy: boolean;
  /** True for the room's host, who is always inside and pays nothing. */
  isHost: boolean;
  /**
   * True when the host removed the caller and the caller still holds a store
   * subscription for this room's pass (IAP-01). Always sent by this Hub; optional in the
   * contract so a response shape the web or an older app reads gains a field and loses
   * none: absent means false. The store keeps billing them
   * until they cancel it there, and a renewal gives them nothing. The pass screen
   * tells them to cancel in the store. False otherwise.
   */
  cancelInStore?: boolean;
}

/** `GET /communities/:id/pass/quote`: the pay sheet before the PIN. */
export interface CommunityPassQuoteView {
  communityId: string;
  title: string;
  host: MoneyPartyView | null;
  /** The host's price in kobo, the server's own record of it. */
  priceKobo: number;
  periodDays: number;
  /** When the caller's pass ends now (ISO 8601), or null when they have none running. */
  passUntil: string | null;
  /** When it would end if they paid now: 30 days from the later of today and `passUntil`. */
  newPassUntil: string;
  /** The wallet payment quote: price, the provider's charge, WAWU's fee, total, balance, shortfall and its token. */
  payment: PaymentQuoteView;
}

/**
 * `pending`: the payment is still confirming, or it is confirmed and the pass
 * is being given (the app polls). `paid`: the pass is given and `passUntil`
 * says when it ends. `failed`: the provider refused it; nothing moved.
 * `reversed`: the money went back to the payer. `refunded`: the pass could not
 * be given (the room stopped selling, or the host and the person can no longer
 * deal), and everything paid, the charge included, is going back.
 */
export type CommunityPassPurchaseStatus =
  'pending' | 'paid' | 'failed' | 'reversed' | 'refunded';

export interface CommunityPassPurchaseView {
  /** The wallet payment's id: poll `GET /communities/{id}/pass/{paymentId}` with it. */
  id: string;
  method: 'wallet';
  communityId: string;
  title: string;
  status: CommunityPassPurchaseStatus;
  statusMessage: string | null;
  priceKobo: number;
  /** When the pass this payment bought ends (ISO 8601); null until it is given. */
  passUntil: string | null;
  payment: PaymentView;
  createdAt: string;
  paidAt: string | null;
}

/**
 * `GET /communities/{id}/members/{userWawuId}/removal-quote`: what the host's
 * remove sheet says the member gets back before the host confirms (INBOX-25,
 * R-71). Made by the Hub, never by the app. Kobo. `refundKobo` is 0 when the
 * member has no unused days (a pass that has ended, or none), and then the
 * sheet says nothing about money. The refund is made again at the moment of
 * removal, so a day that starts in between can make it one day smaller.
 */
export interface CommunityPassRemovalQuoteView {
  communityId: string;
  userWawuId: string;
  /** What the member is paid back, in kobo, pro rata for the whole unused days. */
  refundKobo: number;
  /** The whole unused days it is figured on; a day that has started counts as used. */
  unusedDays: number;
  /** When the figure was made (ISO 8601). */
  asOf: string;
}
