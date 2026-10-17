/**
 * Every response shape the money request routes return (task INBOX-15), and
 * the one place a stored request becomes the view the app draws. One named
 * interface each, so the generated contract carries a named schema the app
 * can import.
 *
 * Nothing here is a balance. `amountKobo` is what the requester asked for;
 * what the payer pays on top (the provider's charge and WAWU's fee, R-10) is
 * quoted by `GET /money/fees/quote?kind=wawu_transfer`, never stored or
 * guessed here.
 */

/** `pending` until one of the other three, each final. */
export type MoneyRequestStatus = 'pending' | 'paid' | 'declined' | 'cancelled';

export const MONEY_REQUEST_STATUSES: readonly MoneyRequestStatus[] = [
  'pending',
  'paid',
  'declined',
  'cancelled',
];

/** The chat message kind that carries a request. */
export const MONEY_REQUEST_MESSAGE_KIND = 'money_request';

export interface MoneyRequestView {
  id: string;
  chatId: string;
  /** The chat message that carries the request (the bubble). */
  messageId: string | null;
  /** `outgoing` when the caller asked, `incoming` when the caller was asked. */
  direction: 'outgoing' | 'incoming';
  requesterWawuId: string;
  payerWawuId: string;
  /** What the requester asked for, in kobo. */
  amountKobo: number;
  /** What the request is for. Null when the requester gave no reason. */
  memo: string | null;
  status: MoneyRequestStatus;
  /**
   * True while a payment for this request is being made or has not been
   * confirmed yet: the request is still `pending`, but it cannot be paid
   * again, declined or cancelled until the payment settles. If it fails,
   * `paying` goes back to false and the request can be paid again.
   */
  paying: boolean;
  /** ISO time the request was made. */
  createdAt: string;
  /** ISO time `status` last changed. Null while the request is still pending untouched. */
  resolvedAt: string | null;
}

/** The stored row, as the services read it. */
export interface MoneyRequestRow {
  id: string;
  conversationId: string;
  requesterWawuId: string;
  payerWawuId: string;
  amountKobo: bigint;
  memo: string | null;
  status: string;
  messageId: string | null;
  transferId: string | null;
  changedAt: Date | null;
  createdAt: Date;
}

/** The request as `viewer` (one of the two people) sees it. */
export function toMoneyRequestView(
  row: MoneyRequestRow,
  viewer: string,
): MoneyRequestView {
  return {
    id: row.id,
    chatId: row.conversationId,
    messageId: row.messageId,
    direction: row.requesterWawuId === viewer ? 'outgoing' : 'incoming',
    requesterWawuId: row.requesterWawuId,
    payerWawuId: row.payerWawuId,
    amountKobo: Number(row.amountKobo),
    memo: row.memo,
    status: row.status as MoneyRequestStatus,
    paying: row.status === 'pending' && row.transferId !== null,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.changedAt ? row.changedAt.toISOString() : null,
  };
}
