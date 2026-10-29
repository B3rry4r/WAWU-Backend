import { NoticeFacts } from '../../notice-mail/notice-facts';
import { noticeKey, NoticeMailer } from '../../notice-mail/notice-mailer';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HoldRequestError } from '../../money/holds/hold-rules';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { type CalledOffRefunds, EventCancelHooks } from '../event-cancel-hooks';
import {
  CALLED_OFF_NO_PAYMENT_NOTE,
  CALLED_OFF_PAID_OUT_NOTE,
  CALLED_OFF_REASON,
  CALLED_OFF_REFUND_REASON,
} from './event-wallet-order-rules';

/** The buyer did nothing wrong: they get back everything the payment took, Fintava's charge included, and WAWU carries the charge (a losing buyer, a failed bill, a host who left). */
const RETURN_ALL = { returnCharge: true } as const;
/** Orders read at a time. */
const PAGE = 50;
/** Refunds asked of the provider at once. Each holds nothing while it waits. */
const CONCURRENCY = 5;
/** How long the host's cancel request spends sending money back before it leaves the rest to the sweep. */
const REQUEST_BUDGET_MS = 15_000;
const SWEEP_BUDGET_MS = 90_000;

type Outcome = 'refunded' | 'attention' | 'later';

/**
 * Sends the held price of every ticket order of a called-off event back to its
 * buyer (task EVENTS-10, E25).
 *
 * - **Through the hold (R-19).** A wallet order's price waits in WAWU's own
 *   account as a `held` `event_ticket` hold. The buyer is paid by the hold's
 *   own refund, the same call a losing buyer and a host who left get
 *   (EVENTS-07), with everything the payment took (`returnCharge`: the price,
 *   Fintava's charge and WAWU's fee) in one move. WAWU carries the charge. No
 *   money path of its own.
 * - **Once.** The hold decides one way, once, and sends under its own
 *   reference: the cancel, the sweep, a second server or a second cancel all
 *   ask the same hold and only one move ever goes out.
 * - **Holding nothing across the provider.** Every call to the provider is
 *   made by the hold service with no transaction, connection or lock of ours
 *   open, a few at a time, up to a time limit. What the request did not reach
 *   is finished by the sweep.
 * - **The order says so once the refund is chosen.** From then on the money can
 *   only go back (never to the host), so the order reads `refunded` and its
 *   tickets are void; the buyer sees it is on its way until the hold is
 *   confirmed `refunded`. The hold's own sweep finishes a move the provider has
 *   not confirmed.
 * - **A price already paid out** (the event had taken place and the host's share
 *   was released) cannot go back by itself: the order keeps `paid`, records
 *   why in `refundError` (what the Flutterwave path does for a refund it could
 *   not send) and is left for a person.
 * - **Free tickets** have no payment and nothing to send back.
 *
 * It refunds only an event that is called off, whenever the call was made,
 * started or not: a host who is still here chose to call it off.
 */
@Injectable()
export class EventCallOffRefundService implements OnModuleInit {
  private readonly logger = new Logger(EventCallOffRefundService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly holds: WalletHoldService,
    private readonly hooks: EventCancelHooks,
    private readonly mail: NoticeMailer,
    private readonly facts: NoticeFacts,
  ) {}

  onModuleInit(): void {
    this.hooks.register((eventId) => this.refundEvent(eventId));
  }

