import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { AdminAuthModule } from '../../auth/admin-auth.module';
import { AdminFinanceModule } from '../admin-finance.module';
import {
  FLUTTERWAVE_WALLET_GATEWAY,
  type FlutterwaveWalletGateway,
} from '../../../wallet/flutterwave-wallet.gateway';

/**
 * Contract tests for the admin money surface.
 *
 * ── WHAT THESE PROVE, AND WHY EACH ONE IS HERE ───────────────────────────
 *  1. Every figure is what the rows say. The fixtures are built with amounts
 *     chosen so the expected kobo can be written down by hand, and they are.
 *  2. The stream breakdown adds up to the total it sits under. A breakdown
 *     that disagrees with its own total is the specific way a money screen
 *     lies without looking wrong.
 *  3. Pending, failed and refunded charges contribute NOTHING to the summary.
 *     A fixture of each exists precisely so their absence is asserted rather
 *     than assumed, and they are still visible on the ledger, which is the
 *     screen for "where did this charge go".
 *  4. The period filter bounds every figure, and defaults to this calendar
 *     month when neither bound is given.
 *  5. The balance comes from FLUTTERWAVE and cannot be a sum of rows. The
 *     gateway is overridden with one that returns a number no ledger sum in
 *     this fixture set could ever produce, and the response has to show that
 *     number.
 *  6. A non-finance admin role is refused, on every route.
 *  7. A WAWU ID user token - the token a creator actually holds - cannot
 *     reach another creator's wallet, or any of this.
 *  8. Every route is a GET. Asserted directly, because "read-only" that is
 *     only a convention is not read-only.
 *
 * Fixtures live under this suite's own `fa……` id prefix, inside a period no
 * other data occupies (May 2031), and are swept in afterAll (README § Test
 * hygiene). No seeded row is mutated.
 */

const MOCK_WAWU_ID_URL =
  process.env.WAWU_ID_BASE_URL ?? 'http://localhost:4001';

/** Seeded plain (non-creator) WAWU ID user. mock-wawu-id keys its login on the email. */
const USER_PLAIN_EMAIL = 'user@test.wawu.dev';
/** Seeded creator. The token a real creator holds, used to prove it reaches none of this. */
const USER_CREATOR_EMAIL = 'creator-pro@test.wawu.dev';

// ── admin fixtures ──────────────────────────────────────────────────────────
const ADMIN_SUPER_ID = 'fa000000-0000-4000-8000-000000000001';
const ADMIN_FINANCE_ID = 'fa000000-0000-4000-8000-000000000002';
const ADMIN_SUPPORT_ID = 'fa000000-0000-4000-8000-000000000003';
const ADMIN_REVIEWER_ID = 'fa000000-0000-4000-8000-000000000004';
const ADMIN_IDS = [
  ADMIN_SUPER_ID,
  ADMIN_FINANCE_ID,
  ADMIN_SUPPORT_ID,
  ADMIN_REVIEWER_ID,
];

const SUPER_EMAIL = 'finance-super@admin.test.wawu.dev';
const FINANCE_EMAIL = 'finance-finance@admin.test.wawu.dev';
const SUPPORT_EMAIL = 'finance-support@admin.test.wawu.dev';
const REVIEWER_EMAIL = 'finance-reviewer@admin.test.wawu.dev';
const PASSWORD = 'admin-finance-contract-password';

const TEST_ACCESS_SECRET = 'admin-finance-access-secret-0123456789abc';
const TEST_REFRESH_SECRET = 'admin-finance-refresh-secret-0123456789abc';

// ── money fixtures ──────────────────────────────────────────────────────────
const CREATOR_A = 'fa000000-0000-4000-8000-0000000000a1';
const CREATOR_B = 'fa000000-0000-4000-8000-0000000000a2';
const BUYER = 'fa000000-0000-4000-8000-0000000000b1';
const PEOPLE = [CREATOR_A, CREATOR_B, BUYER];

const EVENT_ID = 'fa000000-0000-4000-8000-0000000000e1';
const TICKET_TYPE_ID = 'fa000000-0000-4000-8000-0000000000e2';

/** A window nothing else in this database occupies, so every total is exactly the fixtures. */
const FROM = '2031-05-01T00:00:00.000Z';
const TO = '2031-06-01T00:00:00.000Z';
const AT = (day: number) =>
  new Date(`2031-05-${String(day).padStart(2, '0')}T12:00:00.000Z`);

/** Every tx_ref this suite owns. The prefix scopes the teardown. */
const TX = 'afi-';

/**
 * A balance no sum of these fixtures could produce.
 *
 * CREATOR_A's ledger sums to ₦8,500 earned and ₦2,000 withdrawn. If the wallet
 * endpoint ever starts computing a balance instead of asking Flutterwave for
 * one, it cannot accidentally still equal this.
 */
const FLUTTERWAVE_SAYS = 4242;

class BalanceStubGateway implements Partial<FlutterwaveWalletGateway> {
  balance(accountReference: string): Promise<{ availableNgn: number }> {
    return Promise.resolve({
      availableNgn:
        accountReference === 'PSA-AFI-CREATOR-A' ? FLUTTERWAVE_SAYS : 0,
    });
  }
}

