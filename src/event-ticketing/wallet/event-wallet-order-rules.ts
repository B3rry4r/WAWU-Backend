import { randomInt } from 'node:crypto';
import { MoneyError } from '../../money/money-error';
import { MAX_TICKETS_PER_ORDER } from '../event-ticketing.constants';

/**
 * The rules of an order paid from the wallet (task EVENTS-07) that need no
 * database: what a basket may hold, whether it can be bought now, and what
 * state it is in. The service reads the rows and asks these.
 */

/** How many different ticket types one order may hold (an event has at most 20). */
export const MAX_ORDER_LINES = 20;

/** The payment kind the order is paid under (docs/contract/WALLET.md). */
export const EVENT_TICKET_PAYMENT_KIND = 'event_ticket' as const;

/** The pay route's key scope (idempotency.ts): `POST /events/orders/wallet/pay`. */
export const EVENT_ORDER_PAY_ROUTE = 'POST events/orders/wallet/pay';

export const ORDER_NOT_FOUND_MESSAGE = 'We could not find that order.';
export const EVENT_NOT_FOUND_MESSAGE = 'Event not found.';
export const TICKET_NOT_FOUND_MESSAGE = 'That ticket is not on this event.';
export const NOT_ON_SALE_MESSAGE = 'Tickets are not on sale for this event.';
export const CANCELLED_MESSAGE = 'This event has been cancelled.';
export const OWN_EVENT_MESSAGE = 'You cannot buy tickets to your own event.';
export const NOT_OPEN_MESSAGE = 'Sales have not opened for this ticket yet.';
export const CLOSED_MESSAGE = 'Sales have closed for this ticket.';
export const SOLD_OUT_MESSAGE = 'This ticket is sold out.';
export const ORDER_PAID_MESSAGE = 'These tickets are already paid for.';
export const ORDER_FAILED_MESSAGE =
  'This order could not be completed. Pick your tickets again.';
export const ORDER_CHANGED_MESSAGE =
  'The price of these tickets changed. Pick your tickets again.';
export const ORDER_FAILED_RETURNED_REASON =
  'The tickets sold out or the event was called off before your order was finished. Your money is back in your wallet.';
export const ORDER_FAILED_RETURNING_REASON =
  'The tickets sold out or the event was called off before your order was finished. Your money is on its way back to your wallet.';
export const KEY_REUSED_MESSAGE =
  'That Idempotency-Key was used for different tickets. Use a new key for a new order.';
export const KEY_MALFORMED_MESSAGE =
  'Idempotency-Key must be 8 to 128 letters, digits, dashes or underscores.';

/** The Idempotency-Key a creation may carry (CONVENTIONS.md section 4). */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** What a person is shown of where an order stands. */
export type EventOrderProgress =
  'awaiting_payment' | 'processing' | 'paid' | 'failed';

/** The order columns progress is read from. */
export function progressOf(
  status: string,
  hasOpenOrDonePayment: boolean,
): EventOrderProgress {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'failed':
    case 'refunded':
      return 'failed';
    default:
      return hasOpenOrDonePayment ? 'processing' : 'awaiting_payment';
  }
}

/** One line of a basket as the buyer asked for it. */
export interface BasketAsk {
  ticketTypeId: string;
  quantity: number;
}

/**
 * The lines of a request, one per ticket type. The same type twice is the
 * caller's mistake (`null` is returned), not a quantity to add up: the app
 * sends one stepper per tier.
 */
export function distinctLines(asks: readonly BasketAsk[]): BasketAsk[] | null {
  const seen = new Set<string>();
  for (const a of asks) {
    if (seen.has(a.ticketTypeId)) return null;
    seen.add(a.ticketTypeId);
  }
  return [...asks];
}

/** The tickets in a basket, and the most one order may hold. */
export function ticketCountOf(asks: readonly BasketAsk[]): number {
  return asks.reduce((n, a) => n + a.quantity, 0);
}

export function overOrderLimit(asks: readonly BasketAsk[]): boolean {
  return ticketCountOf(asks) > MAX_TICKETS_PER_ORDER;
}

export interface BuyableEvent {
  hostWawuId: string;
  status: string;
  cancelledAt: Date | null;
  startsAt: Date;
}

export interface BuyableTier {
  name: string;
  priceNaira: number;
  quantity: number;
  sold: number;
  salesStartAt: Date | null;
  salesEndAt: Date | null;
}

/** The total of a basket in naira: each tier's price times what is asked. */
export function totalNairaOf(
  lines: ReadonlyArray<{ priceNaira: number; quantity: number }>,
): number {
  return lines.reduce((n, l) => n + l.priceNaira * l.quantity, 0);
}

/**
 * Why this basket cannot be bought now, or null when it can: the same rules
 * the web's single-tier `buy` applies (on sale, not called off, not the
 * host's own, the tier's window, what is left), asked once per line. Asked
 * when the order is made, again when it is quoted and again inside the
 * payment's claim, so a quote that has gone stale is refused before any
 * debit.
 */
export function buyRefusal(
  event: BuyableEvent,
  buyerWawuId: string,
  basket: ReadonlyArray<{ tier: BuyableTier; quantity: number }>,
  now: Date,
): MoneyError | null {
  const notPayable = (message: string) =>
    new MoneyError('target_not_payable', message);
  if (event.cancelledAt || event.status === 'cancelled') {
    return notPayable(CANCELLED_MESSAGE);
  }
  if (event.status !== 'published') return notPayable(NOT_ON_SALE_MESSAGE);
  if (buyerWawuId === event.hostWawuId) return notPayable(OWN_EVENT_MESSAGE);
  for (const { tier, quantity } of basket) {
    if (tier.salesStartAt && now < tier.salesStartAt) {
      return notPayable(`Sales have not opened for ${tier.name} yet.`);
    }
    const salesEnd = tier.salesEndAt ?? event.startsAt;
    if (now > salesEnd) {
      return notPayable(`Sales have closed for ${tier.name}.`);
    }
    if (tier.sold + quantity > tier.quantity) {
      const left = Math.max(0, tier.quantity - tier.sold);
      return notPayable(
        left === 0
          ? `${tier.name} is sold out.`
          : `Only ${left} of ${tier.name} left.`,
      );
    }
  }
  return null;
}

/** An ORDER the buyer did not make, or none at all: the same answer. */
export function orderNotFound(): MoneyError {
  return new MoneyError('target_not_found', ORDER_NOT_FOUND_MESSAGE);
}

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** The reference a person quotes: `WAW-EVT-` and eight characters nobody mistakes for another. */
export function newOrderReference(): string {
  let tail = '';
  for (let i = 0; i < 8; i += 1) {
    tail += REFERENCE_ALPHABET[randomInt(REFERENCE_ALPHABET.length)];
  }
  return `WAW-EVT-${tail}`;
}

/** The required `flutterwaveTxRef` of a wallet order: no Flutterwave charge can carry it. */
export function walletOrderTxRef(orderId: string): string {
  return `wawu-event-wallet-${orderId}`;
}
