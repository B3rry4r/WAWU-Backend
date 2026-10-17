import { randomUUID } from 'node:crypto';
import {
  api,
  bootEventApp,
  type EventHarness,
  type Person,
  type SeededEvent,
} from '../../../test/events/event-wallet-harness';
import { body } from '../../../test/payments/poll-helpers';
import type {
  EventWalletOrderQuoteView,
  EventWalletOrderView,
} from '../wallet/event-wallet-order-view.type';

/**
 * EVENTS-07 and WALLET-23: a ticket payment counts against the person's daily
 * purchase limit through the payment service's own check, and a ticket order
 * that failed and was refunded does not use the day up (FIX-40). Fintava's
 * double and a real database; nothing reaches a provider.
 */

const ONE_ORDER = 750_000; // one Regular ticket at ₦7,500
const START = 10_000_000;
const code = (res: { body: unknown }) =>
  (res.body as { reason?: { code?: string } }).reason?.code ?? null;

jest.setTimeout(120_000);

describe('EVENTS-07: the daily purchase limit and ticket orders', () => {
  let h: EventHarness;
  let r: ReturnType<typeof api>;

  beforeAll(async () => {
    h = await bootEventApp('events07lim', {
      WAWU_LIMIT_PURCHASE_DAILY_KOBO: String(ONE_ORDER),
    });
    r = api(h);
  });
  afterAll(async () => {
    await h.close();
  });

  const one = async (p: Person, e: SeededEvent) =>
    body<EventWalletOrderQuoteView>(
      await r
        .create(p, e.id, {
          lines: [{ ticketTypeId: e.tiers[0].id, quantity: 1 }],
        })
        .expect(201),
    ).data!;
  const pb = (q: EventWalletOrderQuoteView) => ({
    orderId: q.order.id,
    expectedTotalKobo: q.payment!.totalKobo,
    quoteToken: q.payment!.quoteToken,
  });

  it('a refunded order leaves the limit free; a paid one uses it up', async () => {
    const e = await h.event({
      tiers: [{ name: 'Regular', priceNaira: 7_500, quantity: 5 }],
    });
    const p = await h.buyer(START);

    // Order 1: the seats go while the debit is unconfirmed, so it is refunded.
    const first = await one(p, e);
    h.wallets.mode = 'timeout';
    await r.pay(p, pb(first)).expect(201);
    h.wallets.mode = 'live';
    await h.prisma.eventTicketType.update({
      where: { id: e.tiers[0].id },
      data: { sold: 5 },
    });
    await h.sweepLater();
    await h.sweepLater();
    await h.holds.sweep();
    await h.holds.sweep();
    const failed = body<EventWalletOrderView>(
      await r.read(p, first.order.id).expect(200),
    ).data!;
    expect(failed.status).toBe('failed');
    expect(failed.returned?.returned).toBe(true);
    await h.prisma.eventTicketType.update({
      where: { id: e.tiers[0].id },
      data: { sold: 0 },
    });

    // Order 2: the quote says it fits, and it is paid.
    const next = await one(p, e);
    expect(next.payment!.withinDailyLimit).toBe(true);
    const done = await r.pay(p, pb(next)).expect(201);
    expect(body<EventWalletOrderView>(done).data!.status).toBe('paid');

    // Order 3: order 2 used the day up.
    const third = await one(p, e);
    expect(third.payment!.withinDailyLimit).toBe(false);
    const refused = await r.pay(p, pb(third), { key: randomUUID() });
    expect(refused.status).toBe(403);
    expect(code(refused)).toBe('limit_reached');
  });
});