  /** The host's cancel: the orders of this event, within a time limit. */
  async refundEvent(
    eventId: string,
    budgetMs = REQUEST_BUDGET_MS,
  ): Promise<CalledOffRefunds> {
    const counts: CalledOffRefunds = { refunded: 0, needAttention: 0 };
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      select: { cancelledAt: true },
    });
    // Never send money back for an event that has not been called off.
    if (!event?.cancelledAt) return counts;
    const deadline = Date.now() + budgetMs;
    let after: string | null = null;
    for (;;) {
      const page: Array<{ id: string; walletPaymentId: string | null }> =
        await this.prisma.eventOrder.findMany({
          where: {
            eventId,
            paymentProvider: 'wallet',
            status: 'paid',
            refundError: null,
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true, walletPaymentId: true },
          orderBy: { id: 'asc' },
          take: PAGE,
        });
      if (page.length === 0) break;
      after = page[page.length - 1].id;
      await this.eachWithin(page, deadline, async (order) => {
        const outcome = await this.settleOrder(order);
        if (outcome === 'refunded') counts.refunded += 1;
        else if (outcome === 'attention') counts.needAttention += 1;
      });
      if (page.length < PAGE || Date.now() > deadline) break;
    }
    // EVENTS-13: what this pass did not finish is still `paid` with no
    // `refundError`: orders it never reached (the time ran out) and orders
    // whose refund could not be asked yet. The sweep takes them next; the
    // answer says how many, so every paid order is counted once.
    const left = await this.prisma.eventOrder.count({
      where: {
        eventId,
        paymentProvider: 'wallet',
        status: 'paid',
        refundError: null,
      },
    });
    if (left > 0) counts.leftToSweep = left;
    return counts;
  }

  /** Every minute: the called-off events with an order whose refund was not asked for yet (the provider was slow, the request ran out of time, a server went down). */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'event-called-off-refunds' })
  async sweep(
    budgetMs = SWEEP_BUDGET_MS,
  ): Promise<{ events: number } & CalledOffRefunds> {
    const total = { events: 0, refunded: 0, needAttention: 0 };
    if (this.sweeping) return total;
    this.sweeping = true;
    try {
      const deadline = Date.now() + budgetMs;
      let after: string | null = null;
      for (;;) {
        const page: Array<{ id: string }> = await this.prisma.event.findMany({
          where: {
            cancelledAt: { not: null },
            orders: {
              some: {
                paymentProvider: 'wallet',
                status: 'paid',
                refundError: null,
              },
            },
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: PAGE,
        });
        if (page.length === 0) break;
        for (const e of page) {
          const left = deadline - Date.now();
          if (left <= 0) return total;
          const counts = await this.refundEvent(e.id, left);
          total.events += 1;
          total.refunded += counts.refunded;
          total.needAttention += counts.needAttention;
        }
        after = page[page.length - 1].id;
        if (page.length < PAGE) break;
      }
      return total;
    } catch (e) {
      this.logger.error(
        `called-off refund sweep failed (${e instanceof Error ? e.name : 'error'})`,
      );
      return total;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * One paid order: asks its hold to refund (everything paid, once), then
   * says so on the order. Holds nothing while the provider answers.
   */
  private async settleOrder(order: {
    id: string;
    walletPaymentId: string | null;
  }): Promise<Outcome> {
    try {
      if (!order.walletPaymentId) {
        return await this.needsAPerson(order.id, CALLED_OFF_NO_PAYMENT_NOTE);
      }
      const hold = await this.prisma.walletHold.findUnique({
        where: { paymentId: order.walletPaymentId },
        select: { id: true, status: true, action: true },
      });
      if (!hold) {
        return await this.needsAPerson(order.id, CALLED_OFF_NO_PAYMENT_NOTE);
      }
      if (hold.action === 'release' || hold.status === 'released') {
        return await this.needsAPerson(order.id, CALLED_OFF_PAID_OUT_NOTE);
      }
      if (hold.action !== 'refund' && hold.status !== 'refunded') {
        try {
          await this.holds.refund(
            { holdId: hold.id },
            CALLED_OFF_REFUND_REASON,
            RETURN_ALL,
          );
        } catch (e) {
          if (
            e instanceof HoldRequestError &&
            e.code === 'other_action_chosen'
          ) {
            // A release got there first (the event had taken place).
            return await this.needsAPerson(order.id, CALLED_OFF_PAID_OUT_NOTE);
          }
          this.logger.warn(
            `order ${order.id}: refund not asked yet (${e instanceof HoldRequestError ? e.code : e instanceof Error ? e.name : 'error'})`,
          );
        }
      }
      // The refund is chosen now, whether or not the provider has confirmed the
      // move: the hold can only go back to the buyer from here.
      const chosen = await this.prisma.walletHold.findUnique({
        where: { id: hold.id },
        select: { status: true, action: true },
      });
      if (chosen?.action === 'refund' || chosen?.status === 'refunded') {
        await this.markRefunded(order.id);
        return 'refunded';
      }
      return 'later';
    } catch (e) {
      this.logger.error(
        `order ${order.id}: called-off refund failed (${e instanceof Error ? e.name : 'error'}); the sweep looks again`,
      );
      return 'later';
    }
  }

  /** The order says its price is going back to the buyer, and its tickets can no longer be scanned. */
  private async markRefunded(orderId: string): Promise<void> {
    const [marked] = await this.prisma.$transaction([
      this.prisma.eventOrder.updateMany({
        where: { id: orderId, status: 'paid' },
        data: { status: 'refunded', failureReason: CALLED_OFF_REASON },
      }),
      this.prisma.eventTicket.updateMany({
        where: { orderId, status: { not: 'void' } },
        data: { status: 'void' },
      }),
    ]);
    // EMAIL-02: told once, by the call that marked the order (a sweep that
    // finds it refunded does not tell again).
    if (marked.count === 1) this.emailRefund(orderId);
  }

  /** The buyer is told their price is back: everything the payment took (the charge too). */
  private emailRefund(orderId: string): void {
    this.mail.later(async () => {
      const order = await this.prisma.eventOrder.findUnique({
        where: { id: orderId },
        select: {
          buyerWawuId: true,
          walletPaymentId: true,
          event: { select: { name: true } },
        },
      });
      if (!order?.walletPaymentId) return;
      const paid = await this.facts.payment(order.walletPaymentId);
      if (!paid) return;
      this.mail.notify(
        order.buyerWawuId,
        'refund_processed',
        {
          what: order.event.name,
          amountMinor: paid.totalKobo,
          currency: 'NGN',
          returnedTo: 'wallet',
        },
        noticeKey('refund_processed', 'event', orderId),
      );
    });
  }

  /** The price cannot go back by itself: the order keeps `paid` and says why, for a person. */
  private async needsAPerson(orderId: string, note: string): Promise<Outcome> {
    await this.prisma.eventOrder.updateMany({
      where: { id: orderId, status: 'paid', refundError: null },
      data: { refundError: note },
    });
    this.logger.error(`order ${orderId}: ${note}`);
    return 'attention';
  }

  /** Runs `fn` on each item, a few at a time, starting no new one after the deadline. */
  private async eachWithin<T>(
    items: T[],
    deadline: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < items.length && Date.now() <= deadline) {
        const item = items[next];
        next += 1;
        await fn(item);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
    );
  }
}
