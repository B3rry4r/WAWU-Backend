import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountPurgeHooks } from '../../account-purge/purge-hooks';
import { HoldRequestError } from '../../money/holds/hold-rules';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { EVENT_TICKET_PAYMENT_KIND } from './event-wallet-order-rules';

/**
 * Stands in for the host of an event whose host erased their account while
 * buyers' money was still held for it. It names nobody.
 */
export const ERASED_HOST = 'erased-host';

const ERASED_REASON = 'The host closed their account.';
const REFUND_REASON = 'the host closed their account';
/** The most one pass looks at, so one slow provider cannot stall the rest. */
const PAGE = 50;
/** How long the purge itself spends sending money back before it leaves the rest to the sweep. */
const PURGE_BUDGET_MS = 20_000;
const SWEEP_BUDGET_MS = 90_000;

/**
 * When a host erases their account, the events they ran cannot happen (task
 * EVENTS-07 round 2, the lead's ruling), so their buyers' money goes back.
 *
 * - **Before any event row goes.** `Event` is the host's own data, so the
 *   account purge deletes it, and the orders of an event go with it (the order
 *   cascades). An order that paid from the wallet is a held price (R-19): if
 *   the order went while its hold stayed `held`, the price would wait for ever
 *   with nothing to release it. So the purge calls `beforeErase` first.
 * - **Detach first, then settle.** `beforeErase` makes every event of the host
 *   that has a wallet order name nobody (`ERASED_HOST`) and takes it down, in
 *   one statement, so the purge's own delete by host no longer reaches it
 *   whatever happens next. It then sends each held price back to its payer
 *   through the existing hold refund, holding nothing across the provider's
 *   answer. An event whose every hold is back is deleted (the order is marked
 *   refunded and its tickets void just before). An event with a hold that
 *   cannot be settled now (the provider is down or has not answered, the
 *   wallet is frozen, a release is already under way) is KEPT, with its
 *   orders, and the sweep tries it again until its money has moved.
 * - **Once.** The refund is the hold's own, asked again by the sweep, a second
 *   server or a second purge: the hold's reference makes it one move.
 * - **A debit still being confirmed** keeps the event too: the price is not
 *   held yet, and it is refunded by the order's delivery if it lands.
 */
