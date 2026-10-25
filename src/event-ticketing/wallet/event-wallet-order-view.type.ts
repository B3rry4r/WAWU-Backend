import type {
  HoldStatus,
  PaymentQuoteView,
  PaymentStatus,
} from '../../money/money-view.type';
import type { EventOrderProgress } from './event-wallet-order-rules';

/** The event an order is for, with what the ticket and the calendar draw (E3, E5). */
export interface EventOrderEventView {
  id: string;
  name: string;
  startsAt: string;
  endsAt: string | null;
  /** IANA zone and the label the host chose ("10:00 WAT"); both may be null. */
  timezone: string | null;
  timeLabel: string | null;
  location: string;
  venueName: string | null;
  bannerUrl: string | null;
  /**
   * When the host called the event off (an ISO time); null while it is on. A
   * buyer cannot read a called-off event (`GET /events/{id}` answers 404), so
   * the order carries it for E11: the page of a refunded order says the event
   * was called off, not that the payment failed.
   */
  cancelledAt: string | null;
}

/** One tier of the basket: "2 x VIP". Money is integer kobo. */
export interface EventOrderLineView {
  ticketTypeId: string;
  tierName: string;
  /** One ticket, in kobo; 0 for a free tier. */
  unitPriceKobo: number;
  quantity: number;
  /** `unitPriceKobo` times `quantity`. */
  lineKobo: number;
}

/** One admittance of a paid order: what E5 draws as the QR and the code. */
export interface EventOrderTicketView {
  id: string;
  /** What the door scans (K7QX-4M2P-9WLA-3RTE). */
  code: string;
  tierName: string;
  status: 'valid' | 'checked_in' | 'void';
}

/**
 * What came back to the buyer when a paid order could not be completed
 * (the tickets sold out between the quote and the payment, or the event was
 * called off). `returned` is true once the provider confirmed the move into
 * the wallet; until then the money is on its way (`returnedKobo` null).
 */
export interface EventOrderReturnView {
  holdStatus: HoldStatus;
  returned: boolean;
  returnedKobo: number | null;
}

/**
 * An order for event tickets paid from the wallet (EVENTS-07) as it stands:
 * E3's review before payment, E10's "paid, still confirming", E5's tickets.
 */
export interface EventWalletOrderView {
  id: string;
  /** The reference a person quotes (WAW-EVT-...). */
  reference: string;
  event: EventOrderEventView;
  /** True when the whole basket is ₦0: tickets were issued with no payment, wallet or PIN (R-8). */
  free: boolean;
  lines: EventOrderLineView[];
  /** The tickets in all. */
  ticketCount: number;
  /** The tickets' price in all, in kobo, before the provider's charge. */
  ticketsKobo: number;
  /**
   * awaiting_payment: made and quoted, nothing paid.
   * processing: the payment is not confirmed, or is confirmed and the tickets
   *   are being issued (E10, "paid, still confirming"; `statusMessage` says which).
   * paid: the tickets are issued.
   * failed: the order could not be completed.
   */
  status: EventOrderProgress;
  /** The wallet payment that paid it; null before it is paid and on a free order. */
  paymentId: string | null;
  /** That payment's own status, so the app tells "not confirmed" from "paid, issuing". */
  paymentStatus: PaymentStatus | null;
  /** A sentence for the person while `processing`; null otherwise. */
  statusMessage: string | null;
  /** The provider's charge on the payment, and what left the wallet in all; null before it is paid. */
  transferFeeKobo: number | null;
  totalKobo: number | null;
  /** The buyer's name on the tickets (E5); null before the order is paid. */
  holderName: string | null;
  /** Empty until `paid`. */
  tickets: EventOrderTicketView[];
  /** On `failed`, why, in words a person reads. */
  failureReason: string | null;
  /** On `failed` after a payment, the money coming back. */
  returned: EventOrderReturnView | null;
  createdAt: string;
  paidAt: string | null;
}

/**
 * E3: the order priced and the wallet payment's own quote (the tickets, the
 * provider's charge, the total and the balance). `payment` is null for a free
 * basket, which is already `paid` in `order`.
 */
export interface EventWalletOrderQuoteView {
  order: EventWalletOrderView;
  /** The quote `POST /events/orders/wallet/pay` repeats: its `totalKobo` and `quoteToken`. */
  payment: PaymentQuoteView | null;
}
