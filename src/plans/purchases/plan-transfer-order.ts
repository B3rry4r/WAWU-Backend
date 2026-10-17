import type { PlanTransferOrder } from '../../../generated/prisma/client';
import { termsDigest, termsFromJson } from '../../money/payments/payable-terms';
import type { PayableTerms } from '../../money/payments/payable-terms';
import type { PurchasePaymentKind } from './plan-purchase-terms';

/**
 * Pay a purchase by bank transfer at checkout (task TIER-05, VF6 "transfer
 * details shown", PT4). Pure parts: the order's states, its words, and the
 * rules the settlement checks. No database and no provider here.
 *
 * The person confirms with their PIN at checkout at ONE quote: the price, the
 * Bank charge, the total and the goods. That is an order. They then send money
 * to their own wallet account (R-42: money comes in by bank transfer only, into
 * the person's own account number; WAWU runs no collection account). When the
 * provider's available balance covers the total, the order is paid from the
 * wallet through the same path as a wallet purchase (MONEY-17, TIER-03), once.
 */

/** An order's stored state. The API words (`awaiting_transfer`, ...) are the view's. */
export const ORDER_STATUS = {
  /** Waiting for the money. */
  awaiting: 'awaiting',
  /** The settlement holds it: the balance is being read, or the payment is being made. */
  settling: 'settling',
  /** A wallet payment exists for it (`paymentId`); the payment says the rest. */
  settled: 'settled',
  /** The window lapsed with no payment. */
  expired: 'expired',
  /** Closed with no payment: not payable any more, the quote changed, paid another way, or replaced. */
  closed: 'closed',
} as const;
export type OrderStatus = (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS];

/** The states in which an order still holds its item (`openKey` is set). */
export const OPEN_ORDER_STATES: readonly OrderStatus[] = [
  ORDER_STATUS.awaiting,
  ORDER_STATUS.settling,
];

/**
 * Milliseconds in a minute and an hour. Timings below are written from these:
 * `src/plans` writes no number that equals a figure of the plan file
 * (plans-figures.spec.ts), and a pass interval is not one.
 */
export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const SECOND_MS = MINUTE_MS / 60;

export const TRANSFER_DEFAULTS = {
  /** Between two passes of the settlement sweep. */
  sweepMs: 8_000,
  /** Rows read at a time when a pass looks for stale claims. Never a limit on what a pass settles. */
  batch: 64,
  /** Waiting orders read at a time when a pass looks for the people who are due. */
  scanPage: 512,
  /** People whose newest money-in row is looked up in one read. */
  lookupPage: 256,
  /**
   * How long a pass keeps starting on people who are due. What it did not get
   * to is still due (an order it settled or checked is not), and the next pass
   * takes the oldest of those first.
   */
  sweepBudgetMs: 18 * SECOND_MS,
  /** People settled at the same time in a pass. */
  concurrency: 4,
  /**
   * How often the balance of a person with a waiting order is read although
   * no new money-in row came: a safety net for a credit the sweep did not see.
   */
  recheckMs: 4 * MINUTE_MS,
  /** The longest rest after an attempt that could not be made (the provider down, a limit). */
  maxBackoffMs: 16 * MINUTE_MS,
  /** Added to the provider's money timeout before a claim is taken to be dead. */
  staleGraceMs: MINUTE_MS + MINUTE_MS,
} as const;

/**
 * The idempotency key the settlement pays an order under: one payment per
 * order. It holds a colon, which the Idempotency-Key header does not allow
 * (8 to 128 letters, digits, - or _), so a person can never send it: their
 * own keys and the settlement's never meet.
 */
export function settleKeyOf(orderId: string): string {
  return `transfer:${orderId}`;
}

/** One waiting order per person and item: unique while the order is open. */
export function orderOpenKey(
  wawuUserId: string,
  paymentKind: PurchasePaymentKind,
  targetId: string,
): string {
  return `${wawuUserId}:${paymentKind}:${targetId}`;
}

export const EXPIRED_MESSAGE =
  'The time to send the money ran out. Nothing was taken from your wallet, and any money you sent is still in it.';
export const REPLACED_MESSAGE =
  'You started this purchase again, so this one was closed. Nothing was taken from your wallet.';