@Injectable()
export class EventHostErasureService implements OnModuleInit {
  private readonly logger = new Logger(EventHostErasureService.name);
  private sweeping = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly holds: WalletHoldService,
    private readonly hooks: AccountPurgeHooks,
  ) {}

  onModuleInit(): void {
    this.hooks.register((hostWawuId) => this.beforeErase(hostWawuId));
  }

  /**
   * Called by the account purge before it deletes a row. Throws only when the
   * detaching could not be done, which stops the purge with nothing deleted.
   */
  async beforeErase(hostWawuId: string): Promise<void> {
    const events = await this.prisma.event.findMany({
      where: { hostWawuId, orders: { some: { paymentProvider: 'wallet' } } },
      select: { id: true },
    });
    if (events.length === 0) return;
    const ids = events.map((e) => e.id);
    await this.prisma.event.updateMany({
      where: { id: { in: ids }, hostWawuId },
      data: {
        hostWawuId: ERASED_HOST,
        status: 'removed',
        featured: false,
        lastDecisionReason: ERASED_REASON,
      },
    });
    const deadline = Date.now() + PURGE_BUDGET_MS;
    let kept = 0;
    for (const id of ids) {
      if (!(await this.settle(id, deadline))) kept += 1;
    }
    if (kept > 0) {
      this.logger.warn(
        `${kept} event(s) of an erased host are kept until the buyers' money is back; the sweep tries again`,
      );
    }
  }

  /** Every few minutes: the kept events whose money may be back by now. */
  @Cron(CronExpression.EVERY_5_MINUTES, { name: 'event-host-erasure' })
  async sweep(
    budgetMs = SWEEP_BUDGET_MS,
  ): Promise<{ kept: number; deleted: number }> {
    const counts = { kept: 0, deleted: 0 };
    if (this.sweeping) return counts;
    this.sweeping = true;
    try {
      const deadline = Date.now() + budgetMs;
      let after: string | null = null;
      for (;;) {
        const page: Array<{ id: string }> = await this.prisma.event.findMany({
          where: {
            hostWawuId: ERASED_HOST,
            ...(after ? { id: { gt: after } } : {}),
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: PAGE,
        });
        if (page.length === 0) break;
        for (const e of page) {
          if (Date.now() > deadline) return counts;
          if (await this.settle(e.id, deadline)) counts.deleted += 1;
          else counts.kept += 1;
        }
        after = page[page.length - 1].id;
        if (page.length < PAGE) break;
      }
      return counts;
    } catch (e) {
      this.logger.error(
        `event host erasure sweep failed (${e instanceof Error ? e.name : 'error'})`,
      );
      return counts;
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Sends back every price held for the event's wallet orders and deletes the
   * event once none is held. True when the event is gone. Each provider call
   * is made holding nothing: no transaction, no lock.
   */
  async settle(eventId: string, deadline: number): Promise<boolean> {
    const orders = await this.prisma.eventOrder.findMany({
      where: { eventId, paymentProvider: 'wallet' },
      select: { id: true },
    });
    const ids = orders.map((o) => o.id);
    if (ids.length > 0) {
      if (await this.unconfirmed(ids)) return false;
      const held = await this.prisma.walletHold.findMany({
        where: {
          kind: EVENT_TICKET_PAYMENT_KIND,
          status: 'held',
          targetId: { in: ids },
        },
        select: { id: true, targetId: true },
        orderBy: { id: 'asc' },
      });
      for (const hold of held) {
        if (Date.now() > deadline) return false;
        try {
          await this.holds.refund({ holdId: hold.id }, REFUND_REASON);
        } catch (e) {
          // A hold that went the other way (a release under way), or one the
          // provider would not move now: the event waits for the sweep.
          this.logger.warn(
            `event ${eventId}: hold ${hold.id} not refunded yet (${e instanceof HoldRequestError ? e.code : e instanceof Error ? e.name : 'error'})`,
          );
        }
      }
      // Every price that is back with its buyer, by this pass or an earlier
      // one (the hold sweep may have finished a move): the order says so.
      const back = await this.prisma.walletHold.findMany({
        where: {
          kind: EVENT_TICKET_PAYMENT_KIND,
          status: 'refunded',
          targetId: { in: ids },
        },
        select: { targetId: true },
      });
      for (const hold of back) await this.markRefunded(hold.targetId);
      if (await this.stillHeld(ids)) return false;
      if (await this.unconfirmed(ids)) return false;
    }
    try {
      const { count } = await this.prisma.event.deleteMany({
        where: { id: eventId, hostWawuId: ERASED_HOST },
      });
      return count > 0;
    } catch (e) {
      this.logger.error(
        `event ${eventId}: could not be deleted (${e instanceof Error ? e.name : 'error'}); it is kept`,
      );
      return false;
    }
  }

  /** A debit for one of these orders is not confirmed yet: its price is not held, but may be. */
  private async unconfirmed(orderIds: string[]): Promise<boolean> {
    return (
      (await this.prisma.walletPayment.count({
        where: {
          kind: EVENT_TICKET_PAYMENT_KIND,
          targetId: { in: orderIds },
          status: 'pending',
        },
      })) > 0
    );
  }

  private async stillHeld(orderIds: string[]): Promise<boolean> {
    return (
      (await this.prisma.walletHold.count({
        where: {
          kind: EVENT_TICKET_PAYMENT_KIND,
          status: 'held',
          targetId: { in: orderIds },
        },
      })) > 0
    );
  }

  /** The price is back with the buyer: the order says so and its tickets can no longer be scanned. */
  private async markRefunded(orderId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.eventOrder.updateMany({
        where: { id: orderId, status: { in: ['pending', 'paid'] } },
        data: { status: 'refunded', failureReason: ERASED_REASON },
      }),
      this.prisma.eventTicket.updateMany({
        where: { orderId, status: { not: 'void' } },
        data: { status: 'void' },
      }),
    ]);
  }
}
