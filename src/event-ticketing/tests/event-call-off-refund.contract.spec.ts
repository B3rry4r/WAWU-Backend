import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  api,
  bootEventApp,
  type EventHarness,
  type Person,
  type SeededEvent,
} from '../../../test/events/event-wallet-harness';
import {
  fintavaError,
  MERCHANT_ACCOUNT,
  type SeenRequest,
} from '../../../test/fintava/fintava-double';
import { body, mintToken } from '../../../test/payments/poll-helpers';
import {
  installFintava,
  liveFee,
} from '../../../test/plans/tier-purchase-harness';
import type {
  EventWalletOrderQuoteView,
  EventWalletOrderView,
} from '../wallet/event-wallet-order-view.type';

/**
 * EVENTS-10 over HTTP, a real database and the Fintava double (no provider is
 * called): a host calls an event off and every buyer's held price goes back
 * through the hold, everything they paid, Fintava's charge included, once.
 */

const REGULAR = 750_000;
const VIP = 2_000_000;
const PRICE = REGULAR + VIP;
const FEE = 1_575;
const TOTAL = PRICE + FEE;
const START = 10_000_000;
const LATER = () => new Date(Date.now() + 6 * 60 * 60_000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

jest.setTimeout(180_000);

describe('EVENTS-10: calling an event off sends the buyers their money back', () => {
  let h: EventHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootEventApp('events10');
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
    extra: Partial<Parameters<EventHarness['event']>[0]> = {},
  ): Promise<SeededEvent> =>
    h.event({
      tiers: [
        { name: 'Regular', priceNaira: 7_500, quantity: 100 },
        { name: 'VIP', priceNaira: 20_000, quantity: 10, tier: 'vip' },
        { name: 'Free entry', priceNaira: 0, quantity: 10 },
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
  async function buy(
    p: Person,
    e: SeededEvent,
    send: Record<string, unknown> = lines(e),
  ): Promise<{ orderId: string; totalKobo: number }> {
    const q = await start(p, e, send);
    const res = await r.pay(p, payBody(q)).expect(201);
    expect(body<EventWalletOrderView>(res).data!.status).toBe('paid');
    return { orderId: q.order.id, totalKobo: q.payment!.totalKobo };
  }
  const balance = (p: Person) => h.wallets.kobo.get(p.accountNumber);
  const holdOf = (orderId: string) =>
    h.prisma.walletHold.findFirstOrThrow({ where: { targetId: orderId } });
  const orderOf = (orderId: string) =>
    h.prisma.eventOrder.findUniqueOrThrow({ where: { id: orderId } });
  const moves = (p: Person) =>
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
  const callOff = (e: SeededEvent, reason = 'The venue is not available.') =>
    request(h.app.getHttpServer())
      .post(`/api/hub/events/${e.id}/cancel`)
      .set('Authorization', `Bearer ${mintToken(e.hostId, 'events10')}`)
      .send({ reason });
  const ticketStates = async (orderId: string) =>
    (
      await h.prisma.eventTicket.findMany({
        where: { orderId },
        select: { status: true },
      })
    ).map((t) => t.status);

  describe('the host calls the event off', () => {
    it('sends every buyer everything they paid back, once, and says so on the order', async () => {
      const e = await summit();
      const p1 = await h.buyer(START);
      const p2 = await h.buyer(START);
      const one = await buy(p1, e);
      const two = await buy(p2, e, lines(e, 2, 0));
      expect(one.totalKobo).toBe(TOTAL);
      expect(balance(p1)).toBe(START - one.totalKobo);
      expect(balance(p2)).toBe(START - two.totalKobo);
      // A free ticket, and a quote nobody paid.
      const guest = h.walletless();
      const freeOrder = body<EventWalletOrderQuoteView>(
        await r
          .create(guest, e.id, {
            lines: [{ ticketTypeId: e.tiers[2].id, quantity: 1 }],
          })
          .expect(201),
      ).data!;
      const p3 = await h.buyer(START);
      const unpaid = await start(p3, e);

      const res = await callOff(e).expect(201);

      expect(body<Record<string, unknown>>(res).data).toMatchObject({
        cancelled: true,
        ordersRefunded: 2,
        refundsNeedingAttention: 0,
      });
      // Everything is back, Fintava's charge included (they did nothing wrong).
      expect(balance(p1)).toBe(START);
      expect(balance(p2)).toBe(START);
      expect(moves(p1)).toHaveLength(1);
      expect(moves(p1)[0].amountKobo).toBe(one.totalKobo);
      expect(moves(p2)).toHaveLength(1);
      expect(moves(p2)[0].amountKobo).toBe(two.totalKobo);
      for (const [p, paid] of [
        [p1, one],
        [p2, two],
      ] as const) {
        const hold = await holdOf(paid.orderId);
        expect(hold).toMatchObject({
          status: 'refunded',
          action: 'refund',
          transferKobo: BigInt(paid.totalKobo),
        });
        expect(hold.refundedKobo).toBe(hold.amountKobo);
        expect(await ledgerOf(hold.customerReference!)).toEqual(
          expect.arrayContaining([
            {
              walletKind: 'merchant',
              direction: 'out',
              category: 'refund',
              amountKobo: BigInt(paid.totalKobo),
            },
            {
              walletKind: 'user',
              direction: 'in',
              category: 'refund',
              amountKobo: BigInt(paid.totalKobo),
            },
          ]),
        );
        // The order reads refunded and its tickets are void.
        expect(await orderOf(paid.orderId)).toMatchObject({
          status: 'refunded',
          failureReason: 'The host called the event off.',
          refundError: null,
        });
        expect(new Set(await ticketStates(paid.orderId))).toEqual(
          new Set(['void']),
        );
        const view = await readOrder(p, paid.orderId);
        expect(view.returned).toMatchObject({
          returned: true,
          returnedKobo: paid.totalKobo,
        });
        expect(view.failureReason).toContain('back in your wallet');
      }
      // A free ticket has no payment, so nothing goes back: its ticket is void.
      expect(await orderOf(freeOrder.order.id)).toMatchObject({
        status: 'paid',
        refundError: null,
      });
      expect(new Set(await ticketStates(freeOrder.order.id))).toEqual(
        new Set(['void']),
      );
      expect(
        await h.prisma.walletHold.count({
          where: { targetId: freeOrder.order.id },
        }),
      ).toBe(0);
      // An unpaid quote is left alone, and nothing was taken for it.
      expect((await orderOf(unpaid.order.id)).status).toBe('pending');
      expect(balance(p3)).toBe(START);
    });

    it("keeps the buyer's ticket in My tickets, void, under the past ones", async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const { orderId } = await buy(p, e);
      await callOff(e).expect(201);

      const past = body<
        Array<{
          orderId: string;
          quantity: number;
          event: { cancelledAt: string | null };
          tickets: Array<{ status: string }>;
        }>
      >(
        await request(h.app.getHttpServer())
          .get('/api/hub/events/tickets/held?view=past')
          .set('Authorization', p.auth)
          .expect(200),
      ).data!;
      const mine = past.filter((g) => g.orderId === orderId);
      expect(mine.reduce((n, g) => n + g.quantity, 0)).toBe(2);
      for (const g of mine) {
        expect(g.event.cancelledAt).not.toBeNull();
        expect(g.tickets.every((t) => t.status === 'void')).toBe(true);
      }
    });

    it('asking again moves nothing: a second cancel, the sweep and a retry', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const { orderId } = await buy(p, e);
      await callOff(e).expect(201);
      expect(balance(p)).toBe(START);

      await callOff(e).expect(409);
      expect(await h.callOff.refundEvent(e.id)).toEqual({
        refunded: 0,
        needAttention: 0,
      });
      expect(await h.callOff.sweep()).toMatchObject({
        refunded: 0,
        needAttention: 0,
      });
      await h.holds.sweep(LATER());
      expect(moves(p)).toHaveLength(1);
      expect(balance(p)).toBe(START);
      expect((await holdOf(orderId)).status).toBe('refunded');
    });

    it('is one move per order when cancels, a retry and the sweep all run at once', async () => {
      const e = await summit();
      const buyers = await Promise.all([1, 2, 3, 4].map(() => h.buyer(START)));
      for (const p of buyers) await buy(p, e);

      await Promise.all([
        callOff(e),
        callOff(e),
        h.callOff.refundEvent(e.id),
        h.callOff.sweep(),
      ]);
      await h.callOff.refundEvent(e.id);
      await h.callOff.sweep();

      for (const p of buyers) {
        expect(moves(p)).toHaveLength(1);
        expect(balance(p)).toBe(START - TOTAL + TOTAL);
      }
      expect(
        await h.prisma.eventOrder.count({
          where: { eventId: e.id, status: 'refunded' },
        }),
      ).toBe(4);
    });

    it('sends nothing for an event that was not called off', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      await buy(p, e);

      expect(await h.callOff.refundEvent(e.id)).toEqual({
        refunded: 0,
        needAttention: 0,
      });
      expect(await h.callOff.sweep()).toMatchObject({ refunded: 0 });
      expect(moves(p)).toHaveLength(0);
      expect(balance(p)).toBe(START - TOTAL);
    });

    it('chooses the refund even while the provider is down, and the hold sweep sends it when it is back', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const { orderId } = await buy(p, e);

      await h.double.pause();
      const res = await callOff(e).expect(201);
      await h.double.resume();

      expect(body<Record<string, unknown>>(res).data).toMatchObject({
        cancelled: true,
        ordersRefunded: 1,
        refundsNeedingAttention: 0,
      });
      // The money has not moved, but it can only go back to the buyer now.
      expect(moves(p)).toHaveLength(0);
      expect(balance(p)).toBe(START - TOTAL);
      expect(await holdOf(orderId)).toMatchObject({
        status: 'held',
        action: 'refund',
      });
      expect(await orderOf(orderId)).toMatchObject({ status: 'refunded' });
      const waiting = await readOrder(p, orderId);
      expect(waiting.returned).toMatchObject({
        returned: false,
        returnedKobo: null,
      });
      expect(waiting.failureReason).toContain('on its way');

      await h.holds.sweep(LATER());
      await h.holds.sweep(LATER());
      expect((await holdOf(orderId)).status).toBe('refunded');
      expect(moves(p)).toHaveLength(1);
      expect(balance(p)).toBe(START);
      expect((await readOrder(p, orderId)).returned).toMatchObject({
        returned: true,
        returnedKobo: TOTAL,
      });
    });

    it('leaves a price the host was already paid for a person, says why, and refunds the rest', async () => {
      const host = await h.buyer(0);
      const e = await summit({ hostId: host.id });
      const p1 = await h.buyer(START);
      const p2 = await h.buyer(START);
      const paidOut = await buy(p1, e);
      const other = await buy(p2, e);
      // The event took place for the first buyer's order: the host's share went.
      const released = await h.holds.release({
        holdId: (await holdOf(paidOut.orderId)).id,
      });
      expect(released.state).toBe('settled');

      const res = await callOff(e).expect(201);

      expect(body<Record<string, unknown>>(res).data).toMatchObject({
        ordersRefunded: 1,
        refundsNeedingAttention: 1,
      });
      expect(balance(p2)).toBe(START);
      expect((await orderOf(other.orderId)).status).toBe('refunded');
      expect(balance(p1)).toBe(START - paidOut.totalKobo);
      expect(moves(p1)).toHaveLength(0);
      const stuck = await orderOf(paidOut.orderId);
      expect(stuck.status).toBe('paid');
      expect(stuck.refundError).toContain('paid out');
      expect((await holdOf(paidOut.orderId)).status).toBe('released');
      // The sweep does not flag it again or try to send anything.
      expect(await h.callOff.sweep()).toMatchObject({
        refunded: 0,
        needAttention: 0,
      });
      expect(moves(p1)).toHaveLength(0);
    });

    it('refunds a payment still being confirmed when the host calls the event off, once it lands', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      h.wallets.mode = 'timeout';
      await r.pay(p, payBody(q)).expect(201);
      h.wallets.mode = 'live';

      const res = await callOff(e).expect(201);
      expect(body<Record<string, unknown>>(res).data).toMatchObject({
        ordersRefunded: 0,
        refundsNeedingAttention: 0,
      });
      // Not paid yet, so nothing for the call-off to send back.
      expect((await orderOf(q.order.id)).status).toBe('pending');

      await h.sweepLater();
      await h.sweepLater();
      await h.holds.sweep(LATER());

      const order = await orderOf(q.order.id);
      expect(order.status).toBe('failed');
      expect(order.failureReason).toContain('called off');
      expect(await ticketStates(q.order.id)).toEqual([]);
      expect(balance(p)).toBe(START);
      expect(moves(p)).toHaveLength(1);
      await h.callOff.sweep();
      expect(moves(p)).toHaveLength(1);
    });

    it('makes no ticket for an event called off a moment before the tickets were made', async () => {
      const e = await summit();
      const p = await h.buyer(START);
      const q = await start(p, e);
      h.wallets.mode = 'timeout';
      await r.pay(p, payBody(q)).expect(201);
      h.wallets.mode = 'live';

      // The cancel has the event row but has not committed; the payment's
      // delivery reads the event as it was, then waits for the cancel.
      const cancelling = h.prisma.$transaction(
        async (tx) => {
          await tx.event.update({
            where: { id: e.id },
            data: { status: 'cancelled', cancelledAt: new Date() },
          });
          await sleep(2_000);
        },
        { timeout: 30_000 },
      );
      await sleep(300);
      const delivering = h.sweepLater();
      await Promise.all([cancelling, delivering]);
      await h.sweepLater();
      await h.holds.sweep(LATER());

      const order = await orderOf(q.order.id);
      expect(order.status).toBe('failed');
      expect(await ticketStates(q.order.id)).toEqual([]);
      expect(balance(p)).toBe(START);
      expect(moves(p)).toHaveLength(1);
    });
  });

  describe('a slow provider', () => {
    it('refunds twenty buyers while holding no connection, and another person is not kept waiting', async () => {
      const e = await summit();
      const buyers: Person[] = [];
      for (let i = 0; i < 20; i += 1) buyers.push(await h.buyer(START));
      for (const p of buyers) {
        await buy(p, e, lines(e, 1, 0));
      }
      const bystander = await h.buyer(START);
      const quote = await start(bystander, e);

      // The provider takes three seconds to answer each move.
      h.double.on(
        'POST',
        '/transaction/wallet-to-wallet',
        (req: SeenRequest) => {
          const b = req.body as {
            senderAccount: string;
            receiverAccount: string;
            amount: number;
            CustomerReference: string;
          };
          if (h.wallets.references.has(b.CustomerReference)) {
            return {
              status: 400,
              body: fintavaError(400, 'customerReference already exists'),
            };
          }
          const amountKobo = Math.round(b.amount * 100);
          const feeKobo = liveFee(amountKobo);
          const have = h.wallets.kobo.get(b.senderAccount) ?? 0;
          h.wallets.references.add(b.CustomerReference);
          h.wallets.kobo.set(b.senderAccount, have - amountKobo - feeKobo);
          h.wallets.kobo.set(
            b.receiverAccount,
            (h.wallets.kobo.get(b.receiverAccount) ?? 0) + amountKobo,
          );
          h.wallets.sends.push({
            from: b.senderAccount,
            to: b.receiverAccount,
            amountKobo,
            feeKobo,
            reference: b.CustomerReference,
          });
          return {
            status: 200,
            delayMs: 3_000,
            body: {
              data: {
                amount: amountKobo / 100,
                reference: `tagapay${randomUUID().replace(/-/g, '')}`,
                customerReference: randomUUID(),
                total: (amountKobo + feeKobo) / 100,
                transaction_fee: feeKobo / 100,
                source_customer_accno: b.senderAccount,
                description: 'Fund transfer between customers',
              },
              status: 200,
              message: 'successful',
            },
          };
        },
      );

      // The cancel is SENT now (`.then()` is what sends a supertest request),
      // so the bystander's reads below happen while it is in flight.
      const startedAt = Date.now();
      let cancelEndedAt = 0;
      const cancelling = callOff(e).then((res) => {
        cancelEndedAt = Date.now();
        return res;
      });
      const reads: Array<{ atMs: number; tookMs: number }> = [];
      while (cancelEndedAt === 0 && reads.length < 60) {
        await sleep(700);
        const t0 = Date.now();
        await r.read(bystander, quote.order.id).expect(200);
        reads.push({ atMs: t0 - startedAt, tookMs: Date.now() - t0 });
      }
      const res = await cancelling;
      const tookMs = cancelEndedAt - startedAt;
      installFintava(h.double, h.wallets);
      const during = reads.filter((x) => x.atMs < tookMs);
      console.log(
        `EVENTS-13 twenty buyers: cancel ${tookMs} ms; ${during.length} bystander reads while it ran, slowest ${Math.max(...reads.map((x) => x.tookMs))} ms: ${JSON.stringify(reads)}`,
      );

      expect(res.status).toBe(201);
      const answer = body<Record<string, number | boolean>>(res).data!;
      // Every order is accounted for: sent back, needing a person, or left to
      // the minute sweep (the request stops starting new refunds at 15 s).
      expect(
        (answer.ordersRefunded as number) +
          (answer.refundsNeedingAttention as number) +
          ((answer.ordersLeftToSweep as number | undefined) ?? 0),
      ).toBe(20);
      expect(answer.refundsNeedingAttention).toBe(0);
      // Twenty moves of three seconds, five at a time: about twelve seconds,
      // not sixty, and nothing else waited on them. The reads really ran
      // during the cancel (a request nobody sent measures nothing).
      expect(tookMs).toBeLessThan(25_000);
      expect(during.length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...reads.map((x) => x.tookMs))).toBeLessThan(1_000);

      // After the sweeps every buyer is whole, with exactly one move. A refund
      // is "chosen" when the answer counts it, and a minute sweep of ANOTHER
      // process on the same database (the local stack's Hub, which reaches no
      // provider) can take a hold's lease between its choice and its send; the
      // hold then waits out a two minute back-off. Our own sweep, run as if
      // the back-off were over, sends it, so the test waits for that and for
      // nothing else.
      const sweepEnd = Date.now() + 30_000;
      while (
        !buyers.every((p) => balance(p) === START) &&
        Date.now() < sweepEnd
      ) {
        await h.callOff.sweep();
        await h.holds.sweep(LATER());
        await sleep(250);
      }
      for (const p of buyers) {
        expect(balance(p)).toBe(START);
        expect(moves(p)).toHaveLength(1);
      }
    });
  });
});
