import { Injectable } from '@nestjs/common';
import { HELD_PAYMENT_KINDS, type PaymentKind } from '../dto/money-enums';
import type { MoneyPartyView } from '../money-view.type';

/**
 * What the buyer is paying for, as the feature that sells it knows it
 * (task MONEY-17). The price is always the server's own record of the item,
 * never the app's; only a tip's amount is the payer's (`amountKobo`).
 */
export interface PayableTarget {
  /** What is being paid for, as the owning feature names it ("How I light a night shoot"). */
  title: string;
  /** Positive, integer kobo. */
  priceKobo: number;
  /** Who gets the 85% (R-5); null when WAWU itself is paid (credits, ticks). */
  payee: MoneyPartyView | null;
  /**
   * The currency the price is in, ISO 4217; unset means naira (`NGN`).
   * Only naira is paid from the wallet today (`PAYMENT_CURRENCY`): a feature
   * that prices an item in dollars for someone billed in dollars (R-43)
   * says so here, and the payment is refused until a dollar wallet can pay
   * it (NUV-09), so cents are never charged as kobo.
   */
  currency?: string;
}

/** What a feature is asked to price. */
export interface PayableLookup {
  payerWawuUserId: string;
  targetId: string;
  /** Only on a payer-chosen kind (a tip); undefined on every other kind. */
  amountKobo?: number;
}

/** A payment the wallet provider confirmed, handed to the feature that sold it. */
export interface CompletedPayment {
  paymentId: string;
  payerWawuUserId: string;
  kind: PaymentKind;
  targetId: string;
  priceKobo: number;
  payeeWawuUserId: string | null;
  note: string | null;
}

/**
 * One kind of thing WAWU sells, moved onto the wallet by the task that owns
 * it (docs/contract/WALLET.md, "Pay from wallet: what `targetId` is":
 * HOME-15 unlocks, HOME-14 tips, INBOX-16 credits, ME-18 ticks, LEGAL-05,
 * SCHOOLS-07). That task registers its handler with PayableRegistry from its
 * own module (`onModuleInit`), and `GET /money/payments/quote` and
 * `POST /money/payments` then take its kind.
 *
 * - `resolve` answers the price and the payee, or throws `404
 *   target_not_found` or `409 target_not_payable` (a MoneyError): already
 *   owned, sold out, closed, the payer's own item. It moves nothing and may
 *   be asked more than once for one payment (the quote, then the pay).
 * - `onCompleted` delivers what was paid for once the provider has confirmed
 *   the debit: in the request when it answers at once, else from the
 *   payment sweep when a pending payment settles, and again from the sweep
 *   while it has not succeeded. It MUST be idempotent (it can run twice for
 *   one payment, from two servers) and must not move money: the payee's 85%
 *   lands through WALLET-16 (R-11).
 */
export interface PayableKindHandler {
  readonly kind: PaymentKind;
  resolve(lookup: PayableLookup): Promise<PayableTarget>;
  onCompleted?(payment: CompletedPayment): Promise<void>;
}

/**
 * The kinds that can be paid from a wallet today. Empty until the owning
 * tasks register theirs: a kind nobody registered is answered `409
 * target_not_payable` ("can't be paid from your wallet yet"), so no payment
 * is ever taken for something nothing would deliver.
 *
 * Held kinds (a paid DM, a ticket, a bill: the price waits in WAWU's own
 * account at the provider until something happens, R-19, R-42) are MONEY-18's: they are
 * refused here until it builds the hold, its release and its refund.
 */
@Injectable()
export class PayableRegistry {
  private readonly handlers = new Map<PaymentKind, PayableKindHandler>();

  register(handler: PayableKindHandler): void {
    if (HELD_PAYMENT_KINDS.includes(handler.kind)) {
      throw new Error(
        `PayableRegistry: ${handler.kind} is held until something happens (R-19); MONEY-18 builds held payments.`,
      );
    }
    if (this.handlers.has(handler.kind)) {
      throw new Error(
        `PayableRegistry: ${handler.kind} already has a handler.`,
      );
    }
    this.handlers.set(handler.kind, handler);
  }

  get(kind: PaymentKind): PayableKindHandler | null {
    return this.handlers.get(kind) ?? null;
  }

  /** The kinds registered, for logs and tests. */
  kinds(): PaymentKind[] {
    return [...this.handlers.keys()].sort();
  }
}