async function loginToWawuId(identifier: string): Promise<string> {
  const res = await fetch(`${MOCK_WAWU_ID_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  if (!res.ok) {
    throw new Error(
      `mock-wawu-id login failed for ${identifier}: ${res.status}`,
    );
  }
  return ((await res.json()) as { accessToken: string }).accessToken;
}

describe('Admin finance contract', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let superToken: string;
  let financeToken: string;
  let supportToken: string;
  let reviewerToken: string;
  let userToken: string;
  let creatorToken: string;

  const envSnapshot: Record<string, string | undefined> = {};

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function adminLogin(email: string): Promise<string> {
    const res = await http()
      .post('/api/hub/admin/auth/login')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body.data.accessToken as string;
  }

  async function sweepFixtures(): Promise<void> {
    await prisma.walletWithdrawal.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.walletLedgerEntry.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.creatorWallet.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.purchase.deleteMany({
      where: { flutterwaveTxRef: { startsWith: TX } },
    });
    await prisma.directMessage.deleteMany({
      where: { flutterwaveTxRef: { startsWith: TX } },
    });
    await prisma.creditPurchase.deleteMany({
      where: { flutterwaveTxRef: { startsWith: TX } },
    });
    await prisma.verificationPurchase.deleteMany({
      where: { flutterwaveTxRef: { startsWith: TX } },
    });
    await prisma.eventOrder.deleteMany({
      where: { flutterwaveTxRef: { startsWith: TX } },
    });
    await prisma.eventTicketType.deleteMany({ where: { id: TICKET_TYPE_ID } });
    await prisma.event.deleteMany({ where: { id: EVENT_ID } });
    await prisma.shopOrder.deleteMany({
      where: { flutterwaveTxRef: { startsWith: TX } },
    });
    await prisma.creatorState.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: PEOPLE } },
    });
  }

  /**
   * The whole fixture set, with the money written out so the assertions can be
   * read against it:
   *
   *   content unlock   ₦10,000 completed   -> 1,000,000 kobo, 850,000 creator
   *   content unlock    ₦5,000 pending     -> counted as nothing
   *   content unlock    ₦7,000 failed      -> counted as nothing
   *   tip               ₦2,000 completed   ->   200,000 kobo, 170,000 creator
   *   paid DM           ₦3,000 responded   ->   300,000 kobo, 255,000 creator
   *   paid DM           ₦1,000 refunded    -> counted as nothing
   *   credits           ₦2,000 completed   ->   200,000 kobo, 170,000 creator
   *   verification     ₦15,000 completed   -> 1,500,000 kobo,       0 creator
   *   event tickets     ₦4,000 paid        ->   400,000 kobo, 340,000 creator
   *   shop              ₦6,000 paid        ->   600,000 kobo,       0 creator
   *                                          ─────────────────────────────────
   *   settled gross 4,200,000  creator 1,785,000  WAWU 2,415,000  count 7
   */
  async function seedFixtures(): Promise<void> {
    await prisma.userProfile.createMany({
      data: [
        {
          wawuUserId: CREATOR_A,
          accountType: 'creator',
          handle: 'afi-creator-a',
        },
        {
          wawuUserId: CREATOR_B,
          accountType: 'creator',
          handle: 'afi-creator-b',
        },
        { wawuUserId: BUYER, accountType: 'user', handle: 'afi-buyer' },
      ],
    });
    await prisma.creatorState.createMany({
      data: [
        { wawuUserId: CREATOR_A, kycStatus: 'approved' },
        { wawuUserId: CREATOR_B, kycStatus: 'pending' },
      ],
    });

    await prisma.purchase.createMany({
      data: [
        {
          type: 'content',
          buyerWawuId: BUYER,
          creatorWawuId: CREATOR_A,
          amount: 10_000,
          commissionRate: 0.15,
          flutterwaveTxRef: `${TX}content-completed`,
          flutterwaveTxId: 'flw-afi-1',
          status: 'completed',
          purchasedAt: AT(2),
        },
        {
          type: 'content',
          buyerWawuId: BUYER,
          creatorWawuId: CREATOR_A,
          amount: 5_000,
          commissionRate: 0.15,
          flutterwaveTxRef: `${TX}content-pending`,
          status: 'pending',
          purchasedAt: AT(3),
        },
        {
          type: 'content',
          buyerWawuId: BUYER,
          creatorWawuId: CREATOR_A,
          amount: 7_000,
          commissionRate: 0.15,
          flutterwaveTxRef: `${TX}content-failed`,
          status: 'failed',
          purchasedAt: AT(4),
        },
        {
          type: 'tip',
          buyerWawuId: BUYER,
          creatorWawuId: CREATOR_A,
          amount: 2_000,
          commissionRate: 0.15,
          flutterwaveTxRef: `${TX}tip-completed`,
          status: 'completed',
          purchasedAt: AT(5),
        },
      ],
    });

    await prisma.directMessage.createMany({
      data: [
        {
          creatorWawuId: CREATOR_A,
          senderWawuId: BUYER,
          text: 'A paid message that was answered.',
          amount: 3_000,
          status: 'responded',
          sentAt: AT(6),
          deadlineAt: AT(7),
          respondedAt: AT(6),
          flutterwaveTxRef: `${TX}dm-responded`,
          flutterwaveTxId: 'flw-afi-dm-1',
        },
        {
          creatorWawuId: CREATOR_A,
          senderWawuId: BUYER,
          text: 'A paid message that expired and went back.',
          amount: 1_000,
          status: 'refunded',
          sentAt: AT(7),
          deadlineAt: AT(8),
          flutterwaveTxRef: `${TX}dm-refunded`,
        },
      ],
    });

    await prisma.creditPurchase.create({
      data: {
        userWawuId: BUYER,
        pack: 'pro',
        creditsGranted: 300,
        amount: 2_000,
        status: 'completed',
        flutterwaveTxRef: `${TX}credits`,
        purchasedAt: AT(8),
      },
    });

    await prisma.verificationPurchase.create({
      data: {
        wawuUserId: CREATOR_A,
        kind: 'creator',
        priceNgn: 15_000,
        status: 'completed',
        flutterwaveTxRef: `${TX}verification`,
        flutterwaveTxId: 'flw-afi-v-1',
        createdAt: AT(9),
        settledAt: AT(9),
      },
    });

    await prisma.event.create({
      data: {
        id: EVENT_ID,
        hostWawuId: CREATOR_B,
        name: 'Finance fixture summit',
        description: 'Exists so a ticket order has an organiser to pay.',
        hostOrg: 'AFI Fixtures',
        format: 'in_person',
        type: 'summit',
        startsAt: AT(20),
        location: 'Lagos',
        status: 'published',
      },
    });
    await prisma.eventTicketType.create({
      data: {
        id: TICKET_TYPE_ID,
        eventId: EVENT_ID,
        tier: 'regular',
        name: 'Regular',
        priceNaira: 2_000,
        quantity: 100,
        sold: 2,
      },
    });
    await prisma.eventOrder.create({
      data: {
        eventId: EVENT_ID,
        ticketTypeId: TICKET_TYPE_ID,
        buyerWawuId: BUYER,
        quantity: 2,
        amountNaira: 4_000,
        commissionRate: 0.15,
        status: 'paid',
        flutterwaveTxRef: `${TX}event`,
        flutterwaveTxId: 'flw-afi-e-1',
        createdAt: AT(10),
      },
    });

    await prisma.shopOrder.create({
      data: {
        buyerWawuId: BUYER,
        status: 'paid',
        subtotalNaira: 6_000,
        totalNaira: 6_000,
        deliveryName: 'Ada Okeke',
        deliveryPhone: '08030000000',
        deliveryAddress: '1 Fixture Road',
        deliveryCity: 'Lagos',
        deliveryState: 'Lagos',
        flutterwaveTxRef: `${TX}shop`,
        createdAt: AT(11),
        paidAt: AT(11),
      },
    });

    // ── the wallet side ────────────────────────────────────────────────────
    await prisma.creatorWallet.create({
      data: {
        wawuUserId: CREATOR_A,
        accountReference: 'PSA-AFI-CREATOR-A',
        barterId: 'barter-afi-creator-a',
        nuban: '9012345678',
        bankName: 'Flutterwave MFB',
        bankCode: '090567',
        status: 'active',
      },
    });
    const earning = await prisma.walletLedgerEntry.create({
      data: {
        wawuUserId: CREATOR_A,
        kind: 'earning',
        amount: 8_500,
        status: 'completed',
        reference: `${TX}earning-1`,
        sourceType: 'purchase',
        sourceId: 'afi-source-1',
        createdAt: AT(12),
        settledAt: AT(12),
      },
    });
    await prisma.walletLedgerEntry.create({
      data: {
        wawuUserId: CREATOR_A,
        kind: 'earning',
        amount: 1_700,
        status: 'pending',
        reference: `${TX}earning-2`,
        sourceType: 'purchase',
        sourceId: 'afi-source-2',
        createdAt: AT(13),
      },
    });
    const withdrawal = await prisma.walletLedgerEntry.create({
      data: {
        wawuUserId: CREATOR_A,
        kind: 'withdrawal',
        amount: 2_000,
        status: 'completed',
        reference: `${TX}withdrawal-1`,
        transferId: 'flw-transfer-afi-1',
        createdAt: AT(14),
        settledAt: AT(14),
      },
    });
    await prisma.walletWithdrawal.create({
      data: {
        wawuUserId: CREATOR_A,
        entryId: withdrawal.id,
        amount: 2_000,
        bankCode: '058',
        accountNumber: '0123456789',
        accountName: 'ADA OKEKE',
        createdAt: AT(14),
      },
    });
    expect(earning.id).toBeTruthy();
  }

  beforeAll(async () => {
    for (const key of ['ADMIN_JWT_SECRET', 'ADMIN_JWT_REFRESH_SECRET']) {
      envSnapshot[key] = process.env[key];
    }
    process.env.ADMIN_JWT_SECRET = TEST_ACCESS_SECRET;
    process.env.ADMIN_JWT_REFRESH_SECRET = TEST_REFRESH_SECRET;

    userToken = await loginToWawuId(USER_PLAIN_EMAIL);
    creatorToken = await loginToWawuId(USER_CREATOR_EMAIL);

    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        AdminAuthModule,
        AdminFinanceModule,
      ],
    })
      // The balance has to be FLUTTERWAVE'S. This stand-in answers with a
      // number no sum of the fixtures produces, so a response carrying it
      // proves the figure was asked for rather than worked out.
      .overrideProvider(FLUTTERWAVE_WALLET_GATEWAY)
      .useClass(BalanceStubGateway)
      .compile();

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

    prisma = moduleRef.get(PrismaService);

    const argon2 = await import('argon2');
    const passwordHash = await argon2.hash(PASSWORD);
    await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    await prisma.adminUser.createMany({
      data: [
        {
          id: ADMIN_SUPER_ID,
          email: SUPER_EMAIL,
          name: 'Finance Super',
          role: 'superadmin',
          passwordHash,
        },
        {
          id: ADMIN_FINANCE_ID,
          email: FINANCE_EMAIL,
          name: 'Finance Finance',
          role: 'finance',
          passwordHash,
        },
        {
          id: ADMIN_SUPPORT_ID,
          email: SUPPORT_EMAIL,
          name: 'Finance Support',
          role: 'support',
          passwordHash,
        },
        {
          id: ADMIN_REVIEWER_ID,
          email: REVIEWER_EMAIL,
          name: 'Finance Reviewer',
          role: 'reviewer',
          passwordHash,
        },
      ],
    });

    superToken = await adminLogin(SUPER_EMAIL);
    financeToken = await adminLogin(FINANCE_EMAIL);
    supportToken = await adminLogin(SUPPORT_EMAIL);
    reviewerToken = await adminLogin(REVIEWER_EMAIL);

    await sweepFixtures();
    await seedFixtures();
  }, 60000);

  afterAll(async () => {
    if (prisma) {
      await sweepFixtures();
      await prisma.adminUser.deleteMany({ where: { id: { in: ADMIN_IDS } } });
    }
    await app?.close();
    for (const [key, value] of Object.entries(envSnapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // ── GET /admin/finance/summary ────────────────────────────────────────────

  describe('GET /api/hub/admin/finance/summary', () => {
    const summary = (token: string, query: Record<string, unknown> = {}) =>
      http()
        .get('/api/hub/admin/finance/summary')
        .query(query)
        .set(auth(token));

    it('reports every stream, in kobo, for the window asked for', async () => {
      const res = await summary(financeToken, { from: FROM, to: TO }).expect(
        200,
      );

      expect(res.body).toMatchObject({ statusCode: 200, message: 'OK' });
      expect(res.body.data).toMatchObject({
        currency: 'NGN',
        amountsIn: 'kobo',
        period: { from: FROM, to: TO, isDefaultPeriod: false },
      });
      expect(res.body.data.totals).toEqual({
        grossKobo: 4_200_000,
        wawuShareKobo: 2_415_000,
        creatorShareKobo: 1_785_000,
        transactionCount: 7,
      });
    });

    it('breaks the money down by stream, each at its own split', async () => {
      const res = await summary(financeToken, { from: FROM, to: TO }).expect(
        200,
      );
      const byStream = Object.fromEntries(
        res.body.data.streams.map((s: { stream: string }) => [s.stream, s]),
      );

      expect(byStream.content).toMatchObject({
        grossKobo: 1_000_000,
        creatorShareKobo: 850_000,
        wawuShareKobo: 150_000,
        transactionCount: 1,
        creatorSharePct: 85,
        countedStatuses: ['completed'],
      });
      expect(byStream.tips).toMatchObject({
        grossKobo: 200_000,
        creatorShareKobo: 170_000,
        transactionCount: 1,
      });
      expect(byStream.dm).toMatchObject({
        grossKobo: 300_000,
        creatorShareKobo: 255_000,
        transactionCount: 1,
      });
      expect(byStream.credits).toMatchObject({
        grossKobo: 200_000,
        creatorShareKobo: 170_000,
        creatorSharePct: 85,
      });
      // A tick is paid to the platform with no creator on the other side.
      expect(byStream.verification).toMatchObject({
        grossKobo: 1_500_000,
        creatorShareKobo: 0,
        wawuShareKobo: 1_500_000,
        creatorSharePct: 0,
      });
      expect(byStream.events).toMatchObject({
        grossKobo: 400_000,
        creatorShareKobo: 340_000,
      });
      // WAWU's own catalogue: Product carries no seller column.
      expect(byStream.shop).toMatchObject({
        grossKobo: 600_000,
        creatorShareKobo: 0,
        creatorSharePct: 0,
      });
    });

    it('has a breakdown that adds up to its own total', async () => {
      const res = await summary(financeToken, { from: FROM, to: TO }).expect(
        200,
      );
      const { streams, totals } = res.body.data;
      const add = (key: string) =>
        streams.reduce((n: number, s: Record<string, number>) => n + s[key], 0);

      expect(add('grossKobo')).toBe(totals.grossKobo);
      expect(add('wawuShareKobo')).toBe(totals.wawuShareKobo);
      expect(add('creatorShareKobo')).toBe(totals.creatorShareKobo);
      expect(add('transactionCount')).toBe(totals.transactionCount);
      // And the two halves account for the whole of the gross: no kobo
      // invented, none lost.
      expect(totals.wawuShareKobo + totals.creatorShareKobo).toBe(
        totals.grossKobo,
      );
    });

    it('counts no pending, failed or refunded charge as revenue', async () => {
      const res = await summary(financeToken, { from: FROM, to: TO }).expect(
        200,
      );
      const byStream = Object.fromEntries(
        res.body.data.streams.map((s: { stream: string }) => [s.stream, s]),
      );

      // ₦5,000 pending and ₦7,000 failed sit in this window alongside the
      // ₦10,000 that settled. Only the settled one is money.
      expect(byStream.content.grossKobo).toBe(1_000_000);
      expect(byStream.content.transactionCount).toBe(1);
      // ₦1,000 of DM went back to the sender.
      expect(byStream.dm.grossKobo).toBe(300_000);
      expect(byStream.dm.transactionCount).toBe(1);
    });

    it('says which statuses it counted, on every stream', async () => {
      const res = await summary(financeToken, { from: FROM, to: TO }).expect(
        200,
      );
      for (const stream of res.body.data.streams) {
        expect(Array.isArray(stream.countedStatuses)).toBe(true);
        expect(stream.countedStatuses.length).toBeGreaterThan(0);
        expect(typeof stream.source).toBe('string');
      }
      expect(typeof res.body.data.basis).toBe('string');
    });

    it('bounds every figure by the period, and excludes what falls outside it', async () => {
      const res = await summary(financeToken, {
        from: '2031-05-01T00:00:00.000Z',
        to: '2031-05-05T00:00:00.000Z',
      }).expect(200);

      // Only the ₦10,000 content unlock (2 May) settled inside this narrower
      // window; the tip on 5 May is excluded because `to` is exclusive.
      expect(res.body.data.totals).toEqual({
        grossKobo: 1_000_000,
        wawuShareKobo: 150_000,
        creatorShareKobo: 850_000,
        transactionCount: 1,
      });
    });

    it('defaults to the current calendar month when neither bound is given', async () => {
      const res = await summary(financeToken).expect(200);
      const now = new Date();
      const expectedFrom = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      ).toISOString();

      expect(res.body.data.period.isDefaultPeriod).toBe(true);
      expect(res.body.data.period.from).toBe(expectedFrom);
      // May 2031 is not this month, so none of the fixtures are in it.
      expect(res.body.data.period.to > res.body.data.period.from).toBe(true);
    });

    it('reports the credits spend-side attribution separately from the purchase-side gross', async () => {
      const res = await summary(financeToken, { from: FROM, to: TO }).expect(
        200,
      );
      expect(res.body.data.creditsAttribution).toMatchObject({
        creditsSpent: 0,
        creditsFunded: 0,
        hostShareKobo: 0,
      });
      expect(typeof res.body.data.creditsAttribution.note).toBe('string');
    });

    it('refuses a `to` that is before its `from`', async () => {
      await summary(financeToken, { from: TO, to: FROM }).expect(400);
    });
  });

  // ── GET /admin/finance/transactions ───────────────────────────────────────

  describe('GET /api/hub/admin/finance/transactions', () => {
    const ledger = (token: string, query: Record<string, unknown> = {}) =>
      http()
        .get('/api/hub/admin/finance/transactions')
        .query({ from: FROM, to: TO, perPage: 100, ...query })
        .set(auth(token));

    it('returns the standard paginated envelope, newest first', async () => {
      const res = await ledger(financeToken).expect(200);

      expect(res.body.pagination).toMatchObject({
        currentPage: 1,
        perPage: 100,
        total: 10,
      });
      const dates: string[] = res.body.data.map(
        (r: { occurredAt: string }) => r.occurredAt,
      );
      expect([...dates].sort().reverse()).toEqual(dates);
    });

    it('carries every field a ledger screen renders', async () => {
      const res = await ledger(financeToken, {
        stream: 'content',
        status: 'settled',
      }).expect(200);
      expect(res.body.data).toHaveLength(1);

      expect(res.body.data[0]).toEqual({
        id: expect.any(String),
        stream: 'content',
        occurredAt: AT(2).toISOString(),
        creator: { wawuId: CREATOR_A, handle: 'afi-creator-a' },
        buyer: { wawuId: BUYER, handle: 'afi-buyer' },
        grossKobo: 1_000_000,
        wawuShareKobo: 150_000,
        creatorShareKobo: 850_000,
        status: 'settled',
        sourceStatus: 'completed',
        flutterwaveTxRef: `${TX}content-completed`,
        flutterwaveTxId: 'flw-afi-1',
      });
    });

    it('shows the charges that did NOT settle, which the summary leaves out', async () => {
      const res = await ledger(financeToken, {
        status: 'pending,failed,refunded',
      }).expect(200);
      const refs: string[] = res.body.data.map(
        (r: { flutterwaveTxRef: string }) => r.flutterwaveTxRef,
      );
      expect(refs.sort()).toEqual([
        `${TX}content-failed`,
        `${TX}content-pending`,
        `${TX}dm-refunded`,
      ]);
    });

    it('filters by stream, taking a list', async () => {
      const res = await ledger(financeToken, {
        stream: 'credits,verification',
      }).expect(200);
      const streams = new Set(
        res.body.data.map((r: { stream: string }) => r.stream),
      );
      expect([...streams].sort()).toEqual(['credits', 'verification']);
      expect(res.body.pagination.total).toBe(2);
    });

    it('filters by status', async () => {
      const res = await ledger(financeToken, { status: 'settled' }).expect(200);
      expect(res.body.pagination.total).toBe(7);
      for (const row of res.body.data) expect(row.status).toBe('settled');
    });

    it('filters by date range', async () => {
      const res = await ledger(financeToken, {
        from: '2031-05-09T00:00:00.000Z',
        to: '2031-05-12T00:00:00.000Z',
      }).expect(200);
      const streams = res.body.data
        .map((r: { stream: string }) => r.stream)
        .sort();
      expect(streams).toEqual(['events', 'shop', 'verification']);
    });

    it('filters by creator, and drops the streams that have no creator', async () => {
      const res = await ledger(financeToken, {
        creatorWawuId: CREATOR_B,
      }).expect(200);
      expect(res.body.pagination.total).toBe(1);
      expect(res.body.data[0]).toMatchObject({
        stream: 'events',
        creator: { wawuId: CREATOR_B, handle: 'afi-creator-b' },
        grossKobo: 400_000,
        creatorShareKobo: 340_000,
      });
    });

    it('pages, and the page boundary is taken across all streams at once', async () => {
      const first = await ledger(financeToken, { perPage: 4, page: 1 }).expect(
        200,
      );
      const second = await ledger(financeToken, { perPage: 4, page: 2 }).expect(
        200,
      );

      expect(first.body.data).toHaveLength(4);
      expect(second.body.data).toHaveLength(4);
      expect(first.body.pagination).toMatchObject({ total: 10, nextPage: 2 });
      const firstIds = new Set(
        first.body.data.map((r: { id: string }) => r.id),
      );
      for (const row of second.body.data)
        expect(firstIds.has(row.id)).toBe(false);
    });

    it('honours ?sort=oldest', async () => {
      const res = await ledger(financeToken, { sort: 'oldest' }).expect(200);
      const dates: string[] = res.body.data.map(
        (r: { occurredAt: string }) => r.occurredAt,
      );
      expect([...dates].sort()).toEqual(dates);
    });

    it('refuses an unknown stream rather than ignoring the filter', async () => {
      await ledger(financeToken, { stream: 'subscriptions' }).expect(400);
    });
  });

  // ── GET /admin/finance/payouts ────────────────────────────────────────────

  describe('GET /api/hub/admin/finance/payouts', () => {
    const payouts = (token: string, query: Record<string, unknown> = {}) =>
      http()
        .get('/api/hub/admin/finance/payouts')
        .query({ from: FROM, to: TO, ...query })
        .set(auth(token));

    it('lists what has left for a creator bank account, with the account masked', async () => {
      const res = await payouts(financeToken).expect(200);

      expect(res.body.data).toMatchObject({
        currency: 'NGN',
        amountsIn: 'naira',
      });
      expect(res.body.data.withdrawals.total).toBe(1);
      expect(res.body.data.withdrawals.completedNaira).toBe(2_000);
      expect(res.body.data.withdrawals.items[0]).toMatchObject({
        creator: { wawuId: CREATOR_A, handle: 'afi-creator-a' },
        amountNaira: 2_000,
        status: 'completed',
        reference: `${TX}withdrawal-1`,
        transferId: 'flw-transfer-afi-1',
        bankCode: '058',
        accountName: 'ADA OKEKE',
        accountNumberLast4: '6789',
      });
      // The full account number never leaves this backend on this surface.
      expect(JSON.stringify(res.body)).not.toContain('0123456789');
    });

    it('reports what is owed and unpaid, separated by why', async () => {
      const res = await payouts(financeToken).expect(200);
      const owed = res.body.data.owed;

      expect(
        owed.instructedAwaitingConfirmation.amountNaira,
      ).toBeGreaterThanOrEqual(1_700);
      expect(typeof owed.note).toBe('string');

      const byStream = Object.fromEntries(
        owed.earnedNotInstructed.map((s: { stream: string }) => [s.stream, s]),
      );
      // The ₦10,000 content unlock has no ledger entry against it, so its
      // ₦8,500 creator share is outstanding.
      expect(byStream.content.creatorShareNaira).toBeGreaterThanOrEqual(8_500);
      expect(byStream.content.sweptAutomatically).toBe(true);
      // Credits and event tickets have no path into a wallet at all.
      expect(byStream.credits.sweptAutomatically).toBe(false);
      expect(byStream.events.sweptAutomatically).toBe(false);
      expect(byStream.events.creatorShareNaira).toBeGreaterThanOrEqual(3_400);
    });

    it('filters the withdrawal list by status', async () => {
      const res = await payouts(financeToken, { status: 'failed' }).expect(200);
      expect(res.body.data.withdrawals.total).toBe(0);
      // The owed block is a running figure and is NOT bounded by the filter.
      expect(res.body.data.owed.earnedNotInstructedTotalNaira).toBeGreaterThan(
        0,
      );
    });
  });

  // ── GET /admin/finance/wallets ────────────────────────────────────────────

  describe('GET /api/hub/admin/finance/wallets', () => {
    const wallets = (token: string, query: Record<string, unknown> = {}) =>
      http()
        .get('/api/hub/admin/finance/wallets')
        .query(query)
        .set(auth(token));

    it('returns a row per creator, with the subaccount and the lifetime ledger figures', async () => {
      const res = await wallets(financeToken, { q: 'afi-creator-a' }).expect(
        200,
      );
      expect(res.body.data).toHaveLength(1);

      expect(res.body.data[0]).toMatchObject({
        creator: { wawuId: CREATOR_A, handle: 'afi-creator-a' },
        kycStatus: 'approved',
        withdrawalsEnabled: true,
        payoutSubaccount: {
          accountReference: 'PSA-AFI-CREATOR-A',
          bankName: 'Flutterwave MFB',
          accountNumberLast4: '5678',
          status: 'active',
        },
        lifetime: {
          earnedInstructedNaira: 8_500,
          earningsPendingNaira: 1_700,
          withdrawnNaira: 2_000,
        },
      });
      // The creator's own NUBAN is masked here too.
      expect(JSON.stringify(res.body)).not.toContain('9012345678');
    });

    it('does not offer a summed figure as a balance', async () => {
      const res = await wallets(financeToken, { q: 'afi-creator-a' }).expect(
        200,
      );
      expect(res.body.data[0].balance).toEqual({
        ngn: null,
        source: 'flutterwave',
        unavailableReason: expect.stringContaining('withBalances'),
      });
    });

    it('reports FLUTTERWAVE’S balance when asked for it, not one it worked out', async () => {
      const res = await wallets(financeToken, {
        q: 'afi-creator-a',
        withBalances: 'true',
      }).expect(200);

      expect(res.body.data[0].balance).toEqual({
        ngn: FLUTTERWAVE_SAYS,
        source: 'flutterwave',
        unavailableReason: null,
      });
      // And it is nothing the ledger could have produced.
      const { earnedInstructedNaira, withdrawnNaira } =
        res.body.data[0].lifetime;
      expect(earnedInstructedNaira - withdrawnNaira).not.toBe(FLUTTERWAVE_SAYS);
    });

    it('lists a creator with no subaccount rather than hiding them', async () => {
      const res = await wallets(financeToken, { q: 'afi-creator-b' }).expect(
        200,
      );
      expect(res.body.data[0]).toMatchObject({
        creator: { wawuId: CREATOR_B },
        // CREATOR_B's CreatorState is at its `pending` default with no
        // KycSubmission behind it, which is the `not_started` synthesis the
        // creator's own screen shows them.
        kycStatus: 'not_started',
        withdrawalsEnabled: false,
        payoutSubaccount: null,
      });
      expect(res.body.data[0].balance.ngn).toBeNull();
    });

    it('filters by whether a payout subaccount exists', async () => {
      const withOne = await wallets(financeToken, {
        q: 'afi-creator',
        hasSubaccount: 'true',
      }).expect(200);
      expect(
        withOne.body.data.map(
          (r: { creator: { wawuId: string } }) => r.creator.wawuId,
        ),
      ).toEqual([CREATOR_A]);

      const withNone = await wallets(financeToken, {
        q: 'afi-creator',
        hasSubaccount: 'false',
      }).expect(200);
      expect(
        withNone.body.data.map(
          (r: { creator: { wawuId: string } }) => r.creator.wawuId,
        ),
      ).toEqual([CREATOR_B]);
    });

    it('filters by KYC state, including the state it synthesises', async () => {
      const approved = await wallets(financeToken, {
        q: 'afi-creator',
        kycStatus: 'approved',
      }).expect(200);
      expect(
        approved.body.data.map(
          (r: { creator: { wawuId: string } }) => r.creator.wawuId,
        ),
      ).toEqual([CREATOR_A]);

      // The word the list prints has to be a word the filter accepts.
      const notStarted = await wallets(financeToken, {
        q: 'afi-creator',
        kycStatus: 'not_started',
      }).expect(200);
      expect(
        notStarted.body.data.map(
          (r: { creator: { wawuId: string } }) => r.creator.wawuId,
        ),
      ).toEqual([CREATOR_B]);
    });

    it('never lists a buyer account', async () => {
      const res = await wallets(financeToken, {
        q: 'afi-',
        perPage: 100,
      }).expect(200);
      const ids = res.body.data.map(
        (r: { creator: { wawuId: string } }) => r.creator.wawuId,
      );
      expect(ids).not.toContain(BUYER);
    });
  });

  // ── GET /admin/finance/wallets/:wawuId ────────────────────────────────────

  describe('GET /api/hub/admin/finance/wallets/:wawuId', () => {
    const wallet = (
      token: string,
      wawuId: string,
      query: Record<string, unknown> = {},
    ) =>
      http()
        .get(`/api/hub/admin/finance/wallets/${wawuId}`)
        .query(query)
        .set(auth(token));

    it('returns one wallet with its ledger, newest first', async () => {
      const res = await wallet(financeToken, CREATOR_A).expect(200);

      expect(res.body.data).toMatchObject({
        creator: { wawuId: CREATOR_A, handle: 'afi-creator-a' },
        currency: 'NGN',
        amountsIn: 'naira',
        historyTotal: 3,
        balance: { ngn: FLUTTERWAVE_SAYS, source: 'flutterwave' },
      });

      const kinds = res.body.data.history.map((e: { kind: string }) => e.kind);
      expect(kinds).toEqual(['withdrawal', 'earning', 'earning']);
      expect(res.body.data.history[0]).toMatchObject({
        amountNaira: 2_000,
        status: 'completed',
        reference: `${TX}withdrawal-1`,
      });
    });

    it('caps the history at ?historyLimit', async () => {
      const res = await wallet(financeToken, CREATOR_A, {
        historyLimit: 1,
      }).expect(200);
      expect(res.body.data.history).toHaveLength(1);
      expect(res.body.data.historyTotal).toBe(3);
    });

    it('opens for a creator with no subaccount rather than opening one', async () => {
      const res = await wallet(financeToken, CREATOR_B).expect(200);
      expect(res.body.data.payoutSubaccount).toBeNull();
      expect(res.body.data.history).toEqual([]);

      // The read must not have created a wallet as a side effect.
      const opened = await prisma.creatorWallet.findUnique({
        where: { wawuUserId: CREATOR_B },
      });
      expect(opened).toBeNull();
    });

    it('404s on an id this backend has never heard of', async () => {
      await wallet(financeToken, 'fa000000-0000-4000-8000-0000000000ff').expect(
        404,
      );
    });
  });

  // ── who may read any of this ──────────────────────────────────────────────

  describe('authorisation', () => {
    const ROUTES = [
      '/api/hub/admin/finance/summary',
      '/api/hub/admin/finance/transactions',
      '/api/hub/admin/finance/payouts',
      '/api/hub/admin/finance/wallets',
      `/api/hub/admin/finance/wallets/${CREATOR_A}`,
    ];

    it('admits superadmin and finance on every route', async () => {
      for (const route of ROUTES) {
        await http().get(route).set(auth(superToken)).expect(200);
        await http().get(route).set(auth(financeToken)).expect(200);
      }
    });

    it('refuses support and reviewer on every route', async () => {
      for (const route of ROUTES) {
        await http().get(route).set(auth(supportToken)).expect(403);
        await http().get(route).set(auth(reviewerToken)).expect(403);
      }
    });

    it('refuses an unauthenticated caller on every route', async () => {
      for (const route of ROUTES) {
        await http().get(route).expect(401);
      }
    });

    it('refuses a WAWU ID user token, so a creator cannot read another creator’s wallet', async () => {
      // The token a real creator holds. AdminTokenService pins HS256 against a
      // local secret and a WAWU ID token is RS256 signed by a key this backend
      // has never held, so the separation is cryptographic rather than a claim
      // check that could be forged.
      const res = await http()
        .get(`/api/hub/admin/finance/wallets/${CREATOR_A}`)
        .set(auth(creatorToken))
        .expect(401);
      expect(JSON.stringify(res.body)).not.toContain('PSA-AFI-CREATOR-A');

      await http()
        .get(`/api/hub/admin/finance/wallets/${CREATOR_B}`)
        .set(auth(creatorToken))
        .expect(401);
      await http()
        .get('/api/hub/admin/finance/summary')
        .set(auth(userToken))
        .expect(401);
    });
  });

  // ── read-only ─────────────────────────────────────────────────────────────

  describe('the surface is read-only', () => {
    const ROUTES = [
      '/api/hub/admin/finance/summary',
      '/api/hub/admin/finance/transactions',
      '/api/hub/admin/finance/payouts',
      '/api/hub/admin/finance/wallets',
      `/api/hub/admin/finance/wallets/${CREATOR_A}`,
    ];

    /**
     * Read-only that is only a convention is not read-only. Every verb that
     * could move money is asked for by name, as a superadmin - the role with
     * the most reach on this platform - and has to 404 because no handler for
     * it exists, not 403 because a guard happened to catch it.
     */
    it('answers GET on every path and nothing else', async () => {
      for (const route of ROUTES) {
        await http().get(route).set(auth(superToken)).expect(200);
        await http()
          .post(route)
          .set(auth(superToken))
          .send({ amount: 1 })
          .expect(404);
        await http()
          .put(route)
          .set(auth(superToken))
          .send({ amount: 1 })
          .expect(404);
        await http()
          .patch(route)
          .set(auth(superToken))
          .send({ amount: 1 })
          .expect(404);
        await http().delete(route).set(auth(superToken)).expect(404);
      }
    });

    /**
     * Reading the books must not change them. The money rows are counted
     * before and after a full pass over every endpoint, because an admin
     * screen that quietly writes is the failure this whole surface is shaped
     * to avoid.
     */
    it('writes nothing while answering', async () => {
      const count = async () => ({
        purchases: await prisma.purchase.count(),
        dms: await prisma.directMessage.count(),
        credits: await prisma.creditPurchase.count(),
        verifications: await prisma.verificationPurchase.count(),
        eventOrders: await prisma.eventOrder.count(),
        shopOrders: await prisma.shopOrder.count(),
        wallets: await prisma.creatorWallet.count(),
        entries: await prisma.walletLedgerEntry.count(),
        withdrawals: await prisma.walletWithdrawal.count(),
      });

      const before = await count();
      for (const route of ROUTES) {
        await http().get(route).set(auth(financeToken)).expect(200);
      }
      await http()
        .get('/api/hub/admin/finance/wallets')
        .query({ withBalances: 'true' })
        .set(auth(financeToken))
        .expect(200);

      expect(await count()).toEqual(before);
    });
  });
});
