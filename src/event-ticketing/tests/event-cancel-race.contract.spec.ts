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
 * EVENTS-13 over HTTP, a real database and the Fintava double (no provider is
 * called): a host's cancel is answered once however many arrive together, and
 * a free order made at the instant of the cancel never leaves a valid ticket
 * on the called-off event.
 */

const START = 50_000_000;
const TAG = 'events13b';
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

jest.setTimeout(300_000);

describe('EVENTS-13: calling an event off once, and no free ticket on a called-off event', () => {
  let h: EventHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootEventApp(TAG);
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
    h.double.seen.length = 0;
  });

  const summit = (): Promise<SeededEvent> =>
    h.event({
      tiers: [
        { name: 'Regular', priceNaira: 7_500, quantity: 100 },
        { name: 'Free entry', priceNaira: 0, quantity: 100 },
      ],
    });
  const callOff = (e: SeededEvent, reason: string) =>
    request(h.app.getHttpServer())
      .post(`/api/hub/events/${e.id}/cancel`)
      .set('Authorization', `Bearer ${mintToken(e.hostId, TAG)}`)
      .send({ reason });
  async function buy(p: Person, e: SeededEvent): Promise<string> {
    const made = await r
      .create(p, e.id, {
        lines: [{ ticketTypeId: e.tiers[0].id, quantity: 1 }],
      })
      .expect(201);
    const q = body<EventWalletOrderQuoteView>(made).data!;
    const res = await r
      .pay(p, {
        orderId: q.order.id,
        expectedTotalKobo: q.payment!.totalKobo,
        quoteToken: q.payment!.quoteToken,
      })
      .expect(201);
    expect(body<EventWalletOrderView>(res).data!.status).toBe('paid');
    return q.order.id;
  }
  const refunds = (p: Person) =>
    h.wallets.sends.filter(
      (s) => s.from === MERCHANT_ACCOUNT && s.to === p.accountNumber,
    );

  describe.each([6, 20])('%i cancels at once', (count) => {
    it('answers one 201 and the rest 409, and sends each buyer their money once', async () => {
      const e = await summit();
      const buyers: Person[] = [];
      for (let i = 0; i < 3; i += 1) {
        const p = await h.buyer(START);
        await buy(p, e);
        buyers.push(p);
      }

      const results = await Promise.all(
        Array.from({ length: count }, (_, i) =>
          callOff(e, `Reason number ${i}.`).then((res) => ({
            i,
            status: res.status,
            body: body<Record<string, unknown>>(res),
          })),
        ),
      );

      const won = results.filter((x) => x.status === 201);
      const lost = results.filter((x) => x.status !== 201);
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(count - 1);
      expect(won[0].body.data).toMatchObject({
        cancelled: true,
        ordersRefunded: 3,
        refundsNeedingAttention: 0,
      });
      // Nothing was left to the sweep, so the answer keeps the shape the web was built against.
      expect(won[0].body.data).not.toHaveProperty('ordersLeftToSweep');
      // The loser gets exactly what a cancel that comes later gets today.
      const later = await callOff(e, 'Too late to call it off again.');
      expect(later.status).toBe(409);
      for (const x of lost) {
        expect(x.status).toBe(409);
        expect(x.body.message).toBe(
          body<Record<string, unknown>>(later).message,
        );
        expect(x.body.message).toBe('This event is already cancelled.');
      }
      // The winner's reason is the one that was kept.
      const row = await h.prisma.event.findUniqueOrThrow({
        where: { id: e.id },
        select: { cancelReason: true, status: true },
      });
      expect(row).toEqual({
        cancelReason: `Reason number ${won[0].i}.`,
        status: 'cancelled',
      });
      // Each order was sent back once.
      for (const p of buyers) {
        expect(refunds(p)).toHaveLength(1);
      }
    });
  });

  it('says how many orders the request left to the minute sweep, and the sweep sends them', async () => {
    const e = await summit();
    const buyers: Person[] = [];
    for (let i = 0; i < 4; i += 1) {
      const p = await h.buyer(START);
      await buy(p, e);
      buyers.push(p);
    }
    // The request's 15 seconds are already used up when it starts refunding.
    const original = h.callOff.refundEvent.bind(h.callOff);
    const spy = jest
      .spyOn(h.callOff, 'refundEvent')
      .mockImplementation((id) => original(id, -1));
    const res = await callOff(e, 'The venue is not available.').expect(201);
    spy.mockRestore();

    const answer = body<Record<string, number>>(res).data!;
    expect(answer).toMatchObject({
      cancelled: true,
      ordersRefunded: 0,
      refundsNeedingAttention: 0,
      ordersLeftToSweep: 4,
    });
    // Every paid order is counted once.
    expect(
      answer.ordersRefunded +
        answer.refundsNeedingAttention +
        answer.ordersLeftToSweep,
    ).toBe(4);
    for (const p of buyers) expect(refunds(p)).toHaveLength(0);

    expect(await h.callOff.sweep()).toMatchObject({ refunded: 4 });
    for (const p of buyers) expect(refunds(p)).toHaveLength(1);
    // Nothing left now: a second look says so.
    expect(await h.callOff.refundEvent(e.id)).toEqual({
      refunded: 0,
      needAttention: 0,
    });
  });

  it('leaves no valid ticket on a called-off event when a free order races the cancel (60 rounds)', async () => {
    const outcomes = { ordered: 0, refused: 0, other: 0 };
    const validAfter: string[] = [];
    for (let round = 0; round < 60; round += 1) {
      const e = await summit();
      const p = h.walletless();
      const free = r
        .create(p, e.id, {
          lines: [{ ticketTypeId: e.tiers[1].id, quantity: 1 }],
        })
        .then((res) => res);
      // The cancel lands 0 to 15 ms from the order, either side of it.
      const jitter = round % 16;
      const cancelling = sleep(jitter).then(() =>
        callOff(e, 'The host called it off.').then((res) => res),
      );
      const [made, cancelled] = await Promise.all([free, cancelling]);

      expect(cancelled.status).toBe(201);
      if (made.status === 201) outcomes.ordered += 1;
      else if (made.status === 409) outcomes.refused += 1;
      else outcomes.other += 1;
      const valid = await h.prisma.eventTicket.count({
        where: { eventId: e.id, status: { in: ['valid', 'checked_in'] } },
      });
      if (valid > 0) validAfter.push(`${e.id} (${valid})`);
    }
    console.log(
      `EVENTS-13 free order against cancel, 60 rounds: ${JSON.stringify(outcomes)}; rounds with a valid ticket left: ${validAfter.length}`,
    );
    expect(outcomes.other).toBe(0);
    expect(validAfter).toEqual([]);
  });
});
