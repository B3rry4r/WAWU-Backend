// Contract tests for task FIX-59: GET /me/purchases/all, My purchases across
// every paid kind (BACKEND_GAPS G-ME-14-1).
//
// Real HTTP against the caller's DATABASE_URL, with real RS256 tokens from
// mock-wawu-id (its port from WAWU_ID_JWKS_URL, else 4001), like every other
// contract spec. The rows are written straight to the tables that own them (a
// wallet payment, its hold, an order, a pack, a place): nothing here asks a
// wallet provider for anything. Everything this spec writes it removes.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/wawu_hub_test?schema=public';

import { ChildProcess, spawn } from 'child_process';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import * as path from 'path';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { NotificationModule } from '../../notification/notification.module';
import { BlockedAccountModule } from '../../blocked-account/blocked-account.module';
import { ContentPieceModule } from '../../content-piece/content-piece.module';
import { MeModule } from '../me.module';
import type { PaidPurchasePage, PaidPurchaseView } from '../me-view.type';

const dataOf = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

// Seeded WAWU IDs and pieces (mock-wawu-id/server.js, prisma/seed.ts).
const PLAIN = '00000000-0000-4000-8000-000000000001';
const BASIC = '00000000-0000-4000-8000-000000000002'; // creator, handle chidi-creates
const PRO = '00000000-0000-4000-8000-000000000003';
const CAC_COURSE = '10000000-0000-4000-8000-000000000001'; // PRO's, PLAIN bought it (₦5,000)
const MAKEUP_VIDEO = '10000000-0000-4000-8000-000000000002'; // BASIC's
const INVOICE_TEMPLATE = '10000000-0000-4000-8000-000000000003'; // PRO's

// Rows this spec makes and removes.
const MARK = 'fix59-';
const EVENT_ID = 'f5900000-0000-4000-8000-0000000000e1';
const TICKET_TYPE_ID = 'f5900000-0000-4000-8000-0000000000a1';
const SCHOOL_ID = 'f5900000-0000-4000-8000-0000000000b1';
const EVENT_NAME = 'FIX59 Lagos Meetup';

/** Minute `n` of a day far after the seeded rows, so the test rows sort first. */
const T = (n: number): Date => new Date(Date.UTC(2031, 0, 1, 0, n, 0));

const MOCK_WAWU_ID_PORT = process.env.WAWU_ID_JWKS_URL
  ? new URL(process.env.WAWU_ID_JWKS_URL).port
  : '4001';
const MOCK_WAWU_ID_BASE = `http://localhost:${MOCK_WAWU_ID_PORT}`;

