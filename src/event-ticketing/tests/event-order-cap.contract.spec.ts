import { BadRequestException } from '@nestjs/common';
import {
  api,
  bootEventApp,
  type EventHarness,
  type Person,
  type SeededEvent,
} from '../../../test/events/event-wallet-harness';
import { MERCHANT_ACCOUNT } from '../../../test/fintava/fintava-double';
import { body } from '../../../test/payments/poll-helpers';
import { AdminRole } from '../../../generated/prisma/enums';
import { PlanSettingsService } from '../../plan-settings/plan-settings.service';
import {
  OPEN_ORDERS_SETTING,
  ORDER_LIMIT_MESSAGE,
} from '../wallet/event-wallet-order-rules';
import type {
  EventWalletOrderQuoteView,
  EventWalletOrderView,
} from '../wallet/event-wallet-order-view.type';

/**
 * EVENTS-13 over HTTP, a real database and the Fintava double (no provider is
 * called): one buyer holds at most N open paid ticket orders on one event (an
 * admin setting, launch value 10). Order N+1 is refused before anything is
 * recorded or sent, under any number of parallel requests; an order that
 * failed or was refunded frees its place; a free order is never counted; the
 * setting changes with no restart.
 */

const REGULAR = 750_000;
const FEE = 1_575;
const TOTAL = REGULAR + FEE;
const START = 100_000_000;
const ADMIN = {
  id: 'events-13-admin',
  email: 'events-13@example.test',
  role: AdminRole.superadmin,
};

jest.setTimeout(240_000);

