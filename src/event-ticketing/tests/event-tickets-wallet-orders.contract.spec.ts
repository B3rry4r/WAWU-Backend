import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import type { Server } from 'http';
import request from 'supertest';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { EventModule } from '../../event/event.module';
import { EventTicketingModule } from '../event-ticketing.module';
import { EventWalletOrderService } from '../wallet/event-wallet-order.service';
import { MoneyError } from '../../money/money-error';

/**
 * EVENTS-11 over EVENTS-07: a host's PUT /events/:id/tickets when wallet
 * orders point at the tiers, and a wallet order meeting a retired tier.
 *
 * Written for the refresh onto batch 7 (EVENTS-11 refresh). It needs no
 * wallet provider at all: the wallet rows (orders, lines, payments, holds)
 * are written straight into the database, and the wallet order service is
 * built with the pieces that talk to a provider replaced by plain stubs, so
 * the code under test is only the ticket-tier rules.
 *
 * What it holds, side by side:
 *  - EVENTS-07: an unpaid quote on a tier the PUT drops goes with the tier
 *    (the buyer asks again); a payment still being confirmed is waited for
 *    (409, nothing written); a failed or refunded wallet order goes once its
 *    price is back, and the host waits while it is on its way (409).
 *  - EVENTS-11: only the tiers a PUT drops matter (a quote on a tier it
 *    keeps is untouched); a tier any other order points at is retired, not
 *    deleted; a retired tier cannot be bought again from the wallet; a
 *    paid quote is never written against a tier that is going away.
 *
 * Fixture ids `ee11c0..`; the host's tick columns are snapshotted and
 * written back.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';
const HOST_EMAIL = 'creator-pro@test.wawu.dev';
const HOST_SUB = '00000000-0000-4000-8000-000000000003';
const EV = 'ee11c000-0000-4000-8000-000000000001';
const TIER_CHANGED = 'This ticket has changed. Please choose again.';
const RACE_ROUNDS = 25;

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok)
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  return ((await res.json()) as { accessToken: string }).accessToken;
}

type TierBody = {
  tier: 'regular' | 'vip';
  name: string;
  priceNaira: number;
  quantity: number;
};
const REGULAR: TierBody = {
  tier: 'regular',
  name: 'Regular',
  priceNaira: 7500,
  quantity: 100,
};
const VIP: TierBody = {
  tier: 'vip',
  name: 'VIP',
  priceNaira: 20000,
  quantity: 10,
};

describe('PUT /events/:id/tickets with wallet orders on the tiers (EVENTS-11 over EVENTS-07)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let hostToken: string;
  let wallet: EventWalletOrderService;
  let tickSnapshot: Record<string, Date | null> | null = null;
  let tiers: { regular: string; vip: string };

  const http = () => request(app.getHttpServer() as Server);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const put = (types: TierBody[]) =>
    http()
      .put(`/api/hub/events/${EV}/tickets`)
      .set(auth(hostToken))
      .send({ types });

  async function sweep(): Promise<void> {
    await prisma.walletHold.deleteMany({ where: { kind: 'event_ticket' } });
    await prisma.walletPayment.deleteMany({ where: { kind: 'event_ticket' } });
    await prisma.adminEventReview.deleteMany({ where: { eventId: EV } });
    // Orders, lines and tiers cascade from Event.
    await prisma.event.deleteMany({ where: { id: EV } });
  }

  /** A fresh published event with a Regular and a VIP tier. */
  async function onSale(): Promise<void> {
    await sweep();
    await prisma.event.create({
      data: {
        id: EV,
        hostWawuId: HOST_SUB,
        name: 'EV11 wallet orders',
        description: 'A fixture for the EVENTS-11 wallet orders suite.',
        hostOrg: 'EV11 Fixtures Ltd',
        format: 'in_person',
        type: 'workshop',
        location: 'Lagos',
        startsAt: new Date('2027-05-06T09:00:00.000Z'),
        status: 'published',
        ticketTypes: { create: [REGULAR, VIP] },
      },
    });
    const rows = await prisma.eventTicketType.findMany({
      where: { eventId: EV },
    });
    tiers = {
      regular: rows.find((r) => r.tier === 'regular')!.id,
      vip: rows.find((r) => r.tier === 'vip')!.id,
    };
  }

  /** A wallet order written straight into the database, as EVENTS-07 writes one. */
  async function seedWalletOrder(opts: {
    status: 'pending' | 'failed' | 'refunded';
    lines: Array<{ tierId: string; unit: number; quantity: number }>;
    payment?: 'pending' | 'completed' | 'failed';
    hold?: 'held' | 'refunded';
  }): Promise<string> {
    const id = randomUUID();
    const total = opts.lines.reduce((n, l) => n + l.unit * l.quantity, 0);
    await prisma.eventOrder.create({
      data: {
        id,
        eventId: EV,
        ticketTypeId: opts.lines[0].tierId,
        buyerWawuId: randomUUID(),
        quantity: opts.lines.reduce((n, l) => n + l.quantity, 0),
        amountNaira: total,
        commissionRate: 0.15,
        status: opts.status,
        flutterwaveTxRef: `wawu-event-wallet-${id}`,
        paymentProvider: 'wallet',
        paymentReference: `WAW-EVT-${id.slice(0, 8)}`,
        lines: {
          create: opts.lines.map((l) => ({
            ticketTypeId: l.tierId,
            tierName: 'seed',
            unitPriceNaira: l.unit,
            quantity: l.quantity,
          })),
        },
      },
    });
    if (opts.payment) {
      const payment = await prisma.walletPayment.create({
        data: {
          kind: 'event_ticket',
          targetId: id,
          title: 'EV11 wallet orders',
          priceKobo: BigInt(total * 100),
          providerFeeKobo: BigInt(0),
          wawuFeeKobo: BigInt(0),
          totalKobo: BigInt(total * 100),
          payeeShareKobo: BigInt(0),
          wawuShareKobo: BigInt(0),
          customerReference: `ev11c-${id}`,
          merchantAccountNumber: '0000000000',
          status: opts.payment,
        },
      });
      if (opts.hold) {
        await prisma.walletHold.create({
          data: {
            paymentId: payment.id,
            kind: 'event_ticket',
            targetId: id,
            title: 'EV11 wallet orders',
            releaseCondition: 'event_takes_place',
            amountKobo: BigInt(total * 100),
            payeeShareKobo: BigInt(total * 100),
            wawuShareKobo: BigInt(0),
            merchantAccountNumber: '0000000000',
            status: opts.hold,
            heldAt: new Date(),
            ...(opts.hold === 'held'
              ? {}
              : {
                  settledAt: new Date(),
                  action: 'refund',
                  actionAt: new Date(),
                  refundedKobo: BigInt(total * 100),
                }),
          },
        });
      }
    }
    return id;
  }

  /** A Flutterwave checkout left open on a tier (no wallet involved). */
  async function seedOpenCheckout(
    tierId: string,
    unit: number,
  ): Promise<string> {
    const id = randomUUID();
    await prisma.eventOrder.create({
      data: {
        id,
        eventId: EV,
        ticketTypeId: tierId,
        buyerWawuId: randomUUID(),
        quantity: 1,
        amountNaira: unit,
        commissionRate: 0.15,
        status: 'pending',
        flutterwaveTxRef: `ev11c-fw-${id}`,
      },
    });
    return id;
  }

  const orderCount = (id: string) => prisma.eventOrder.count({ where: { id } });
  const tierRows = () =>
    prisma.eventTicketType.findMany({
      where: { eventId: EV },
      orderBy: { priceNaira: 'asc' },
    });

  beforeAll(async () => {
    hostToken = await login(HOST_EMAIL);
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        EventModule,
        EventTicketingModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    await app.listen(Number(process.env.RACE_SPEC_PORT ?? 5355));
    prisma = moduleRef.get(PrismaService);

    // The wallet order service with everything that would reach a wallet
    // provider replaced by a stub: an open wallet for anyone, a quote that
    // only names the order, a visible event, the default order limit.
    wallet = new EventWalletOrderService(
      prisma,
      {
        quote: (_w: unknown, t: { targetId: string }) =>
          Promise.resolve({ stub: t.targetId }),
      } as never,
      { register: () => undefined } as never,
      {} as never,
      {
        requireOpen: (id: string) => Promise.resolve({ wawuUserId: id }),
      } as never,
      { assertVisible: () => Promise.resolve() } as never,
      {} as never,
      { number: () => 5 } as never,
    );

    tickSnapshot = await prisma.userProfile.findUnique({
      where: { wawuUserId: HOST_SUB },
      select: {
        creatorVerifiedAt: true,
        creatorVerifiedUntil: true,
        professionalVerifiedAt: true,
        professionalVerifiedUntil: true,
      },
    });
    await prisma.userProfile.update({
      where: { wawuUserId: HOST_SUB },
      data: {
        creatorVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        creatorVerifiedUntil: new Date('2099-01-01T00:00:00.000Z'),
      },
    });
  }, 60_000);

  afterAll(async () => {
    await sweep();
    if (tickSnapshot) {
      await prisma.userProfile.update({
        where: { wawuUserId: HOST_SUB },
        data: tickSnapshot,
      });
    }
    await app.close();
  });

  describe('EVENTS-07: wallet orders on the tiers a PUT drops', () => {
    it('an unpaid quote goes with the tiers it names, a basket of two included', async () => {
      await onSale();
      const quote = await seedWalletOrder({
        status: 'pending',
        lines: [
          { tierId: tiers.regular, unit: 7500, quantity: 1 },
          { tierId: tiers.vip, unit: 20000, quantity: 1 },
        ],
      });
      const res = await put([
        { ...REGULAR, name: 'General', priceNaira: 5000 },
      ]);
      expect(res.status).toBe(200);
      expect(await orderCount(quote)).toBe(0);
      const rows = await tierRows();
      expect(rows.map((r) => [r.name, !!r.retiredAt])).toEqual([
        ['General', false],
      ]);
    });

    it('a quote on a tier the PUT keeps is left alone (only dropped tiers matter)', async () => {
      await onSale();
      const quote = await seedWalletOrder({
        status: 'pending',
        lines: [{ tierId: tiers.regular, unit: 7500, quantity: 2 }],
      });
      const other = await seedWalletOrder({
        status: 'pending',
        lines: [{ tierId: tiers.vip, unit: 20000, quantity: 1 }],
      });
      // Regular is sent exactly as it is; VIP is repriced.
      const res = await put([REGULAR, { ...VIP, priceNaira: 25000 }]);
      expect(res.status).toBe(200);
      expect(await orderCount(quote)).toBe(1);
      expect(await orderCount(other)).toBe(0);
      const rows = await tierRows();
      expect(rows.find((r) => r.tier === 'regular')!.id).toBe(tiers.regular);
      expect(rows.find((r) => r.tier === 'vip')!.priceNaira).toBe(25000);
    });

    it('a payment still being confirmed is waited for: 409, nothing written', async () => {
      for (const status of ['pending', 'completed'] as const) {
        await onSale();
        const open = await seedWalletOrder({
          status: 'pending',
          lines: [{ tierId: tiers.regular, unit: 7500, quantity: 1 }],
        });
        const waiting = await seedWalletOrder({
          status: 'pending',
          lines: [{ tierId: tiers.regular, unit: 7500, quantity: 1 }],
          payment: status,
        });
        const res = await put([{ ...REGULAR, name: 'General' }]);
        expect(res.status).toBe(409);
        expect((res.body as { message: string }).message).toBe(
          'A payment for these tickets is still being confirmed. Try again in a minute.',
        );
        expect(await orderCount(open)).toBe(1);
        expect(await orderCount(waiting)).toBe(1);
        const event = await prisma.event.findUniqueOrThrow({
          where: { id: EV },
        });
        expect(event.status).toBe('published');
        expect((await tierRows()).map((r) => r.id).sort()).toEqual(
          [tiers.regular, tiers.vip].sort(),
        );
      }
    });

    it('a payment that failed no longer holds the host up', async () => {
      await onSale();
      const quote = await seedWalletOrder({
        status: 'pending',
        lines: [{ tierId: tiers.regular, unit: 7500, quantity: 1 }],
        payment: 'failed',
      });
      const res = await put([{ ...REGULAR, name: 'General' }]);
      expect(res.status).toBe(200);
      expect(await orderCount(quote)).toBe(0);
    });

    it('a failed order is waited for while its money is on its way back, then goes', async () => {
      await onSale();
      const failed = await seedWalletOrder({
        status: 'failed',
        lines: [{ tierId: tiers.regular, unit: 7500, quantity: 1 }],
        payment: 'completed',
        hold: 'held',
      });
      const waiting = await put([{ ...REGULAR, name: 'General' }]);
      expect(waiting.status).toBe(409);
      expect((waiting.body as { message: string }).message).toBe(
        'Money for an order that could not be finished is still on its way back to the buyer. Try again in a minute.',
      );
      expect(await orderCount(failed)).toBe(1);

      const hold = await prisma.walletHold.findFirstOrThrow({
        where: { targetId: failed },
      });
      await prisma.walletHold.update({
        where: { id: hold.id },
        data: {
          status: 'refunded',
          action: 'refund',
          settledAt: new Date(),
          actionAt: new Date(),
          refundedKobo: hold.amountKobo,
        },
      });
      const done = await put([{ ...REGULAR, name: 'General' }]);
      expect(done.status).toBe(200);
      expect(await orderCount(failed)).toBe(0);
    });
  });

  describe('EVENTS-11: retired tiers beside wallet orders', () => {
    it('a tier an open Flutterwave checkout points at is retired, not deleted, and the wallet quotes on the other tier still go', async () => {
      await onSale();
      const checkout = await seedOpenCheckout(tiers.regular, 7500);
      const quote = await seedWalletOrder({
        status: 'pending',
        lines: [{ tierId: tiers.vip, unit: 20000, quantity: 1 }],
      });
      const res = await put([
        { ...REGULAR, priceNaira: 6000 },
        { ...VIP, priceNaira: 25000 },
      ]);
      expect(res.status).toBe(200);
      // The checkout keeps its row; its tier is retired at the old price.
      expect(await orderCount(checkout)).toBe(1);
      const rows = await tierRows();
      const old = rows.find((r) => r.id === tiers.regular)!;
      expect(old.retiredAt).not.toBeNull();
      expect(old.priceNaira).toBe(7500);
      // The wallet quote (EVENTS-07) goes with VIP, which nothing else needs.
      expect(await orderCount(quote)).toBe(0);
      expect(rows.some((r) => r.id === tiers.vip)).toBe(false);
      expect(rows.filter((r) => !r.retiredAt).map((r) => r.priceNaira)).toEqual(
        [6000, 25000],
      );
    });

    it('a retired tier cannot be bought again from the wallet, alone or in a basket', async () => {
      await onSale();
      await seedOpenCheckout(tiers.regular, 7500);
      expect((await put([{ ...REGULAR, priceNaira: 6000 }, VIP])).status).toBe(
        200,
      );
      // Back on sale, as an admin approval would leave it.
      await prisma.event.update({
        where: { id: EV },
        data: { status: 'published' },
      });
      const fresh = (await tierRows()).filter((r) => !r.retiredAt);
      expect(fresh).toHaveLength(2);

      const buyer = randomUUID();
      for (const lines of [
        [{ ticketTypeId: tiers.regular, quantity: 1 }],
        [
          {
            ticketTypeId: fresh.find((r) => r.tier === 'vip')!.id,
            quantity: 1,
          },
          { ticketTypeId: tiers.regular, quantity: 1 },
        ],
      ]) {
        let caught: unknown;
        try {
          await wallet.create(buyer, EV, { lines });
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(MoneyError);
        expect((caught as MoneyError).message).toBe(TIER_CHANGED);
        expect((caught as MoneyError).code).toBe('target_not_payable');
        expect((caught as MoneyError).getStatus()).toBe(409);
      }
      expect(
        await prisma.eventOrder.count({
          where: { eventId: EV, buyerWawuId: buyer },
        }),
      ).toBe(0);

      // The tiers on sale are bought as before.
      const ok = await wallet.create(buyer, EV, {
        lines: [{ ticketTypeId: fresh[0].id, quantity: 1 }],
      });
      expect(ok).toMatchObject({
        payment: { stub: expect.any(String) as string },
      });
      expect(
        await prisma.eventOrder.count({
          where: { eventId: EV, buyerWawuId: buyer, status: 'pending' },
        }),
      ).toBe(1);
    });

    it(`a wallet quote opened while the tiers are replaced is never a 500 and never written against a tier that is going (${RACE_ROUNDS} rounds)`, async () => {
      const wrong: string[] = [];
      const endings = new Map<string, number>();
      for (let round = 0; round < RACE_ROUNDS; round++) {
        await onSale();
        const buyer = randomUUID();
        const [quote, swap] = await Promise.allSettled([
          wallet.create(buyer, EV, {
            lines: [
              { ticketTypeId: tiers.regular, quantity: 1 },
              { ticketTypeId: tiers.vip, quantity: 1 },
            ],
          }),
          put([{ ...REGULAR, name: 'General', quantity: 50 + round }]),
        ]);
        const quoteOk = quote.status === 'fulfilled';
        const quoteRefusal =
          quote.status === 'rejected' && quote.reason instanceof MoneyError
            ? quote.reason.message
            : null;
        const swapStatus =
          swap.status === 'fulfilled' ? swap.value.status : 'rejected';
        const orders = await prisma.eventOrder.count({
          where: { eventId: EV, buyerWawuId: buyer },
        });
        const rows = await tierRows();
        const key = `quote ${quoteOk ? 'made' : (quoteRefusal ?? 'ERROR')} put ${swapStatus} orders ${orders}`;
        endings.set(key, (endings.get(key) ?? 0) + 1);
        // Whatever the order of the two: the PUT lands (the quote was either
        // not yet made, or went with the tiers), no quote survives on a tier
        // that is gone, and the quote's error is always a plain refusal.
        const good =
          swapStatus === 200 &&
          (quoteOk || quoteRefusal !== null) &&
          orders === 0 &&
          rows.length === 1 &&
          rows[0].name === 'General';
        if (!good) wrong.push(key);
      }

      console.log(
        `wallet quote vs PUT: ${[...endings].map(([k, n]) => `${n} x ${k}`).join(' | ')}`,
      );
      expect(wrong).toEqual([]);
    }, 120_000);
  });
});