async function waitForHealth(url: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function login(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) throw new Error(`mock-wawu-id login failed for ${identifier}`);
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('FIX-59: My purchases across every paid kind (contract)', () => {
  let moduleRef: TestingModule;
  let app: INestApplication;
  let prisma: PrismaService;
  let mockWawuId: ChildProcess | undefined;
  let plain: string;
  let basic: string;

  const http = () => request(app.getHttpServer() as Server);
  const get = (token: string, url: string) =>
    http().get(url).set('Authorization', `Bearer ${token}`);
  const all = async (token: string, query = ''): Promise<PaidPurchaseView[]> =>
    dataOf<PaidPurchasePage>(
      await get(token, `/me/purchases/all?limit=50${query}`).expect(200),
    ).items;

  let seq = 0;
  /** What the default read answered before any other kind was bought. */
  let defaultBefore = '';

  type HoldState = 'refunded' | 'released' | 'refunding' | 'held';

  /** A wallet payment row, and its hold when the state names one. Returns the payment's id. */
  async function payment(o: {
    payer: string;
    kind: string;
    targetId: string;
    title: string;
    priceKobo: number;
    feeKobo?: number;
    at: Date;
    status?: 'completed' | 'pending' | 'failed';
    hold?: HoldState;
    payee?: string;
  }): Promise<string> {
    const id = randomUUID();
    const fee = BigInt(o.feeKobo ?? 4000);
    const price = BigInt(o.priceKobo);
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: o.payer,
        kind: o.kind,
        targetId: o.targetId,
        title: o.title,
        payeeWawuUserId: o.payee ?? null,
        priceKobo: price,
        providerFeeKobo: fee,
        wawuFeeKobo: 0n,
        totalKobo: price + fee,
        payeeShareKobo: (price * 85n) / 100n,
        wawuShareKobo: price - (price * 85n) / 100n,
        customerReference: `${MARK}${id}`,
        merchantAccountNumber: '0000000000',
        provider: 'nuvion',
        status: o.status ?? 'completed',
        completedAt: o.status === 'pending' ? null : o.at,
        createdAt: o.at,
      },
    });
    if (o.hold) {
      const refund = o.hold === 'refunded' || o.hold === 'refunding';
      await prisma.walletHold.create({
        data: {
          paymentId: id,
          payerWawuUserId: o.payer,
          kind: o.kind,
          targetId: o.targetId,
          title: o.title,
          releaseCondition: 'test',
          amountKobo: price,
          payeeShareKobo: 0n,
          wawuShareKobo: price,
          merchantAccountNumber: '0000000000',
          provider: 'nuvion',
          status:
            o.hold === 'refunded'
              ? 'refunded'
              : o.hold === 'released'
                ? 'released'
                : 'held',
          action: refund ? 'refund' : o.hold === 'released' ? 'release' : null,
          heldAt: o.at,
          settledAt:
            o.hold === 'refunded' || o.hold === 'released' ? o.at : null,
          refundedKobo: o.hold === 'refunded' ? price : null,
        },
      });
    }
    return id;
  }

  async function order(o: {
    buyer: string;
    at: Date;
    status: 'paid' | 'refunded' | 'failed' | 'pending';
    amountNaira: number;
    walletPaymentId?: string;
  }): Promise<string> {
    seq += 1;
    const created = await prisma.eventOrder.create({
      data: {
        eventId: EVENT_ID,
        ticketTypeId: TICKET_TYPE_ID,
        buyerWawuId: o.buyer,
        quantity: 1,
        amountNaira: o.amountNaira,
        commissionRate: 0.15,
        status: o.status,
        flutterwaveTxRef: `${MARK}order-${seq}`,
        walletPaymentId: o.walletPaymentId ?? null,
        paymentProvider: o.walletPaymentId ? 'wallet' : null,
        paidAt: o.at,
        createdAt: o.at,
      },
    });
    return created.id;
  }

  async function pack(o: {
    user: string;
    at: Date;
    pack: 'starter' | 'popular' | 'pro';
    credits: number;
    amountNaira: number;
    status: 'completed' | 'pending';
    walletPaymentId?: string;
  }): Promise<string> {
    seq += 1;
    const created = await prisma.creditPurchase.create({
      data: {
        userWawuId: o.user,
        pack: o.pack,
        creditsGranted: o.credits,
        flutterwaveTxRef: `${MARK}pack-${seq}`,
        amount: o.amountNaira,
        status: o.status,
        purchasedAt: o.at,
        walletPaymentId: o.walletPaymentId ?? null,
      },
    });
    return created.id;
  }

  async function cleanUp(): Promise<void> {
    const payments = await prisma.walletPayment.findMany({
      where: { customerReference: { startsWith: MARK } },
      select: { id: true },
    });
    const ids = payments.map((p) => p.id);
    await prisma.purchase.deleteMany({
      where: {
        OR: [
          { flutterwaveTxRef: { startsWith: MARK } },
          { flutterwaveTxRef: { in: ids.map((id) => `wallet:${id}`) } },
        ],
      },
    });
    await prisma.eventOrder.deleteMany({
      where: { flutterwaveTxRef: { startsWith: MARK } },
    });
    await prisma.event.deleteMany({ where: { id: EVENT_ID } });
    await prisma.creditPurchase.deleteMany({
      where: { flutterwaveTxRef: { startsWith: MARK } },
    });
    await prisma.schoolEnrolment.deleteMany({
      where: { reference: { startsWith: MARK } },
    });
    await prisma.school.deleteMany({ where: { id: SCHOOL_ID } });
    await prisma.walletHold.deleteMany({ where: { paymentId: { in: ids } } });
    await prisma.walletPayment.deleteMany({ where: { id: { in: ids } } });
  }

  beforeAll(async () => {
    if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`, 1000))) {
      mockWawuId = spawn('node', ['server.js'], {
        cwd: path.join(__dirname, '../../../mock-wawu-id'),
        env: { ...process.env, MOCK_WAWU_ID_PORT },
        stdio: 'ignore',
      });
      if (!(await waitForHealth(`${MOCK_WAWU_ID_BASE}/health`))) {
        throw new Error('mock-wawu-id did not become healthy in time');
      }
    }
    plain = await login('user@test.wawu.dev');
    basic = await login('creator-basic@test.wawu.dev');

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        NotificationModule,
        BlockedAccountModule,
        ContentPieceModule,
        MeModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
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
    prisma = moduleRef.get(PrismaService);
    await cleanUp();

    // What the old read says while PLAIN has bought one piece and nothing else.
    defaultBefore = JSON.stringify(
      (await get(plain, '/me/purchases').expect(200)).body,
    );

    await prisma.event.create({
      data: {
        id: EVENT_ID,
        hostWawuId: BASIC,
        name: EVENT_NAME,
        description: 'A meetup.',
        hostOrg: 'Chidi Creates',
        format: 'in_person',
        type: 'meetup',
        startsAt: new Date('2032-10-04T15:00:00.000Z'),
        location: 'Lagos',
        status: 'published',
        ticketTypes: {
          create: [
            {
              id: TICKET_TYPE_ID,
              tier: 'regular',
              name: 'Regular',
              priceNaira: 1000,
              quantity: 100,
            },
          ],
        },
      },
    });
    await prisma.school.create({
      data: {
        id: SCHOOL_ID,
        name: 'FIX59 School',
        category: 'creative',
        location: 'Lagos',
        about: 'A school.',
        reportEmail: 'fix59@test.wawu.dev',
        courses: {
          create: [
            {
              id: 'f5900000-0000-4000-8000-0000000000b2',
              title: 'FIX59 Course',
              weeks: 4,
              mode: 'online',
              syllabus: [],
              outcomes: [],
              priceKobo: 5000000,
              intakes: {
                create: [
                  {
                    id: 'f5900000-0000-4000-8000-0000000000b3',
                    startDate: new Date('2032-01-10'),
                    schedule: 'Saturdays',
                    capacity: 10,
                  },
                ],
              },
            },
          ],
        },
      },
    });
  }, 60000);

  afterAll(async () => {
    await cleanUp();
    await app?.close();
    mockWawuId?.kill();
  });

  /** A place for a school fee; `status` is what the place itself says. */
  async function place(id: string, status: 'enrolled' | 'refunded') {
    await prisma.schoolEnrolment.create({
      data: {
        id,
        wawuUserId: PLAIN,
        schoolId: SCHOOL_ID,
        courseId: 'f5900000-0000-4000-8000-0000000000b2',
        intakeId: 'f5900000-0000-4000-8000-0000000000b3',
        status,
        reference: `${MARK}${id}`,
        courseTitle: 'FIX59 Course',
        schoolName: 'FIX59 School',
        intakeStartDate: new Date('2032-01-10'),
        intakeSchedule: 'Saturdays',
        priceKobo: 5000000,
        schoolShareKobo: 4250000,
        wawuShareKobo: 750000,
        commissionBps: 1500,
        reservedUntil: T(0),
      },
    });
  }

  // -------------------------------------------------------------------------
  it('needs a signed-in caller', async () => {
    await http().get('/me/purchases/all').expect(401);
  });

  // -------------------------------------------------------------------------
  describe('the rows', () => {
    const SCHOOL_A = randomUUID(); // paid back (the hold says so)
    const SCHOOL_B = randomUUID(); // refund on its way, the place says refunded
    const SCHOOL_C = randomUUID(); // refund on its way, nothing says so yet
    const SCHOOL_D = randomUUID(); // released to the school
    const ROOM = randomUUID();
    let walletUnlockPayment = '';
    let walletOrder = '';
    let walletPack = '';

    beforeAll(async () => {
      // BASIC's own purchases: never in PLAIN's list.
      await payment({
        payer: BASIC,
        kind: 'school_fee',
        targetId: randomUUID(),
        title: 'BASIC School Fee',
        priceKobo: 100000,
        at: T(23),
      });
      await order({
        buyer: BASIC,
        at: T(22),
        status: 'paid',
        amountNaira: 700,
      });
      await pack({
        user: BASIC,
        at: T(24),
        pack: 'starter',
        credits: 50,
        amountNaira: 500,
        status: 'completed',
      });

      // PLAIN: three rows at one instant (paging has to break the tie).
      await payment({
        payer: PLAIN,
        kind: 'community_pass',
        targetId: ROOM,
        title: 'FIX59 Room, 30 days',
        priceKobo: 300000,
        at: T(20),
      });
      await payment({
        payer: PLAIN,
        kind: 'school_fee',
        targetId: SCHOOL_D,
        title: 'FIX59 Course B',
        priceKobo: 5000000,
        feeKobo: 5000,
        at: T(20),
        hold: 'released',
      });
      await pack({
        user: PLAIN,
        at: T(20),
        pack: 'starter',
        credits: 50,
        amountNaira: 500,
        status: 'completed',
      });

      await payment({
        payer: PLAIN,
        kind: 'school_fee',
        targetId: SCHOOL_A,
        title: 'FIX59 Course A',
        priceKobo: 4000000,
        at: T(19),
        hold: 'refunded',
      });
      await place(SCHOOL_B, 'refunded');
      await payment({
        payer: PLAIN,
        kind: 'school_fee',
        targetId: SCHOOL_B,
        title: 'FIX59 Course C',
        priceKobo: 3000000,
        at: T(18),
        hold: 'refunding',
      });
      await payment({
        payer: PLAIN,
        kind: 'school_fee',
        targetId: SCHOOL_C,
        title: 'FIX59 Course D',
        priceKobo: 2000000,
        at: T(17),
        hold: 'refunding',
      });
      for (const status of ['pending', 'failed'] as const) {
        await payment({
          payer: PLAIN,
          kind: 'school_fee',
          targetId: randomUUID(),
          title: `FIX59 Course ${status}`,
          priceKobo: 1000000,
          at: T(16),
          status,
        });
      }

      // Credit packs: paid back, by wallet, by card, and one still pending.
      await payment({
        payer: PLAIN,
        kind: 'credit_pack',
        targetId: 'pro',
        title: '300 WAWU Credits',
        priceKobo: 200000,
        at: T(14),
        hold: 'refunded',
      });
      walletPack = await payment({
        payer: PLAIN,
        kind: 'credit_pack',
        targetId: 'popular',
        title: '120 WAWU Credits',
        priceKobo: 100000,
        at: T(13),
      });
      await pack({
        user: PLAIN,
        at: T(13),
        pack: 'popular',
        credits: 120,
        amountNaira: 1000,
        status: 'completed',
        walletPaymentId: walletPack,
      });
      await pack({
        user: PLAIN,
        at: T(12),
        pack: 'starter',
        credits: 50,
        amountNaira: 500,
        status: 'completed',
      });
      await pack({
        user: PLAIN,
        at: T(11),
        pack: 'pro',
        credits: 300,
        amountNaira: 2000,
        status: 'pending',
      });

      // Tickets: failed after the money moved and paid back, paid by wallet
      // (the payment's figure differs from the order's on purpose), refunded
      // by card, paid by card, free, and not yet paid.
      const failedPayment = await payment({
        payer: PLAIN,
        kind: 'event_ticket',
        targetId: randomUUID(),
        title: EVENT_NAME,
        priceKobo: 100000,
        at: T(10),
        hold: 'refunded',
      });
      await order({
        buyer: PLAIN,
        at: T(10),
        status: 'failed',
        amountNaira: 1000,
        walletPaymentId: failedPayment,
      });
      const paidPayment = await payment({
        payer: PLAIN,
        kind: 'event_ticket',
        targetId: randomUUID(),
        title: EVENT_NAME,
        priceKobo: 260000,
        feeKobo: 4500,
        at: T(9),
        hold: 'held',
      });
      walletOrder = await order({
        buyer: PLAIN,
        at: T(9),
        status: 'paid',
        amountNaira: 2500,
        walletPaymentId: paidPayment,
      });
      await order({
        buyer: PLAIN,
        at: T(8),
        status: 'refunded',
        amountNaira: 1500,
      });
      await order({
        buyer: PLAIN,
        at: T(7),
        status: 'paid',
        amountNaira: 1000,
      });
      await order({ buyer: PLAIN, at: T(6), status: 'paid', amountNaira: 0 });
      await order({
        buyer: PLAIN,
        at: T(5),
        status: 'pending',
        amountNaira: 1000,
      });

      // A wallet unlock that could not be delivered and was paid back (no
      // Purchase was ever written for it).
      await payment({
        payer: PLAIN,
        kind: 'content_unlock',
        targetId: MAKEUP_VIDEO,
        title: 'SEEDED: 10-Minute Owambe Makeup',
        priceKobo: 80000,
        at: T(4),
        hold: 'refunded',
        payee: BASIC,
      });
    });

    it('the old read answers exactly as before while other kinds are bought', async () => {
      const res = await get(plain, '/me/purchases').expect(200);
      expect(JSON.stringify(res.body)).toBe(defaultBefore);
      const items = dataOf<{ items: { content: { id: string } }[] }>(res).items;
      expect(items.map((i) => i.content.id)).toEqual([CAC_COURSE]);
    });

    it('lists each purchase once, newest first, with the figures the payment recorded', async () => {
      // A wallet unlock that was delivered: the Purchase and its payment are
      // one purchase, never two.
      walletUnlockPayment = await payment({
        payer: PLAIN,
        kind: 'content_unlock',
        targetId: INVOICE_TEMPLATE,
        title: 'SEEDED: Invoice Template Pack',
        priceKobo: 150000,
        feeKobo: 4000,
        at: T(3),
      });
      await prisma.purchase.create({
        data: {
          contentId: INVOICE_TEMPLATE,
          type: 'content',
          buyerWawuId: PLAIN,
          creatorWawuId: PRO,
          amount: 1500,
          commissionRate: 0.15,
          flutterwaveTxRef: `wallet:${walletUnlockPayment}`,
          status: 'completed',
          purchasedAt: T(3),
        },
      });
      await prisma.purchase.create({
        data: {
          contentId: INVOICE_TEMPLATE,
          type: 'content',
          buyerWawuId: PLAIN,
          creatorWawuId: PRO,
          amount: 1500,
          commissionRate: 0.15,
          flutterwaveTxRef: `${MARK}pending`,
          status: 'pending',
          purchasedAt: T(2),
        },
      });

      const items = await all(plain);
      // Time never goes up the list.
      const times = items.map((i) => Date.parse(i.purchasedAt));
      expect(times).toEqual([...times].sort((a, b) => b - a));
      // Ties are only the three rows at minute 20.
      expect(items.slice(0, 3).map((i) => i.purchasedAt)).toEqual(
        Array(3).fill(T(20).toISOString()),
      );
      expect(
        items
          .slice(0, 3)
          .map((i) => i.kind)
          .sort(),
      ).toEqual(['community_pass', 'credit_pack', 'school_fee']);

      const rest = items.slice(3).map((i) => [i.kind, i.status, i.amountKobo]);
      expect(rest).toEqual([
        ['school_fee', 'refunded', 4000000], // the hold says paid back
        ['school_fee', 'refunded', 3000000], // the place says refunded
        // minute 17 (refund on its way, nothing says so), 16 (pending, failed): not listed
        ['credit_pack', 'refunded', 200000],
        ['credit_pack', 'paid', 100000], // the wallet pack: the payment's price
        ['credit_pack', 'paid', 50000], // the card pack: the stored charge
        ['event_ticket', 'refunded', 100000],
        ['event_ticket', 'paid', 260000], // the payment's price, not 2,500 x 100
        ['event_ticket', 'refunded', 150000],
        ['event_ticket', 'paid', 100000],
        ['content_unlock', 'refunded', 80000],
        ['content_unlock', 'paid', 150000],
        ['content_unlock', 'paid', 500000], // the seeded card purchase
      ]);

      // Each purchase id appears once.
      expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
      expect(items).toHaveLength(15);
    });

    it('shows what each kind opens, its totals and its counts', async () => {
      const items = await all(plain);
      const by = (kind: string, amountKobo: number) =>
        items.find((i) => i.kind === kind && i.amountKobo === amountKobo)!;

      // Wallet payments carry the total that left the wallet; a card charge has none.
      expect(by('event_ticket', 260000)).toMatchObject({
        title: EVENT_NAME,
        totalKobo: 264500,
        openId: walletOrder,
        content: null,
        lessons: null,
        credits: null,
      });
      expect(by('event_ticket', 100000).openId).toBeTruthy();
      expect(by('credit_pack', 50000)).toMatchObject({
        title: '50 WAWU Credits',
        totalKobo: null,
        openId: null,
        credits: 50,
      });
      expect(by('credit_pack', 100000)).toMatchObject({
        title: '120 WAWU Credits',
        totalKobo: 104000,
        credits: 120,
      });
      // A pack paid back names its credits from the pack it was.
      expect(by('credit_pack', 200000)).toMatchObject({
        status: 'refunded',
        credits: 300,
      });
      expect(by('school_fee', 5000000)).toMatchObject({
        title: 'FIX59 Course B',
        status: 'paid',
        totalKobo: 5005000,
        openId: SCHOOL_D,
      });
      expect(by('community_pass', 300000)).toMatchObject({
        title: 'FIX59 Room, 30 days',
        status: 'paid',
        openId: ROOM,
      });

      // Pieces carry what M29 draws; a course carries its progress.
      const unlock = by('content_unlock', 150000);
      expect(unlock).toMatchObject({
        title: 'SEEDED: Invoice Template Pack',
        totalKobo: 154000,
        openId: INVOICE_TEMPLATE,
        lessons: null,
      });
      expect(unlock.content).toMatchObject({
        id: INVOICE_TEMPLATE,
        contentType: 'template',
      });
      expect(unlock.content!.creator.wawuId).toBe(PRO);
      const course = by('content_unlock', 500000);
      expect(course).toMatchObject({
        openId: CAC_COURSE,
        totalKobo: null,
        lessons: { total: 2, done: 0 },
      });
      expect(course.content).toMatchObject({
        id: CAC_COURSE,
        contentType: 'course',
      });
      const back = by('content_unlock', 80000);
      expect(back).toMatchObject({ status: 'refunded', openId: MAKEUP_VIDEO });
      expect(back.content!.creator.wawuId).toBe(BASIC);
    });

    it('is only the caller’s own', async () => {
      const mine = await all(plain);
      const theirs = await all(basic);
      expect(theirs.map((i) => [i.kind, i.amountKobo]).sort()).toEqual([
        ['credit_pack', 50000],
        ['event_ticket', 70000],
        ['school_fee', 100000],
      ]);
      const mineIds = new Set(mine.map((i) => i.id));
      expect(theirs.every((i) => !mineIds.has(i.id))).toBe(true);
      expect(mine.some((i) => i.title === 'BASIC School Fee')).toBe(false);
    });

    it('pages without a repeat or a gap, ties included', async () => {
      const whole = (await all(plain)).map((i) => i.id);
      for (const size of [1, 2, 4, 7, whole.length]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const res = await get(
            plain,
            `/me/purchases/all?limit=${size}${cursor ? `&cursor=${cursor}` : ''}`,
          ).expect(200);
          const page = dataOf<PaidPurchasePage>(res);
          expect(page.items.length).toBeLessThanOrEqual(size);
          seen.push(...page.items.map((i) => i.id));
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor && pages < 50);
        expect(seen).toEqual(whole);
      }
      // A last page that is exactly full carries no cursor.
      const full = dataOf<PaidPurchasePage>(
        await get(plain, `/me/purchases/all?limit=${whole.length}`).expect(200),
      );
      expect(full.nextCursor).toBeNull();
      await get(plain, '/me/purchases/all?cursor=garbage').expect(400);
    });

    it('searches titles (and a piece’s creator), ignoring case and treating % and _ as characters', async () => {
      const titles = async (q: string) =>
        (await all(plain, `&q=${encodeURIComponent(q)}`)).map((i) => i.title);
      expect(await titles('fix59 lagos meetup')).toEqual(
        Array(4).fill(EVENT_NAME),
      );
      expect(await titles('WAWU Credits')).toEqual([
        '50 WAWU Credits',
        '300 WAWU Credits',
        '120 WAWU Credits',
        '50 WAWU Credits',
      ]);
      expect(await titles('Course B')).toEqual(['FIX59 Course B']);
      // BASIC's handle finds the piece of theirs PLAIN was paid back for.
      expect(await titles('chidi')).toEqual([
        'SEEDED: 10-Minute Owambe Makeup',
      ]);
      expect(await titles('%%')).toEqual([]);
      expect(await titles('_x')).toEqual([]);
      expect(await titles('no such purchase')).toEqual([]);
      // Search pages like the list does.
      const first = dataOf<PaidPurchasePage>(
        await get(
          plain,
          `/me/purchases/all?limit=2&q=${encodeURIComponent('WAWU Credits')}`,
        ).expect(200),
      );
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      await get(plain, '/me/purchases/all?q=%20P%20').expect(400);
      await get(plain, `/me/purchases/all?q=${'x'.repeat(61)}`).expect(400);
    });

    it('leaves the old read listing unlocks only, exactly as it did', async () => {
      const old = dataOf<{
        items: { content: { id: string }; purchasedAt: string }[];
        nextCursor: string | null;
      }>(await get(plain, '/me/purchases').expect(200));
      // The delivered wallet unlock is a piece bought, so it is there; nothing else is.
      expect(old.items.map((i) => i.content.id)).toEqual([
        INVOICE_TEMPLATE,
        CAC_COURSE,
      ]);
      expect(Object.keys(old.items[0]).sort()).toEqual([
        'content',
        'id',
        'lessons',
        'purchasedAt',
      ]);
    });
  });
});
