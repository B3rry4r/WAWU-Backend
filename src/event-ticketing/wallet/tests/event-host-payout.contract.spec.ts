import { randomUUID } from 'node:crypto';
import {
  bootPayApp,
  type PayHarness,
  type PayPerson,
} from '../../../../test/payments/wallet-pay-harness';
import { body, until } from '../../../../test/payments/poll-helpers';
import { EventHostPayoutService } from '../event-host-payout.service';
import { EventWalletOrdersModule } from '../event-wallet-orders.module';
import type {
  EventWalletOrderQuoteView,
  EventWalletOrderView,
} from '../event-wallet-order-view.type';

/**
 * WALLET-17, event tickets, on the wallet provider seam with NUVION stood in:
 * the host's 85% of the tickets sold (R-5) is paid from WAWU's own account
 * through the tickets' holds once the event has taken place, once, however
 * many times the job runs; a host with no wallet keeps it (R-11); an event
 * called off pays nobody. After each, the ledger agrees with the stand-in,
 * WAWU's operational account included. No Nuvion, Fintava or wawuafrica.com
 * host is called.
 */

jest.setTimeout(240_000);

const RICH = 50_000_000;
const PRICE_NAIRA = 5_000;
const TICKET = PRICE_NAIRA * 100; // 500,000 kobo
const HOUR = 3_600_000;

