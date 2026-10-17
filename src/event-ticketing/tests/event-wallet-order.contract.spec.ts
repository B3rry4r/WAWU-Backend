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
import type {
  EventWalletOrderQuoteView,
  EventWalletOrderView,
} from '../wallet/event-wallet-order-view.type';

/**
 * EVENTS-07 over HTTP: the real modules and a real database, Fintava's real
 * client over a socket to the local double (no provider is called).
 *
 * The figures: a Regular (₦7,500) and a VIP (₦20,000) ticket are ₦27,500 in
 * tickets, moved into WAWU's account and held there until the event (R-19),
 * and Fintava's ₦15.75 charge on top (R-10): ₦27,515.75 leaves the wallet.
 */

const REGULAR = 750_000;
const VIP = 2_000_000;
const PRICE = REGULAR + VIP;
const FEE = 1_575;
const TOTAL = PRICE + FEE;
const START = 10_000_000;

jest.setTimeout(120_000);

const code = (res: { body: unknown }) =>
  (res.body as { reason?: { code?: string } }).reason?.code ?? null;

describe('EVENTS-07 buy event tickets from the wallet', () => {
  let h: EventHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootEventApp('events07');
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
    h.double.seen.length = 0;
  });

  const summit = (extra: Partial<Parameters<EventHarness['event']>[0]> = {}) =>
    h.event({
      tiers: [
        { name: 'Regular', priceNaira: 7_500, quantity: 100 },
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
    key?: string,
  ): Promise<EventWalletOrderQuoteView> {
    const res = await r.create(p, e.id, send, key).expect(201);
    return body<EventWalletOrderQuoteView>(res).data!;
  }
  const payBody = (q: EventWalletOrderQuoteView) => ({
    orderId: q.order.id,
    expectedTotalKobo: q.payment!.totalKobo,
    quoteToken: q.payment!.quoteToken,
  });
  const balance = (p: Person) => h.wallets.kobo.get(p.accountNumber);
  const sold = async (e: SeededEvent) =>
    (
      await h.prisma.eventTicketType.findMany({
        where: { eventId: e.id },
        orderBy: [{ priceNaira: 'asc' }, { name: 'asc' }],
      })
    ).map((t) => t.sold);

  describe('E3: the quote', () => {
    it('prices a basket of two tiers from the server: the tickets, the provider charge and the total, nothing taken yet', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      expect(q.order).toMatchObject({
        status: 'awaiting_payment',
        free: false,
        ticketCount: 2,
        ticketsKobo: PRICE,
        paymentId: null,
        tickets: [],
        holderName: null,
      });
      expect(q.order.reference).toMatch(/^WAW-EVT-[A-HJ-NP-Z2-9]{8}$/);
      expect(q.order.event).toMatchObject({
        id: e.id,
        name: 'WAWU Creators Summit',
      });
      expect(q.order.lines).toEqual([
        {
          ticketTypeId: e.tiers[0].id,
          tierName: 'Regular',
          unitPriceKobo: REGULAR,
          quantity: 1,
          lineKobo: REGULAR,
        },
        {
          ticketTypeId: e.tiers[1].id,
          tierName: 'VIP',
          unitPriceKobo: VIP,
          quantity: 1,
          lineKobo: VIP,
        },
      ]);
      expect(q.payment).toMatchObject({
        kind: 'event_ticket',
        targetId: q.order.id,
        title: 'WAWU Creators Summit',
        priceKobo: PRICE,
        totalKobo: TOTAL,
        balanceKobo: START,
        shortfallKobo: 0,
        willBeHeld: true,
        payee: { wawuUserId: e.hostId },
      });
      expect(q.payment!.fee).toMatchObject({
        providerFeeKobo: FEE,
        wawuFeeKobo: 0,
      });
      // Quoted, not reserved: no seat taken, no payment, no debit.
      expect(await sold(e)).toEqual([0, 0]);
      expect(balance(p)).toBe(START);
      expect(
        await h.prisma.walletPayment.count({
          where: { payerWawuUserId: p.id },
        }),
      ).toBe(0);
      // The quote route says the same.
      const again = body<EventWalletOrderQuoteView>(
        await r.quote(p, q.order.id).expect(200),
      ).data!;
      expect(again.payment).toMatchObject({
        priceKobo: PRICE,
        totalKobo: TOTAL,
      });
    });

    it('shows the shortfall when the wallet cannot cover it, and takes nothing', async () => {
      const e = await summit();
      const p = await h.buyer(1_000_000);
      const q = await start(p, e);
      expect(q.payment!.shortfallKobo).toBe(TOTAL - 1_000_000);
      const res = await r.pay(p, payBody(q)).expect(402);
      expect(body<unknown>(res).reason).toMatchObject({
        code: 'insufficient_funds',
        shortfallKobo: TOTAL - 1_000_000,
      });
      expect(balance(p)).toBe(1_000_000);
      expect(await sold(e)).toEqual([0, 0]);
    });

    it('is 409 wallet_not_open for a priced basket with no wallet, and makes no order', async () => {
      const e = await summit();
      const none = h.walletless();
      const res = await r.create(none, e.id, lines(e)).expect(409);
      expect(code(res)).toBe('wallet_not_open');
      expect(
        await h.prisma.eventOrder.count({ where: { buyerWawuId: none.id } }),
      ).toBe(0);
    });

    it("refuses what cannot be bought: another event's ticket, a cancelled or unpublished event, your own event, sold out, the last few", async () => {
      const e = await summit();
      const other = await summit();
      const p = await h.buyer(START);
      const lost = await r
        .create(p, e.id, {
          lines: [{ ticketTypeId: other.tiers[0].id, quantity: 1 }],
        })
        .expect(404);
      expect(code(lost)).toBe('target_not_found');
      await r.create(p, randomUUID(), lines(e)).expect(404);

      const cancelled = await summit({ status: 'cancelled' });
      expect(
        code(await r.create(p, cancelled.id, lines(cancelled)).expect(409)),
      ).toBe('target_not_payable');
      const pending = await summit({ status: 'pending' });
      await r.create(p, pending.id, lines(pending)).expect(409);

      const host = await h.buyer(START);
      const own = await summit({ hostId: host.id });
      const ownRes = await r.create(host, own.id, lines(own)).expect(409);
      expect(code(ownRes)).toBe('target_not_payable');
      expect(
        (ownRes.body as { reason: { message: string } }).reason.message,
      ).toBe('You cannot buy tickets to your own event.');

      const few = await h.event({
        tiers: [
          { name: 'Regular', priceNaira: 7_500, quantity: 2 },
          { name: 'VIP', priceNaira: 20_000, quantity: 1, tier: 'vip' },
        ],
      });
      const tooMany = await r.create(p, few.id, lines(few, 3, 0)).expect(409);
      expect(
        (tooMany.body as { reason: { message: string } }).reason.message,
      ).toBe('Only 2 of Regular left.');
      await h.prisma.eventTicketType.update({
        where: { id: few.tiers[1].id },
        data: { sold: 1 },
      });
      const soldOut = await r.create(p, few.id, lines(few, 0, 1)).expect(409);
      expect(
        (soldOut.body as { reason: { message: string } }).reason.message,
      ).toBe('VIP is sold out.');
    });

    it('refuses a malformed basket: the same tier twice, none, zero, or more than 50 tickets', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const t = e.tiers[0].id;
      const bad = (lines: unknown) => r.create(p, e.id, { lines }).expect(400);
      await bad([
        { ticketTypeId: t, quantity: 1 },
        { ticketTypeId: t, quantity: 1 },
      ]);
      await bad([]);
      await bad([{ ticketTypeId: t, quantity: 0 }]);
      await bad([{ ticketTypeId: t, quantity: 51 }]);
      await bad([{ ticketTypeId: 'not-a-uuid', quantity: 1 }]);
      await bad([null]);
      await bad([
        { ticketTypeId: t, quantity: 30 },
        { ticketTypeId: e.tiers[1].id, quantity: 30 },
      ]);
      await r.create(p, e.id, { lines: [], extra: 1 }).expect(400);
      expect(
        await h.prisma.eventOrder.count({ where: { buyerWawuId: p.id } }),
      ).toBe(0);
    });
  });

  describe('E4, E5: paying with the PIN', () => {
    it("debits the quoted total once, issues one ticket per seat across both tiers, and holds the price in WAWU's account (R-19)", async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const merchantBefore = h.wallets.kobo.get(MERCHANT_ACCOUNT)!;
      const q = await start(p, e);
      const res = await r.pay(p, payBody(q)).expect(201);
      const order = body<EventWalletOrderView>(res).data!;
      expect(order).toMatchObject({
        id: q.order.id,
        status: 'paid',
        ticketCount: 2,
        paymentStatus: 'completed',
        statusMessage: null,
        transferFeeKobo: FEE,
        totalKobo: TOTAL,
        failureReason: null,
        returned: null,
      });
      expect(order.paymentId).toEqual(expect.any(String));
      expect(order.paidAt).toEqual(expect.any(String));
      expect(order.tickets.map((t) => t.tierName).sort()).toEqual([
        'Regular',
        'VIP',
      ]);
      for (const t of order.tickets) {
        expect(t.code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
        expect(t.status).toBe('valid');
      }

      // The money: the buyer paid the total once; WAWU's account holds the price.
      expect(balance(p)).toBe(START - TOTAL);
      expect(h.wallets.kobo.get(MERCHANT_ACCOUNT)).toBe(merchantBefore + PRICE);
      const sends = h.wallets.sends.filter((s) => s.from === p.accountNumber);
      expect(sends).toHaveLength(1);
      expect(sends[0]).toMatchObject({
        to: MERCHANT_ACCOUNT,
        amountKobo: PRICE,
        feeKobo: FEE,
      });

      const payment = await h.prisma.walletPayment.findUniqueOrThrow({
        where: { id: order.paymentId! },
      });
      expect(payment).toMatchObject({
        kind: 'event_ticket',
        targetId: q.order.id,
        status: 'completed',
        payeeWawuUserId: e.hostId,
      });
      expect(payment.fulfilledAt).not.toBeNull();
      expect(Number(payment.priceKobo)).toBe(PRICE);
      // 85/15 on the price, never on the charge (R-5, R-10).
      expect(Number(payment.payeeShareKobo)).toBe(Math.floor(PRICE * 0.85));
      expect(Number(payment.wawuShareKobo)).toBe(
        PRICE - Math.floor(PRICE * 0.85),
      );
      const hold = await h.prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: payment.id },
      });
      expect(hold).toMatchObject({
        status: 'held',
        action: null,
        releaseCondition: 'event_took_place',
        kind: 'event_ticket',
      });
      expect(Number(hold.amountKobo)).toBe(PRICE);

      // The ledger agrees with the wallets (MONEY-16).
      const ledger = await h.prisma.fintavaLedgerEntry.findMany({
        where: { customerReference: payment.customerReference },
      });
      expect(ledger.length).toBeGreaterThanOrEqual(1);
      expect(ledger.every((l) => l.status === 'completed')).toBe(true);

      // The order, its basket and its tickets, as the rest of the product reads an order.
      const row = await h.prisma.eventOrder.findUniqueOrThrow({
        where: { id: q.order.id },
        include: { lines: true, tickets: true },
      });
      expect(row).toMatchObject({
        status: 'paid',
        paymentProvider: 'wallet',
        amountNaira: PRICE / 100,
        quantity: 2,
        walletPaymentId: payment.id,
        holdId: hold.id,
      });
      expect(Number(row.commissionRate)).toBe(0.15);
      expect(row.flutterwaveTxRef).toBe(`wawu-event-wallet-${row.id}`);
      expect(row.flutterwaveTxId).toBeNull();
      expect(row.lines).toHaveLength(2);
      expect(row.tickets).toHaveLength(2);
      expect(await sold(e)).toEqual([1, 1]);

      // My tickets (EVENTS-03) shows them, one row per order and tier.
      const held = await request(h.app.getHttpServer())
        .get('/api/hub/events/tickets/held')
        .set('Authorization', p.auth)
        .expect(200);
      const groups = (
        held.body as { data: Array<{ orderId: string; tierName: string }> }
      ).data.filter((g) => g.orderId === q.order.id);
      expect(groups.map((g) => g.tierName).sort()).toEqual(['Regular', 'VIP']);

      // The order reads the same when asked again.
      const again = body<EventWalletOrderView>(
        await r.read(p, q.order.id).expect(200),
      ).data!;
      expect(again.status).toBe('paid');
      expect(again.tickets.map((t) => t.code).sort()).toEqual(
        order.tickets.map((t) => t.code).sort(),
      );
    });

    it('charges once for the same request twice: the key replays the first answer and no second set is issued', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      const key = randomUUID();
      const first = await r.pay(p, payBody(q), { key }).expect(201);
      const second = await r.pay(p, payBody(q), { key, pin: null }).expect(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(body<EventWalletOrderView>(second).data).toEqual(
        body<EventWalletOrderView>(first).data,
      );
      expect(balance(p)).toBe(START - TOTAL);
      expect(
        await h.prisma.walletPayment.count({
          where: { payerWawuUserId: p.id },
        }),
      ).toBe(1);
      expect(
        await h.prisma.eventTicket.count({ where: { orderId: q.order.id } }),
      ).toBe(2);
    });

    it('does not take a paid order again under another key, and two taps at once charge once', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      await r.pay(p, payBody(q)).expect(201);
      const res = await r.pay(p, payBody(q)).expect(409);
      expect(code(res)).toBe('target_not_payable');
      expect(balance(p)).toBe(START - TOTAL);

      const e2 = await summit();
      const q2 = await start(p, e2);
      const [a, b] = await Promise.all([
        r.pay(p, payBody(q2)),
        r.pay(p, payBody(q2)),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      expect(balance(p)).toBe(START - 2 * TOTAL);
      expect(
        await h.prisma.eventTicket.count({ where: { orderId: q2.order.id } }),
      ).toBe(2);
    });

    it('refuses a wrong PIN with nothing taken, and a stale quote token', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      const wrong = await r.pay(p, payBody(q), { pin: '1111' }).expect(403);
      expect(code(wrong)).toBe('pin_incorrect');
      await r
        .pay(p, { ...payBody(q), expectedTotalKobo: TOTAL - 1 })
        .expect(409);
      expect(balance(p)).toBe(START);
      expect(await sold(e)).toEqual([0, 0]);
    });

    it('checks the order again inside the payment: a price that changed or seats that went since the quote are refused before any debit', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      await h.prisma.eventTicketType.update({
        where: { id: e.tiers[0].id },
        data: { priceNaira: 8_000 },
      });
      const changed = await r.pay(p, payBody(q)).expect(409);
      expect(code(changed)).toBe('target_not_payable');
      await h.prisma.eventTicketType.update({
        where: { id: e.tiers[0].id },
        data: { priceNaira: 7_500 },
      });

      await h.prisma.eventTicketType.update({
        where: { id: e.tiers[1].id },
        data: { sold: 10 },
      });
      const gone = await r.pay(p, payBody(q)).expect(409);
      expect(
        (gone.body as { reason: { message: string } }).reason.message,
      ).toBe('VIP is sold out.');
      expect(balance(p)).toBe(START);
      expect(
        await h.prisma.walletPayment.count({
          where: { payerWawuUserId: p.id },
        }),
      ).toBe(0);
    });

    it('is 404 for an order that is not yours, on every route', async () => {
      const e = await summit();
      const owner = await h.buyer(START);
      const other = await h.buyer(START);
      const q = await start(owner, e);
      await r.read(other, q.order.id).expect(404);
      await r.quote(other, q.order.id).expect(404);
      const stolen = await r.pay(other, payBody(q)).expect(404);
      expect(code(stolen)).toBe('target_not_found');
      await r.read(owner, randomUUID()).expect(404);
    });
  });

  describe('E10: still confirming', () => {
    it('answers processing while the debit is not confirmed, and issues the tickets once when it is', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      // Fintava takes the transfer and drops the answer: the outcome is unknown.
      h.wallets.mode = 'timeout';
      const res = await r.pay(p, payBody(q)).expect(201);
      h.wallets.mode = 'live';
      const waiting = body<EventWalletOrderView>(res).data!;
      expect(waiting).toMatchObject({
        status: 'processing',
        paymentStatus: 'pending',
        tickets: [],
      });
      expect(waiting.statusMessage).toContain("Don't pay again");
      expect(await sold(e)).toEqual([0, 0]);
      const polled = body<EventWalletOrderView>(
        await r.read(p, q.order.id).expect(200),
      ).data!;
      expect(polled.status).toBe('processing');

      // The sweep asks Fintava, finds the transfer, and the tickets are issued.
      await h.sweepLater();
      const done = body<EventWalletOrderView>(
        await r.read(p, q.order.id).expect(200),
      ).data!;
      expect(done.status).toBe('paid');
      expect(done.tickets).toHaveLength(2);
      await h.sweepLater();
      expect(
        await h.prisma.eventTicket.count({ where: { orderId: q.order.id } }),
      ).toBe(2);
      expect(await sold(e)).toEqual([1, 1]);
      expect(balance(p)).toBe(START - TOTAL);
    });

    it('refunds the hold and fails the order when the seats went between the debit and the tickets', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      h.wallets.mode = 'timeout';
      await r.pay(p, payBody(q)).expect(201);
      h.wallets.mode = 'live';
      // While the debit is unconfirmed, other buyers take the last VIP seats.
      await h.prisma.eventTicketType.update({
        where: { id: e.tiers[1].id },
        data: { sold: 10 },
      });
      await h.sweepLater();
      await h.sweepLater();
      const order = body<EventWalletOrderView>(
        await r.read(p, q.order.id).expect(200),
      ).data!;
      expect(order.status).toBe('failed');
      expect(order.tickets).toEqual([]);
      expect(order.failureReason).toContain('sold out');
      // Nothing issued, nothing counted, and the price is on its way back.
      expect(
        await h.prisma.eventTicket.count({ where: { orderId: q.order.id } }),
      ).toBe(0);
      expect(await sold(e)).toEqual([0, 10]);
      const hold = await h.prisma.walletHold.findFirstOrThrow({
        where: { targetId: q.order.id },
      });
      expect(hold).toMatchObject({ action: 'refund' });
      await h.holds.sweep();
      await h.holds.sweep();
      const refunded = await h.prisma.walletHold.findUniqueOrThrow({
        where: { id: hold.id },
      });
      expect(refunded.status).toBe('refunded');
      // The order failed after the debit, so the buyer gets back everything
      // paid, Fintava's charge included, and WAWU carries the charge
      // (EVENTS-07 round 2, as a failed bill does).
      expect(balance(p)).toBe(START);
      expect(refunded).toMatchObject({
        refundedKobo: BigInt(PRICE),
        transferKobo: BigInt(TOTAL),
      });
      const after = body<EventWalletOrderView>(
        await r.read(p, q.order.id).expect(200),
      ).data!;
      expect(after.returned).toMatchObject({
        returned: true,
        returnedKobo: TOTAL,
      });
      expect(after.failureReason).toContain('charge included');
    });

    it('refunds when the event is called off between the debit and the tickets', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      h.wallets.mode = 'timeout';
      await r.pay(p, payBody(q)).expect(201);
      h.wallets.mode = 'live';
      await h.prisma.event.update({
        where: { id: e.id },
        data: { status: 'cancelled', cancelledAt: new Date() },
      });
      await h.sweepLater();
      await h.sweepLater();
      const order = await h.prisma.eventOrder.findUniqueOrThrow({
        where: { id: q.order.id },
      });
      expect(order.status).toBe('failed');
      expect(order.failureReason).toContain('called off');
      expect(
        await h.prisma.eventTicket.count({ where: { orderId: q.order.id } }),
      ).toBe(0);
      const hold = await h.prisma.walletHold.findFirstOrThrow({
        where: { targetId: q.order.id },
      });
      expect(hold.action).toBe('refund');
    });
  });

  describe('R-8: a free basket', () => {
    it('gives a person with no wallet and no PIN their tickets, with no debit', async () => {
      const e = await h.event({
        tiers: [{ name: 'Free entry', priceNaira: 0, quantity: 5 }],
      });
      const none = h.walletless();
      const res = await r
        .create(none, e.id, {
          lines: [{ ticketTypeId: e.tiers[0].id, quantity: 2 }],
        })
        .expect(201);
      const q = body<EventWalletOrderQuoteView>(res).data!;
      expect(q.payment).toBeNull();
      expect(q.order).toMatchObject({
        status: 'paid',
        free: true,
        ticketCount: 2,
        ticketsKobo: 0,
        paymentId: null,
        totalKobo: null,
      });
      expect(q.order.tickets).toHaveLength(2);
      expect(await sold(e)).toEqual([2]);
      expect(
        await h.prisma.walletPayment.count({
          where: { payerWawuUserId: none.id },
        }),
      ).toBe(0);
      expect(
        h.double.seen.some((x) => x.path === '/transaction/wallet-to-wallet'),
      ).toBe(false);
      // The order is readable, and a free order cannot be paid.
      const read = body<EventWalletOrderView>(
        await r.read(none, q.order.id).expect(200),
      ).data!;
      expect(read.status).toBe('paid');
      const row = await h.prisma.eventOrder.findUniqueOrThrow({
        where: { id: q.order.id },
      });
      expect(row).toMatchObject({
        status: 'paid',
        paymentProvider: 'free',
        amountNaira: 0,
        walletPaymentId: null,
      });
    });

    it('issues one set for one tap: the same key and tickets answer the same order, other tickets under it are refused', async () => {
      const e = await h.event({
        tiers: [
          { name: 'Free entry', priceNaira: 0, quantity: 5 },
          { name: 'Free seat', priceNaira: 0, quantity: 5 },
        ],
      });
      const p = h.walletless();
      const key = randomUUID();
      const send = {
        lines: [{ ticketTypeId: e.tiers[0].id, quantity: 1 }],
      };
      const first = body<EventWalletOrderQuoteView>(
        await r.create(p, e.id, send, key).expect(201),
      ).data!;
      const [again, parallel] = await Promise.all([
        r.create(p, e.id, send, key).expect(201),
        r.create(p, e.id, send, key).expect(201),
      ]);
      expect(body<EventWalletOrderQuoteView>(again).data!.order.id).toBe(
        first.order.id,
      );
      expect(body<EventWalletOrderQuoteView>(parallel).data!.order.id).toBe(
        first.order.id,
      );
      expect(
        await h.prisma.eventOrder.count({ where: { buyerWawuId: p.id } }),
      ).toBe(1);
      expect(await sold(e)).toEqual([1, 0]);
      const reused = await r
        .create(
          p,
          e.id,
          { lines: [{ ticketTypeId: e.tiers[1].id, quantity: 1 }] },
          key,
        )
        .expect(409);
      expect(code(reused)).toBe('idempotency_key_reused');
      const badKey = await r.create(p, e.id, send, 'x').expect(400);
      expect(code(badKey)).toBe('idempotency_key_required');
    });

    it('sells the last seat once: two people asking at the same time, one gets it', async () => {
      const e = await h.event({
        tiers: [{ name: 'Free entry', priceNaira: 0, quantity: 1 }],
      });
      const a = h.walletless();
      const b = h.walletless();
      const send = { lines: [{ ticketTypeId: e.tiers[0].id, quantity: 1 }] };
      const [x, y] = await Promise.all([
        r.create(a, e.id, send),
        r.create(b, e.id, send),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      expect(await sold(e)).toEqual([1]);
      expect(
        await h.prisma.eventTicket.count({ where: { eventId: e.id } }),
      ).toBe(1);
    });

    it('prices a basket that mixes a free tier with a paid one at the paid one only, and issues both', async () => {
      const e = await h.event({
        tiers: [
          { name: 'Free entry', priceNaira: 0, quantity: 5 },
          { name: 'Workshop', priceNaira: 5_000, quantity: 5 },
        ],
      });
      const p = await h.buyer(START);
      const q = await start(p, e, {
        lines: [
          { ticketTypeId: e.tiers[0].id, quantity: 1 },
          { ticketTypeId: e.tiers[1].id, quantity: 2 },
        ],
      });
      expect(q.payment).toMatchObject({
        priceKobo: 1_000_000,
        totalKobo: 1_001_575,
      });
      const done = body<EventWalletOrderView>(
        await r.pay(p, payBody(q)).expect(201),
      ).data!;
      expect(done.status).toBe('paid');
      expect(done.tickets.map((t) => t.tierName).sort()).toEqual([
        'Free entry',
        'Workshop',
        'Workshop',
      ]);
    });
  });

  describe("the web's routes keep working beside these", () => {
    it("a pending wallet order is not failed by the web's verify route, and a called-off event sends a wallet order's price back through its hold", async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      const verify = await request(h.app.getHttpServer())
        .post(`/api/hub/events/orders/${q.order.id}/verify`)
        .set('Authorization', p.auth)
        .send({ transaction_id: '1', tx_ref: 'x' });
      expect(verify.status).toBe(409);
      expect(
        (
          await h.prisma.eventOrder.findUniqueOrThrow({
            where: { id: q.order.id },
          })
        ).status,
      ).toBe('pending');

      await r.pay(p, payBody(q)).expect(201);
      const cancel = await request(h.app.getHttpServer())
        .post(`/api/hub/events/${e.id}/cancel`)
        .set('Authorization', `Bearer ${mintToken(e.hostId, 'events07')}`)
        .send({ reason: 'The venue is not available any more.' });
      expect(cancel.status).toBe(201);
      expect(
        (cancel.body as { data: Record<string, unknown> }).data,
      ).toMatchObject({
        cancelled: true,
        ordersRefunded: 1,
        refundsNeedingAttention: 0,
      });
      const order = await h.prisma.eventOrder.findUniqueOrThrow({
        where: { id: q.order.id },
      });
      // EVENTS-10: the tickets are void and the price is back with the buyer,
      // through the hold (the whole of it is in event-call-off-refund.contract.spec.ts).
      expect(order).toMatchObject({ status: 'refunded', refundError: null });
      expect(
        await h.prisma.eventTicket.count({
          where: { orderId: q.order.id, status: 'void' },
        }),
      ).toBe(2);
      const hold = await h.prisma.walletHold.findFirstOrThrow({
        where: { targetId: q.order.id },
      });
      expect(hold).toMatchObject({ status: 'refunded', action: 'refund' });
    });

    it('lets the host replace the tiers over an unpaid quote, and waits for one whose payment is being confirmed', async () => {
      const e = await summit();
      // EVENTS-11 (R-40): setting tickets needs a verified host. Setup only.
      await h.tick(e.hostId);
      const p = await h.buyer(START);
      const host = `Bearer ${mintToken(e.hostId, 'events07')}`;
      const put = () =>
        request(h.app.getHttpServer())
          .put(`/api/hub/events/${e.id}/tickets`)
          .set('Authorization', host)
          .send({
            types: [
              {
                tier: 'regular',
                name: 'General',
                priceNaira: 5_000,
                quantity: 50,
              },
            ],
          });
      const open = await start(p, e);
      const waiting = await start(p, e);
      h.wallets.mode = 'timeout';
      await r.pay(p, payBody(waiting)).expect(201);
      h.wallets.mode = 'live';
      // A payment is unconfirmed: the tiers are not replaced under it.
      expect((await put()).status).toBe(409);
      expect(
        await h.prisma.eventOrder.count({ where: { id: open.order.id } }),
      ).toBe(1);
      await h.sweepLater();
      await h.sweepLater();
      // Paid (sold > 0): the web's own rule, as it always was.
      expect((await put()).status).toBe(409);

      const fresh = await summit();
      await h.tick(fresh.hostId);
      const q = await start(p, fresh);
      const swap = await request(h.app.getHttpServer())
        .put(`/api/hub/events/${fresh.id}/tickets`)
        .set('Authorization', `Bearer ${mintToken(fresh.hostId, 'events07')}`)
        .send({
          types: [
            {
              tier: 'regular',
              name: 'General',
              priceNaira: 5_000,
              quantity: 50,
            },
          ],
        });
      expect(swap.status).toBe(200);
      await r.read(p, q.order.id).expect(404);
    });

    it("leaves the web's order route as it is: it still answers a Flutterwave config", async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const res = await request(h.app.getHttpServer())
        .post(`/api/hub/events/${e.id}/orders`)
        .set('Authorization', p.auth)
        .send({ ticketTypeId: e.tiers[0].id, quantity: 1 });
      expect(res.status).toBe(201);
      const data = (res.body as { data: Record<string, unknown> }).data;
      expect(data.free).toBe(false);
      expect(data.flutterwaveConfig).toMatchObject({ amount: 7_500 });
      const row = await h.prisma.eventOrder.findUniqueOrThrow({
        where: { id: data.orderId as string },
      });
      expect(row.paymentProvider).toBeNull();
      expect(row.paymentReference).toBeNull();
    });
  });
});