export const QUOTE_CHANGED_MESSAGE =
  'The price or what comes with it changed before your money arrived, so this purchase was not made. Nothing was taken from your wallet. Start again to buy at the new price.';
export const PAID_ANOTHER_WAY_MESSAGE =
  'You paid for this another way, so this purchase was closed. Nothing more was taken from your wallet.';
export const NO_WALLET_ANY_MORE_MESSAGE =
  'Your wallet is not available, so this purchase was not made. Nothing was taken.';
export const NOT_PAYABLE_ANY_MORE_MESSAGE =
  'This purchase cannot be made any more. Nothing was taken from your wallet.';
export const SETTLING_MESSAGE =
  'Your money arrived. We are completing your purchase. Do not pay again.';
export const PAYMENT_FAILED_WAITING_MESSAGE =
  'Your money arrived, but the payment did not go through and nothing was taken from your wallet. We will try again while this purchase is still open.';
export const LIMIT_WAITING_MESSAGE =
  'Your money arrived, but a limit stops the purchase for now. It will go through as soon as the limit allows, while this purchase is still open.';

/** True when the order's window has lapsed at `now`. */
export function lapsed(order: Pick<PlanTransferOrder, 'expiresAt'>, now: Date) {
  return order.expiresAt.getTime() <= now.getTime();
}

/**
 * The part of a quote an order is bound to: the price and the goods the person
 * confirmed, and the total with the Bank charge. A current quote that differs
 * in any of them is not the one the PIN was given for.
 */
export interface QuoteFacts {
  priceKobo: number;
  totalKobo: number;
  terms: PayableTerms | undefined;
}

export function sameQuote(
  order: Pick<PlanTransferOrder, 'priceKobo' | 'totalKobo' | 'terms'>,
  now: QuoteFacts,
): boolean {
  if (order.priceKobo !== now.priceKobo || order.totalKobo !== now.totalKobo)
    return false;
  const then = termsFromJson(order.terms);
  if (then === null || now.terms === undefined)
    return then === null && now.terms === undefined;
  return termsDigest(then) === termsDigest(now.terms);
}

/** The amount still needed: the total less the available balance, never below 0. */
export function amountNeeded(totalKobo: number, availableKobo: number): number {
  return Math.max(0, totalKobo - availableKobo);
}

/** The rest before an attempt is made again after the n-th one that could not be: 1, 2, 4 ... minutes. */
export function backoffMs(checks: number): number {
  return Math.min(
    TRANSFER_DEFAULTS.maxBackoffMs,
    MINUTE_MS * (1 << Math.min(checks, 4)),
  );
}

/** What the sweep needs of a waiting order to say whether it is due. */
export type WaitingFacts = Pick<
  PlanTransferOrder,
  'wawuUserId' | 'createdAt' | 'creditsSeenAt' | 'nextCheckAt'
>;

/**
 * The people with a waiting order that is due, in the order the sweep settles
 * them. An order is due when a money-in row is newer than what it last looked
 * at (`creditsSeenAt`, else its own creation), or its recheck time has come.
 * People a new credit may have paid for come first, then those whose recheck
 * came, each oldest waiting order first. `latestCredit` is each person's
 * newest money-in row the Hub knows of.
 */
export function duePeople(
  orders: readonly WaitingFacts[],
  latestCredit: ReadonlyMap<string, Date>,
  now: Date,
): string[] {
  const byCredit = new Map<string, number>();
  const byTimer = new Map<string, number>();
  const note = (into: Map<string, number>, person: string, at: number) =>
    into.set(person, Math.min(into.get(person) ?? at, at));
  for (const o of orders) {
    const at = o.createdAt.getTime();
    const latest = latestCredit.get(o.wawuUserId);
    const seen = (o.creditsSeenAt ?? o.createdAt).getTime();
    if (latest !== undefined && latest.getTime() > seen)
      note(byCredit, o.wawuUserId, at);
    else if (o.nextCheckAt !== null && o.nextCheckAt.getTime() <= now.getTime())
      note(byTimer, o.wawuUserId, at);
  }
  const oldestFirst = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
      .map(([person]) => person);
  const credited = oldestFirst(byCredit);
  const asked = new Set(credited);
  return [...credited, ...oldestFirst(byTimer).filter((p) => !asked.has(p))];
}