describe('EVENTS-13: the most open ticket orders one buyer holds on one event', () => {
  let h: EventHarness;
  let r: ReturnType<typeof api>;
  let settings: PlanSettingsService;

  beforeAll(async () => {
    h = await bootEventApp('events13a');
    r = api(h);
    settings = h.app.get(PlanSettingsService, { strict: false });
  });
  afterAll(async () => {
    await h.prisma.planSetting.deleteMany({
      where: { key: OPEN_ORDERS_SETTING },
    });
    await h.prisma.adminOpsAudit.deleteMany({
      where: { actedByAdminId: ADMIN.id },
    });
    await h.close();
  });
  beforeEach(() => {
    h.wallets.mode = 'live';
    h.double.seen.length = 0;
  });
  afterEach(async () => {
    await setLimit(null);
  });

  const setLimit = (n: number | null) =>
    settings.set(ADMIN, { settings: { [OPEN_ORDERS_SETTING]: n } });
  const concert = (): Promise<SeededEvent> =>
    h.event({
      tiers: [
        { name: 'Regular', priceNaira: 7_500, quantity: 500 },
        { name: 'Free entry', priceNaira: 0, quantity: 100 },
      ],
    });
  const regular = (e: SeededEvent) => ({
    lines: [{ ticketTypeId: e.tiers[0].id, quantity: 1 }],
  });
  const free = (e: SeededEvent) => ({
    lines: [{ ticketTypeId: e.tiers[1].id, quantity: 1 }],
  });
  const payBody = (q: EventWalletOrderQuoteView) => ({
    orderId: q.order.id,
    expectedTotalKobo: q.payment!.totalKobo,
    quoteToken: q.payment!.quoteToken,
  });
  async function start(
    p: Person,
    e: SeededEvent,
    send: Record<string, unknown> = regular(e),
  ): Promise<EventWalletOrderQuoteView> {
    const res = await r.create(p, e.id, send).expect(201);
    return body<EventWalletOrderQuoteView>(res).data!;
  }
  async function buy(p: Person, e: SeededEvent): Promise<string> {
    const q = await start(p, e);
    const res = await r.pay(p, payBody(q)).expect(201);
    expect(body<EventWalletOrderView>(res).data!.status).toBe('paid');
    return q.order.id;
  }
  const balance = (p: Person) => h.wallets.kobo.get(p.accountNumber);
  const debits = (p: Person) =>
    h.wallets.sends.filter(
      (s) => s.from === p.accountNumber && s.to === MERCHANT_ACCOUNT,
    );
  const ordersOf = (p: Person, e: SeededEvent) =>
    h.prisma.eventOrder.findMany({
      where: { buyerWawuId: p.id, eventId: e.id },
      select: { id: true, status: true, paymentProvider: true },
    });
  const paymentsOf = (p: Person) =>
    h.prisma.walletPayment.count({ where: { payerWawuUserId: p.id } });
  const refusedWith = (res: { status: number; body: unknown }) => {
    const b = res.body as {
      reason?: { code?: string; message?: string };
      message?: string;
    };
    return {
      status: res.status,
      code: b.reason?.code,
      message: b.reason?.message ?? b.message,
    };
  };

  it('holds 20 orders paid at once to exactly 10, and moves no money for the other 10', async () => {
    const e = await concert();
    const p = await h.buyer(START);
    // Twenty quotes first (nothing is paid, so nothing is refused), then all
    // twenty paid at the same moment.
    const quotes = await Promise.all(
      Array.from({ length: 20 }, () => start(p, e)),
    );
    const results = await Promise.all(
      quotes.map((q) => r.pay(p, payBody(q)).then((res) => res)),
    );

    const done = results.filter((x) => x.status === 201);
    const refused = results.filter((x) => x.status !== 201);
    expect(done).toHaveLength(10);
    expect(refused).toHaveLength(10);
    for (const x of refused) {
      expect(refusedWith(x)).toEqual({
        status: 409,
        code: 'event_order_limit',
        message: ORDER_LIMIT_MESSAGE,
      });
    }
    // The refused ones recorded nothing and sent nothing.
    expect(debits(p)).toHaveLength(10);
    expect(balance(p)).toBe(START - 10 * TOTAL);
    expect(await paymentsOf(p)).toBe(10);
    const orders = await ordersOf(p, e);
    expect(orders.filter((o) => o.status === 'paid')).toHaveLength(10);
    expect(orders.filter((o) => o.status === 'pending')).toHaveLength(10);

    // At the limit, another order is refused at once, before it is even made.
    const before = (await ordersOf(p, e)).length;
    const again = await r.create(p, e.id, regular(e));
    expect(refusedWith(again)).toEqual({
      status: 409,
      code: 'event_order_limit',
      message: ORDER_LIMIT_MESSAGE,
    });
    expect((await ordersOf(p, e)).length).toBe(before);
  });

  it('holds 20 whole purchases (quote, then pay) started at once to 10', async () => {
    const e = await concert();
    const p = await h.buyer(START);
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const made = await r.create(p, e.id, regular(e));
        if (made.status !== 201) return refusedWith(made);
        const q = body<EventWalletOrderQuoteView>(made).data!;
        const paid = await r.pay(p, payBody(q));
        return paid.status === 201 ? { status: 201 } : refusedWith(paid);
      }),
    );
    expect(outcomes.filter((o) => o.status === 201)).toHaveLength(10);
    const refused = outcomes.filter((o) => o.status !== 201);
    expect(refused).toHaveLength(10);
    for (const o of refused) {
      expect(o).toEqual({
        status: 409,
        code: 'event_order_limit',
        message: ORDER_LIMIT_MESSAGE,
      });
    }
    expect(debits(p)).toHaveLength(10);
    expect(balance(p)).toBe(START - 10 * TOTAL);
    expect(
      (await ordersOf(p, e)).filter((o) => o.status === 'paid'),
    ).toHaveLength(10);
  });

  it('frees a place when an order is refunded or fails, and counts neither a free order, another event nor another buyer', async () => {
    await setLimit(2);
    const e = await concert();
    const other = await concert();
    const p = await h.buyer(START);
    const q1 = await start(p, e);
    const q2 = await start(p, e);
    const q3 = await start(p, e);
    const q4 = await start(p, e);
    await r.pay(p, payBody(q1)).expect(201);
    await r.pay(p, payBody(q2)).expect(201);

    expect(refusedWith(await r.pay(p, payBody(q3)))).toMatchObject({
      status: 409,
      code: 'event_order_limit',
    });
    expect(debits(p)).toHaveLength(2);

    // A refunded order frees its place; so does a failed one.
    await h.prisma.eventOrder.update({
      where: { id: q1.order.id },
      data: { status: 'refunded' },
    });
    await r.pay(p, payBody(q3)).expect(201);
    expect(refusedWith(await r.pay(p, payBody(q4)))).toMatchObject({
      code: 'event_order_limit',
    });
    await h.prisma.eventOrder.update({
      where: { id: q2.order.id },
      data: { status: 'failed' },
    });
    await r.pay(p, payBody(q4)).expect(201);
    expect(debits(p)).toHaveLength(4);

    // Two open orders now: a free order is not counted, and is not refused.
    for (let i = 0; i < 3; i += 1) {
      const res = await r.create(p, e.id, free(e)).expect(201);
      const order = body<EventWalletOrderQuoteView>(res).data!.order;
      expect(order).toMatchObject({ free: true, status: 'paid' });
    }
    // The limit is per event and per buyer.
    await buy(p, other);
    const stranger = await h.buyer(START);
    await buy(stranger, e);
    await buy(stranger, e);
    expect(
      refusedWith(await r.create(stranger, e.id, regular(e))),
    ).toMatchObject({ code: 'event_order_limit' });
  });

  it('follows an admin edit of the limit with no restart, audits it, and refuses a value under 1', async () => {
    const e = await concert();
    const p = await h.buyer(START);
    const quotes = await Promise.all(
      Array.from({ length: 4 }, () => start(p, e)),
    );
    await setLimit(2);
    await r.pay(p, payBody(quotes[0])).expect(201);
    await r.pay(p, payBody(quotes[1])).expect(201);
    expect(refusedWith(await r.pay(p, payBody(quotes[2])))).toMatchObject({
      code: 'event_order_limit',
    });

    // Raised: the very next payment in this process uses the new figure.
    await setLimit(3);
    await r.pay(p, payBody(quotes[2])).expect(201);
    expect(refusedWith(await r.pay(p, payBody(quotes[3])))).toMatchObject({
      code: 'event_order_limit',
    });
    // Lowered under what the buyer holds: nothing is undone, the next is refused.
    await setLimit(1);
    expect(settings.number(OPEN_ORDERS_SETTING)).toBe(1);
    expect(refusedWith(await r.create(p, e.id, regular(e)))).toMatchObject({
      code: 'event_order_limit',
    });
    expect(
      (await ordersOf(p, e)).filter((o) => o.status === 'paid'),
    ).toHaveLength(3);

    // Under 1 is refused, and the saved figure stays.
    await expect(setLimit(0)).rejects.toBeInstanceOf(BadRequestException);
    expect(settings.number(OPEN_ORDERS_SETTING)).toBe(1);
    // Back to the launch figure.
    await setLimit(null);
    expect(settings.number(OPEN_ORDERS_SETTING)).toBe(10);
    await r.pay(p, payBody(quotes[3])).expect(201);

    const audit = await h.prisma.adminOpsAudit.findMany({
      where: {
        actedByAdminId: ADMIN.id,
        resource: 'plan_setting',
        resourceId: OPEN_ORDERS_SETTING,
      },
      orderBy: { actedAt: 'asc' },
    });
    expect(audit.length).toBeGreaterThanOrEqual(4);
    expect(audit.every((a) => a.action === 'plan_setting_set')).toBe(true);
  });
});