describe('Hosts receive their share of ticket sales (WALLET-17), Nuvion stood in', () => {
  let h: PayHarness;
  let payout: EventHostPayoutService;
  const events: string[] = [];

  beforeAll(async () => {
    h = await bootPayApp('w17e', {
      modules: [EventWalletOrdersModule],
      cleanup: async (prisma, users) => {
        await prisma.event.deleteMany({ where: { id: { in: events } } });
        await prisma.notification.deleteMany({
          where: { userWawuId: { in: users } },
        });
      },
    });
    payout = h.app.get(EventHostPayoutService, { strict: false });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.nuvion.mode = 'successful';
  });

  /** A published event in ten days with one ticket type at ₦5,000. */
  async function event(host: PayPerson) {
    const created = await h.prisma.event.create({
      data: {
        hostWawuId: host.id,
        name: 'Creators Summit',
        description: 'A day for creators.',
        hostOrg: 'WAWU',
        format: 'in_person',
        type: 'summit',
        startsAt: new Date(Date.now() + 10 * 24 * HOUR),
        endsAt: new Date(Date.now() + 10 * 24 * HOUR + 4 * HOUR),
        location: 'Lagos',
        status: 'published',
        ticketTypes: {
          create: [
            {
              tier: 'regular',
              name: 'Regular',
              priceNaira: PRICE_NAIRA,
              quantity: 100,
            },
          ],
        },
      },
      include: { ticketTypes: true },
    });
    events.push(created.id);
    return { id: created.id, tierId: created.ticketTypes[0].id };
  }
  /** The event has taken place: it ended `hoursAgo` hours ago. */
  const tookPlace = (id: string, hoursAgo = 1) =>
    h.prisma.event.update({
      where: { id },
      data: {
        startsAt: new Date(Date.now() - (hoursAgo + 3) * HOUR),
        endsAt: new Date(Date.now() - hoursAgo * HOUR),
      },
    });
  /** Orders and pays `quantity` tickets; the order id. */
  async function buy(
    buyer: PayPerson,
    ev: { id: string; tierId: string },
    quantity = 1,
  ) {
    const made = await h.post(
      buyer,
      `/events/${ev.id}/orders/wallet`,
      { lines: [{ ticketTypeId: ev.tierId, quantity }] },
      { pin: null },
    );
    expect(made.status).toBe(201);
    const q = body<EventWalletOrderQuoteView>(made).data!;
    const res = await h.post(buyer, '/events/orders/wallet/pay', {
      orderId: q.order.id,
      expectedTotalKobo: q.payment!.totalKobo,
      quoteToken: q.payment!.quoteToken,
    });
    expect(res.status).toBe(201);
    const order = body<EventWalletOrderView>(res).data!;
    expect(order.status).toBe('paid');
    return order.id;
  }
  const holdOfOrder = async (orderId: string) => {
    const o = await h.prisma.eventOrder.findUniqueOrThrow({
      where: { id: orderId },
    });
    return h.prisma.walletHold.findUniqueOrThrow({
      where: { paymentId: o.walletPaymentId! },
    });
  };
  const paidTo = (p: PayPerson) =>
    h.nuvion
      .sendsFrom(h.nuvion.operational.accountId)
      .filter((t) => t.toAccountId === p.account!.accountId);
  const balance = (p: PayPerson) =>
    h.nuvion.accounts.get(p.account!.accountId)!.availableKobo;
  async function operationalAgrees(): Promise<void> {
    const rows = await h.prisma.fintavaLedgerEntry.findMany({
      where: {
        accountNumber: h.nuvion.operational.nuvionBan,
        status: 'completed',
      },
      select: { direction: true, amountKobo: true, totalKobo: true },
    });
    let held = 50_000_000n;
    for (const r of rows)
      held += r.direction === 'in' ? r.amountKobo : -r.totalKobo;
    expect(h.nuvion.operational.availableKobo).toBe(held);
  }
  async function settleHolds(orderIds: string[]) {
    await until(async () => {
      await h.pass();
      const holds = await Promise.all(orderIds.map(holdOfOrder));
      return holds.every((x) => x.status === 'released');
    }, 'the holds to be released');
  }

  it("after the event the host's wallet receives 85% of the tickets once, even if the payout job runs twice", async () => {
    const host = await h.person(0);
    const ev = await event(host);
    const a = await h.person(RICH);
    const b = await h.person(RICH);
    const first = await buy(a, ev, 2);
    const second = await buy(b, ev, 1);
    const held = TICKET * 3;
    const op0 = h.nuvion.operational.availableKobo;

    // Not over yet: nothing is paid, and the money waits in WAWU's account.
    expect(await payout.sweep()).toEqual({ released: 0, refundedFirst: 0 });
    expect(balance(host)).toBe(0n);
    expect((await holdOfOrder(first)).status).toBe('held');

    await tookPlace(ev.id);
    const counts = await payout.sweep();
    expect(counts.released).toBe(2);
    await settleHolds([first, second]);
    const share = (held * 85) / 100;
    expect(balance(host)).toBe(BigInt(share));
    expect(paidTo(host)).toHaveLength(2);
    expect(paidTo(host).reduce((n, t) => n + t.request.amount, 0)).toBe(share);
    // WAWU kept its 15% and carries the charge on each release (R-31).
    expect(op0 - h.nuvion.operational.availableKobo).toBe(
      BigInt(share) + 2n * 2325n,
    );

    // The job again, twice at once, and the sweeps: nothing more is paid.
    expect(await payout.sweep()).toEqual({ released: 0, refundedFirst: 0 });
    await Promise.all([payout.sweep(), payout.sweep()]);
    await h.pass();
    expect(paidTo(host)).toHaveLength(2);
    expect(balance(host)).toBe(BigInt(share));
    // The host sees it as earned.
    const earned = await h.prisma.walletHold.count({
      where: {
        payeeWawuUserId: host.id,
        action: 'release',
        status: 'released',
      },
    });
    expect(earned).toBe(2);
    await h.expectLedgerEqualsStandIn([a, b, host]);
    await operationalAgrees();
  });

  it('a host without a wallet keeps the share, and it lands once when they open one (R-11)', async () => {
    const host = h.walletless();
    const ev = await event(host);
    const buyer = await h.person(RICH);
    const order = await buy(buyer, ev, 2);
    await tookPlace(ev.id);
    expect((await payout.sweep()).released).toBe(1);
    await h.pass();
    await h.pass();
    const hold = await holdOfOrder(order);
    expect(hold.status).toBe('held');
    expect(hold.action).toBe('release');

    const opened = await h.person(0);
    await h.prisma.fintavaWallet.update({
      where: { wawuUserId: opened.id },
      data: { wawuUserId: host.id },
    });
    await settleHolds([order]);
    expect(balance(opened)).toBe(BigInt((TICKET * 2 * 85) / 100));
    await payout.sweep();
    await h.pass();
    expect(paidTo(opened)).toHaveLength(1);
    await h.expectLedgerEqualsStandIn([buyer]);
    await operationalAgrees();
  });

  it('an event called off, an order that is not paid, and an event not over pay nobody', async () => {
    const host = await h.person(0);
    const buyer = await h.person(RICH);

    const off = await event(host);
    const offOrder = await buy(buyer, off);
    await h.prisma.event.update({
      where: { id: off.id },
      data: { status: 'cancelled', cancelledAt: new Date() },
    });
    await tookPlace(off.id);

    const refunded = await event(host);
    const refundedOrder = await buy(buyer, refunded);
    await h.prisma.eventOrder.update({
      where: { id: refundedOrder },
      data: { status: 'refunded' },
    });
    await tookPlace(refunded.id);

    const future = await event(host);
    const futureOrder = await buy(buyer, future);

    expect(await payout.sweep()).toEqual({ released: 0, refundedFirst: 0 });
    for (const id of [offOrder, refundedOrder, futureOrder]) {
      expect((await holdOfOrder(id)).action).toBeNull();
    }
    expect(paidTo(host)).toHaveLength(0);
    expect(balance(host)).toBe(0n);
  });

  it('a refund and the payout racing for one ticket go one way only', async () => {
    const host = await h.person(0);
    const ev = await event(host);
    const buyer = await h.person(RICH);
    const order = await buy(buyer, ev);
    await tookPlace(ev.id);
    const paymentId = (await holdOfOrder(order)).paymentId;
    const [, refund] = await Promise.allSettled([
      payout.sweep(),
      h.holds.refund({ paymentId }, 'called off', { returnCharge: true }),
    ]);
    await until(async () => {
      await h.pass();
      const hold = await holdOfOrder(order);
      return hold.status === 'released' || hold.status === 'refunded';
    }, 'the hold to settle');
    const hold = await holdOfOrder(order);
    expect(hold.action).toBe(
      refund.status === 'fulfilled' ? 'refund' : 'release',
    );
    const toHost = paidTo(host).length;
    const toBuyer = h.nuvion
      .sendsFrom(h.nuvion.operational.accountId)
      .filter((t) => t.toAccountId === buyer.account!.accountId).length;
    expect([toHost, toBuyer]).toEqual(
      hold.action === 'release' ? [1, 0] : [0, 1],
    );
    await h.expectLedgerEqualsStandIn([buyer, host]);
    await operationalAgrees();
  });

  it('EVENT_PAYOUT_DELAY_HOURS holds the payout back after the event ends', async () => {
    const host = await h.person(0);
    const ev = await event(host);
    const buyer = await h.person(RICH);
    const order = await buy(buyer, ev);
    process.env.EVENT_PAYOUT_DELAY_HOURS = '6';
    try {
      await tookPlace(ev.id, 2);
      expect((await payout.sweep()).released).toBe(0);
      await tookPlace(ev.id, 7);
      expect((await payout.sweep()).released).toBe(1);
    } finally {
      delete process.env.EVENT_PAYOUT_DELAY_HOURS;
    }
    await settleHolds([order]);
    expect(balance(host)).toBe(BigInt((TICKET * 85) / 100));
    expect(randomUUID()).toBeTruthy();
    await h.expectLedgerEqualsStandIn([buyer, host]);
    await operationalAgrees();
  });
});
