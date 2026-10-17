import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  api,
  bootEventApp,
  type EventHarness,
  type Person,
  type SeededEvent,
} from '../../../test/events/event-wallet-harness';
import { MERCHANT_ACCOUNT } from '../../../test/fintava/fintava-double';
import { body, mintToken } from '../../../test/payments/poll-helpers';
import { ERASED_HOST } from '../wallet/event-host-erasure.service';
import type {
  EventWalletOrderQuoteView,
  EventWalletOrderView,
} from '../wallet/event-wallet-order-view.type';

/**
 * EVENTS-07 round 2 over HTTP, a real database and the Fintava double (no
 * provider is called): a host who erases their account (the buyers' money
 * goes back before the event goes), a tier edit over a failed wallet order,
 * and a buyer who loses the last seat (everything they paid comes back).
 */

const REGULAR = 750_000;
const VIP = 2_000_000;
const PRICE = REGULAR + VIP;
const FEE = 1_575;
const TOTAL = PRICE + FEE;
const START = 10_000_000;
const LATER = () => new Date(Date.now() + 6 * 60 * 60_000);

jest.setTimeout(120_000);

describe('EVENTS-07 round 2', () => {
  let h: EventHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootEventApp('events07r2');
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
    h.double.seen.length = 0;
  });

  const summit = (
    regularSeats = 100,
    extra: Partial<Parameters<EventHarness['event']>[0]> = {},
  ) =>
    h.event({
      tiers: [
        { name: 'Regular', priceNaira: 7_500, quantity: regularSeats },
        { name: 'VIP', priceNaira: 20_000, quantity: 10, tier: 'vip' },
      ],
      ...extra,
    });
  const lines = (e: SeededEvent, regular = 1, vip = 1) => ({
    lines: [
      ...(regular > 0
        ? [{ ticketTypeId: e.tiers[0].id, quantity: regular }]
        : []),
      ...(vip > 0 ? [{ ticketTypeId: e.tiers[1].id, quantity: vip }] : []),
    ],
  });
  async function start(
    p: Person,
    e: SeededEvent,
    send: Record<string, unknown> = lines(e),
  ): Promise<EventWalletOrderQuoteView> {
    const res = await r.create(p, e.id, send).expect(201);
    return body<EventWalletOrderQuoteView>(res).data!;
  }
  const payBody = (q: EventWalletOrderQuoteView) => ({
    orderId: q.order.id,
    expectedTotalKobo: q.payment!.totalKobo,
    quoteToken: q.payment!.quoteToken,
  });
  async function buy(p: Person, e: SeededEvent): Promise<string> {
    const q = await start(p, e);
    const res = await r.pay(p, payBody(q)).expect(201);
    expect(body<EventWalletOrderView>(res).data!.status).toBe('paid');
    return q.order.id;
  }
  const balance = (p: Person) => h.wallets.kobo.get(p.accountNumber);
  const holdOf = (orderId: string) =>
    h.prisma.walletHold.findFirstOrThrow({ where: { targetId: orderId } });
  const refundMoves = (p: Person) =>
    h.wallets.sends.filter(
      (s) => s.from === MERCHANT_ACCOUNT && s.to === p.accountNumber,
    );
  const ledgerOf = async (reference: string) =>
    (
      await h.prisma.fintavaLedgerEntry.findMany({
        where: { customerReference: reference },
      })
    ).map((x) => ({
      walletKind: x.walletKind,
      direction: x.direction,
      category: x.category,
      amountKobo: x.amountKobo,
    }));
  const readOrder = async (p: Person, id: string) =>
    body<EventWalletOrderView>(await r.read(p, id).expect(200)).data!;

  describe('a host erases their account', () => {
    it('sends every buyer their money back before the event goes, once, and a second purge moves nothing', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const orderId = await buy(p, e);
      expect(balance(p)).toBe(START - TOTAL);
      expect((await holdOf(orderId)).status).toBe('held');
      // An unpaid quote of the same event goes with it.
      const q = await h.buyer(START);
      await start(q, e);

      await h.purge.purge(e.hostId);

      const hold = await holdOf(orderId);
      expect(hold).toMatchObject({
        status: 'refunded',
        action: 'refund',
        refundedKobo: BigInt(PRICE),
        transferKobo: BigInt(TOTAL),
      });
      // Everything the buyer paid is back, Fintava's charge included: they
      // did nothing wrong, and WAWU carries the charge (round 3 ruling).
      expect(balance(p)).toBe(START);
      expect(refundMoves(p)).toHaveLength(1);
      expect(refundMoves(p)[0].amountKobo).toBe(TOTAL);
      expect(await ledgerOf(hold.customerReference!)).toEqual(
        expect.arrayContaining([
          {
            walletKind: 'merchant',
            direction: 'out',
            category: 'refund',
            amountKobo: BigInt(TOTAL),
          },
          {
            walletKind: 'user',
            direction: 'in',
            category: 'refund',
            amountKobo: BigInt(TOTAL),
          },
        ]),
      );
      // The event went with its orders, tickets and tiers.
      expect(
        await h.prisma.event.findUnique({ where: { id: e.id } }),
      ).toBeNull();
      expect(
        await h.prisma.eventOrder.count({ where: { eventId: e.id } }),
      ).toBe(0);

      await h.purge.purge(e.hostId);
      await h.holds.sweep(LATER());
      expect(refundMoves(p)).toHaveLength(1);
      expect(balance(p)).toBe(START);
    });

    it('keeps an event whose money cannot move now, with its orders, and sends it back when the provider is back', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const orderId = await buy(p, e);

      await h.double.pause();
      await h.purge.purge(e.hostId);
      await h.double.resume();

      // Nothing was deleted: the event, the order and its tickets are kept,
      // and the event names nobody and is off sale.
      const kept = await h.prisma.event.findUniqueOrThrow({
        where: { id: e.id },
      });
      expect(kept).toMatchObject({
        hostWawuId: ERASED_HOST,
        status: 'removed',
      });
      const order = await readOrder(p, orderId);
      expect(order.status).toBe('paid');
      expect(order.tickets).toHaveLength(2);
      const held = await holdOf(orderId);
      expect(held.status).toBe('held');
      expect(refundMoves(p)).toHaveLength(0);
      // A second purge keeps it too.
      await h.purge.purge(e.hostId);
      expect(
        await h.prisma.event.findUnique({ where: { id: e.id } }),
      ).not.toBeNull();

      // The provider is back: the hold settles, then the sweep removes the event.
      await h.holds.sweep(LATER());
      await h.holds.sweep(LATER());
      expect((await holdOf(orderId)).status).toBe('refunded');
      expect(await h.erasure.sweep()).toEqual({ kept: 0, deleted: 1 });
      expect(
        await h.prisma.event.findUnique({ where: { id: e.id } }),
      ).toBeNull();
      expect(refundMoves(p)).toHaveLength(1);
      expect(balance(p)).toBe(START);
    });

    it('reads a refunded order as refunded, with its tickets void, while a sibling order keeps the event', async () => {
      const e = await summit();
      const a = await h.buyer(START);
      const b = await h.buyer(START);
      const orderA = await buy(a, e);
      const orderB = await buy(b, e);
      // B's wallet is not there to take the money now (a frozen or missing
      // wallet waits): its hold cannot move, so the event is kept.
      const wallet = await h.prisma.fintavaWallet.findUniqueOrThrow({
        where: { wawuUserId: b.id },
      });
      await h.prisma.fintavaWallet.delete({ where: { wawuUserId: b.id } });

      await h.purge.purge(e.hostId);

      const done = await readOrder(a, orderA);
      expect(done.status).toBe('failed');
      expect(done.returned).toMatchObject({
        returned: true,
        returnedKobo: TOTAL,
      });
      expect(done.failureReason).toContain('can no longer take place');
      expect(
        await h.prisma.eventTicket.count({
          where: { orderId: orderA, status: { not: 'void' } },
        }),
      ).toBe(0);
      expect(balance(a)).toBe(START);
      expect(refundMoves(a)).toHaveLength(1);
      // The event stays for B's order, which is untouched.
      expect(
        await h.prisma.event.findUnique({ where: { id: e.id } }),
      ).not.toBeNull();
      expect((await holdOf(orderB)).status).toBe('held');
      expect(
        await h.prisma.eventOrder.findUnique({ where: { id: orderB } }),
      ).toMatchObject({ status: 'paid' });

      // B's wallet is back: the money goes, the order reads refunded, the event goes.
      await h.prisma.fintavaWallet.create({ data: wallet });
      await h.holds.sweep(LATER());
      await h.holds.sweep(LATER());
      expect((await holdOf(orderB)).status).toBe('refunded');
      expect(await h.erasure.sweep()).toEqual({ kept: 0, deleted: 1 });
      expect(
        await h.prisma.event.findUnique({ where: { id: e.id } }),
      ).toBeNull();
      expect(refundMoves(b)).toHaveLength(1);
      expect(balance(b)).toBe(START);
    });

    it('keeps the holds of an event that had started, with its orders, refunds nobody, and keeps the event while any hold is held', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const orderId = await buy(p, e);
      // The event started yesterday (a multi-day event, still on) before its host left.
      await h.prisma.event.update({
        where: { id: e.id },
        data: { startsAt: new Date(Date.now() - 24 * 60 * 60_000) },
      });
      // The same host has an event that has not started, with a buyer too.
      const upcoming = await summit(100, { hostId: e.hostId });
      const other = await h.buyer(START);
      const upcomingOrder = await buy(other, upcoming);
      const movesBefore = h.wallets.sends.length;

      await h.purge.purge(e.hostId);

      // The event that had not started is refunded in full and gone.
      expect((await holdOf(upcomingOrder)).status).toBe('refunded');
      expect(balance(other)).toBe(START);
      expect(
        await h.prisma.event.findUnique({ where: { id: upcoming.id } }),
      ).toBeNull();
      // The one that had started: nothing moved, the hold is held, the order
      // is paid with its tickets, and the event is kept, naming nobody.
      const kept = await h.prisma.event.findUniqueOrThrow({
        where: { id: e.id },
      });
      expect(kept).toMatchObject({
        hostWawuId: ERASED_HOST,
        status: 'removed',
      });
      expect((await holdOf(orderId)).status).toBe('held');
      expect(balance(p)).toBe(START - TOTAL);
      expect(refundMoves(p)).toHaveLength(0);
      expect(h.wallets.sends.length - movesBefore).toBe(1);
      const order = await readOrder(p, orderId);
      expect(order.status).toBe('paid');
      expect(order.tickets).toHaveLength(2);

      // Neither the sweeps nor a second purge refund it or delete it.
      await h.purge.purge(e.hostId);
      await h.holds.sweep(LATER());
      expect(await h.erasure.sweep()).toEqual({ kept: 1, deleted: 0 });
      expect((await holdOf(orderId)).status).toBe('held');
      expect(refundMoves(p)).toHaveLength(0);
      expect(
        await h.prisma.event.findUnique({ where: { id: e.id } }),
      ).not.toBeNull();
      expect(
        await h.prisma.eventOrder.findUnique({ where: { id: orderId } }),
      ).toMatchObject({ status: 'paid' });

      // Once a person has cleared the hold (it is no longer held), the sweep
      // removes the leftover shell.
      await h.prisma.walletHold.update({
        where: { id: (await holdOf(orderId)).id },
        data: { status: 'released', action: 'release', settledAt: new Date() },
      });
      expect(await h.erasure.sweep()).toEqual({ kept: 0, deleted: 1 });
      expect(
        await h.prisma.event.findUnique({ where: { id: e.id } }),
      ).toBeNull();
    });

    it('leaves an event with no wallet order to the purge, as before', async () => {
      const e = await summit();
      await h.purge.purge(e.hostId);
      expect(
        await h.prisma.event.findUnique({ where: { id: e.id } }),
      ).toBeNull();
    });
  });

  describe('a tier edit over a failed wallet order', () => {
    it('replaces the tiers once the failed order is back with its buyer, and waits while it is on its way', async () => {
      const e = await summit(100, { hostId: randomUUID() });
      // EVENTS-11 (R-40): setting tickets needs a verified host. Setup only.
      await h.tick(e.hostId);
      const p = await h.buyer(START);
      const q = await start(p, e);
      h.wallets.mode = 'timeout';
      await r.pay(p, payBody(q)).expect(201);
      h.wallets.mode = 'live';
      // The event is unpublished between the debit and the tickets.
      await h.prisma.event.update({
        where: { id: e.id },
        data: { status: 'pending' },
      });
      // The debit is confirmed and the order fails; the move back is asked
      // but its answer is lost, so the money is on its way, not yet returned.
      h.wallets.mode = 'timeout';
      await h.sweepLater();
      await h.sweepLater();
      h.wallets.mode = 'live';
      expect(
        (
          await h.prisma.eventOrder.findUniqueOrThrow({
            where: { id: q.order.id },
          })
        ).status,
      ).toBe('failed');
      expect((await holdOf(q.order.id)).status).toBe('held');
      await h.prisma.event.update({
        where: { id: e.id },
        data: { status: 'published' },
      });
      const put = () =>
        request(h.app.getHttpServer())
          .put(`/api/hub/events/${e.id}/tickets`)
          .set('Authorization', `Bearer ${mintToken(e.hostId, 'events07r2')}`)
          .send({
            types: [
              {
                tier: 'regular',
                name: 'General',
                priceNaira: 5_000,
                quantity: 20,
              },
            ],
          });
      // The refund is still on its way: the host waits, nothing is 500.
      const waiting = await put();
      expect(waiting.status).toBe(409);
      // The money is back: the tiers are replaced and the failed order goes.
      await h.holds.sweep(LATER());
      await h.holds.sweep(LATER());
      await h.sweepLater();
      const done = await put();
      expect(done.status).toBe(200);
      expect(
        await h.prisma.eventOrder.count({ where: { id: q.order.id } }),
      ).toBe(0);
      expect(balance(p)).toBe(START);
    });
  });

  describe('a buyer who loses the last seat', () => {
    it('gets back everything paid, the charge included, and WAWU carries the charge', async () => {
      const e = await summit(1);
      const buyers = [
        await h.buyer(START),
        await h.buyer(START),
        await h.buyer(START),
      ];
      const quotes = await Promise.all(
        buyers.map((p) => start(p, e, lines(e, 1, 0))),
      );
      await Promise.all(
        buyers.map((p, i) => r.pay(p, payBody(quotes[i])).expect(201)),
      );
      await h.holds.sweep();
      await h.holds.sweep(LATER());

      const orders = await Promise.all(
        quotes.map((q) =>
          h.prisma.eventOrder.findUniqueOrThrow({ where: { id: q.order.id } }),
        ),
      );
      const winners = orders.filter((o) => o.status === 'paid');
      const losers = orders.filter((o) => o.status === 'failed');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(2);
      for (const lost of losers) {
        const i = orders.indexOf(lost);
        const hold = await holdOf(lost.id);
        expect(hold).toMatchObject({
          status: 'refunded',
          refundedKobo: BigInt(REGULAR),
          transferKobo: BigInt(REGULAR + FEE),
        });
        // Everything they paid is back: their wallet is as it was.
        expect(balance(buyers[i])).toBe(START);
        expect(refundMoves(buyers[i])).toHaveLength(1);
        expect(refundMoves(buyers[i])[0].amountKobo).toBe(REGULAR + FEE);
        // The ledger shows both sides of the whole sum.
        expect(await ledgerOf(hold.customerReference!)).toEqual(
          expect.arrayContaining([
            {
              walletKind: 'merchant',
              direction: 'out',
              category: 'refund',
              amountKobo: BigInt(REGULAR + FEE),
            },
            {
              walletKind: 'user',
              direction: 'in',
              category: 'refund',
              amountKobo: BigInt(REGULAR + FEE),
            },
          ]),
        );
        const view = await readOrder(buyers[i], lost.id);
        expect(view.returned).toMatchObject({
          returned: true,
          returnedKobo: REGULAR + FEE,
        });
      }
      // The winner paid the total once and holds the one ticket.
      const w = buyers[orders.indexOf(winners[0])];
      expect(balance(w)).toBe(START - REGULAR - FEE);
      expect(
        await h.prisma.eventTicket.count({ where: { orderId: winners[0].id } }),
      ).toBe(1);
    });
  });
});
