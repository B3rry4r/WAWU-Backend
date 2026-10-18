import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import {
  NuvionAccountsStandin,
  standinId,
  type StandinTransfer,
} from '../../../../test/nuvion/accounts-standin';
import {
  errorBody,
  NuvionStandin,
} from '../../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../../test/nuvion/outbound-guard';
import { NuvionPayoutsStandin } from '../../../../test/nuvion/payouts-standin';
import { WawuIdDouble } from '../../../../test/nuvion/wawu-id-double';
import { QuietLogger } from '../../../../test/transfers/harness';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { MoneyModule } from '../../../money/money.module';
import { PrismaNuvionBookStore } from '../../../nuvion/areas/book-store';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { SchoolSettlementModule } from '../school-settlement.module';
import { SchoolSettlementService } from '../school-settlement.service';
import { payoutReference } from '../school-settlement-rules';

/**
 * A school payout that Nuvion ACCEPTS and then FAILS is paid, once, under a
 * new reference (FIX-72, FIX-70's check, finding G-FIX-70-1).
 *
 * A school's 85% is sent from WAWU's account under `wawu-bank-sch-<id>`. When
 * Nuvion made that transfer and its own record says `failed`, the reference is
 * spent: `unique_reference` is Nuvion's idempotency key, so a repeat answers
 * with the same failed record (api-reference__transfers.md line 174). The
 * settlement used to take the failed answer for a refusal and send again under
 * the same reference every hour, with no end: the school was never paid. Now
 * only Nuvion's own record that the transfer failed starts the one new try,
 * under `wawu-bank-sch-<id>-2`; a second failure goes to a person; a timeout, a
 * 5xx, an unreadable or an unfinished record never starts a new reference
 * (asked about, never sent again), and past PAYMENT_REVIEW_AFTER_HOURS the
 * payout goes to a person and leaves the sweep.
 *
 * The REAL Nuvion adapter (payouts area), the real money layer and the real
 * ledger run over Nuvion's stand-in on a socket. Nothing here reaches a Nuvion,
 * Fintava or wawuafrica.com host (every connection but loopback is refused).
 */

const OPERATIONAL_START = 5_000_000_000;
const PRICE = 15_000_000;
const SCHOOL_SHARE = 12_750_000;
const WAWU_SHARE = 2_250_000;
const FEE = 2_500;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const BANK = '058';
const HOLDER = 'GREENFIELD TECH ACADEMY LTD';
/** PAYMENT_REVIEW_AFTER_HOURS for this spec. */
const REVIEW_HOURS = 24;

jest.setTimeout(180_000);

let numberSeq = 0;
const nuban = () =>
  `7${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

type Row = Record<string, unknown>;

describe('A school payout that Nuvion accepts and then fails is paid once, under a new reference (FIX-72)', () => {
  const standin = new NuvionStandin();
  const wawuId = new WawuIdDouble();
  const nuv = new NuvionAccountsStandin(standin);
  const pay = new NuvionPayoutsStandin(standin, nuv, standinId('01OPS'));
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let settlements: SchoolSettlementService;
  let moduleRef: TestingModule;
  let outsideCounter: Server;
  const outsideHits: string[] = [];
  const schoolIds: string[] = [];
  const paymentIds: string[] = [];
  const settlementIds: string[] = [];
  const previous: Record<string, string | undefined> = {};
  let clock = Date.now();
  /** A moment `ms` after the latest one this spec has used. */
  const later = (ms = 0) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };
  const at = (base: Date, ms: number) => new Date(base.getTime() + ms);

  const available = () => BigInt(Number(pay.operational.balance.available));
  const startDay = () =>
    new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);

  interface Payable {
    schoolId: string;
    enrolmentId: string;
    holdId: string;
    account: string;
  }

  /**
   * A paid enrolment whose class has started: its fee waits in a hold in
   * WAWU's account, and the school has a bank account the payout goes to.
   */
  async function payable(): Promise<Payable> {
    const school = await prisma.school.create({
      data: {
        name: `Greenfield ${randomUUID().slice(0, 6)}`,
        category: 'tech',
        location: 'Yaba, Lagos',
        about: 'A school.',
        reportEmail: `office-${randomUUID().slice(0, 8)}@school.test`,
      },
    });
    schoolIds.push(school.id);
    const course = await prisma.schoolCourse.create({
      data: {
        schoolId: school.id,
        title: 'Product Design Bootcamp',
        weeks: 12,
        mode: 'in_person',
        syllabus: ['Basics'],
        outcomes: ['Certificate'],
        priceKobo: PRICE,
      },
    });
    const intake = await prisma.courseIntake.create({
      data: {
        courseId: course.id,
        startDate: new Date(`${startDay()}T00:00:00.000Z`),
        schedule: 'Saturdays',
        location: 'Yaba',
        capacity: 10,
        seatsTaken: 1,
      },
    });
    const account = nuban();
    await prisma.schoolPayee.create({
      data: {
        schoolId: school.id,
        bankCode: BANK,
        bankName: 'Guaranty Trust Bank',
        accountNumber: account,
        accountName: HOLDER,
        verifiedAt: new Date(),
      },
    });
    const enrolmentId = randomUUID();
    const paymentId = randomUUID();
    paymentIds.push(paymentId);
    await prisma.walletPayment.create({
      data: {
        id: paymentId,
        kind: 'school_fee',
        targetId: enrolmentId,
        title: course.title,
        priceKobo: BigInt(PRICE),
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: BigInt(PRICE),
        payeeShareKobo: BigInt(SCHOOL_SHARE),
        wawuShareKobo: BigInt(WAWU_SHARE),
        customerReference: `wawu-pay-${paymentId}`,
        merchantAccountNumber: pay.operational.nuvion_ban,
        provider: 'nuvion',
        status: 'completed',
        completedAt: new Date(),
        fulfilledAt: new Date(),
      },
    });
    const hold = await prisma.walletHold.create({
      data: {
        paymentId,
        kind: 'school_fee',
        targetId: enrolmentId,
        title: course.title,
        releaseCondition: 'bill_delivered',
        amountKobo: BigInt(PRICE),
        payeeShareKobo: BigInt(SCHOOL_SHARE),
        wawuShareKobo: BigInt(WAWU_SHARE),
        merchantAccountNumber: pay.operational.nuvion_ban,
        provider: 'nuvion',
        heldAt: new Date(),
      },
    });
    await prisma.schoolEnrolment.create({
      data: {
        id: enrolmentId,
        schoolId: school.id,
        courseId: course.id,
        intakeId: intake.id,
        status: 'enrolled',
        reference:
          `WAW-${randomUUID().slice(0, 4)}-${randomUUID().slice(0, 4)}`.toUpperCase(),
        courseTitle: course.title,
        schoolName: school.name,
        intakeStartDate: intake.startDate,
        intakeSchedule: 'Saturdays',
        priceKobo: PRICE,
        schoolShareKobo: SCHOOL_SHARE,
        wawuShareKobo: WAWU_SHARE,
        commissionBps: 1500,
        reservedUntil: new Date(Date.now() + HOUR),
        paymentId,
        holdId: hold.id,
        enrolledAt: new Date(),
      },
    });
    return { schoolId: school.id, enrolmentId, holdId: hold.id, account };
  }

  const settlementOf = (enrolmentId: string) =>
    prisma.schoolSettlement.findUniqueOrThrow({ where: { enrolmentId } });
  const holdOf = (id: string) =>
    prisma.walletHold.findUniqueOrThrow({ where: { id } });

  /** The payout is decided and its first try is made (the sweep, at `now`). */
  async function start(
    p: Payable,
    now: Date,
  ): Promise<{ id: string; ref1: string; ref2: string }> {
    await settlements.run(now);
    const row = await settlementOf(p.enrolmentId);
    settlementIds.push(row.id);
    return {
      id: row.id,
      ref1: payoutReference(row.id, 1),
      ref2: payoutReference(row.id, 2),
    };
  }

  /** Every `POST /transfers` Nuvion was asked (whatever it answered), under this payout's references. */
  const postsOf = (id: string): string[] =>
    standin.seen
      .filter((r) => r.method === 'POST' && r.path === '/transfers')
      .map((r) => String((r.body as Row).unique_reference))
      .filter((r) => r.startsWith(`wawu-bank-sch-${id}`));
  /** Every transfer Nuvion holds under this payout's references. */
  const transfersOf = (id: string): StandinTransfer[] =>
    [...nuv.transfers.values()].filter((t) =>
      String(t.unique_reference).startsWith(`wawu-bank-sch-${id}`),
    );
  const transferOf = (reference: string): StandinTransfer => {
    const [t] = pay.byReference(reference);
    if (!t) throw new Error(`Nuvion holds no transfer under ${reference}`);
    return t;
  };

  /**
   * WAWU's account ledger equals Nuvion's: what the ledger counts as moved out
   * of the operational account (pending and completed rows, under this
   * payout's references) is exactly what Nuvion took from it, and a transfer
   * Nuvion failed has no row that still counts.
   */
  async function ledgerEqualsNuvion(ids: string[], before: bigint) {
    const refs = ids.flatMap((id) =>
      [1, 2, 3].map((n) => payoutReference(id, n)),
    );
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: {
        customerReference: { in: refs },
        walletKind: 'merchant',
        direction: 'out',
      },
    });
    const counted = rows.filter(
      (r) => r.status === 'pending' || r.status === 'completed',
    );
    const moved = counted.reduce((n, r) => n + BigInt(r.totalKobo), 0n);
    expect(moved).toBe(before - available());
    for (const t of pay.nuv.transfers.values()) {
      if (t.status !== 'failed') continue;
      if (!refs.includes(String(t.unique_reference))) continue;
      expect(
        counted.some((r) => r.customerReference === t.unique_reference),
      ).toBe(false);
    }
    // One row per reference, never two.
    const seen = rows.map((r) => r.customerReference);
    expect(new Set(seen).size).toBe(seen.length);
    return rows;
  }

  beforeAll(async () => {
    guard = guardOutbound();
    outsideCounter = createServer((req, res) => {
      outsideHits.push(`${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('{}');
    });
    await new Promise<void>((r) =>
      outsideCounter.listen(0, '127.0.0.1', () => r()),
    );
    const port = (outsideCounter.address() as AddressInfo).port;
    await standin.start();
    await wawuId.start();
    nuv.install();
    pay.install();
    pay.fee = FEE;
    pay.operational.balance = {
      available: OPERATIONAL_START,
      current: OPERATIONAL_START,
      overdraft_used: 0,
    };
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_f72_payout_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'f72-payout-fee-quote-key-0123456789abcdef01',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: String(FEE),
      NUVION_FEE_BANK_PAYOUT: String(FEE),
      NUVION_FEE_INFLOW: String(FEE),
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
      WAWU_ID_INTERNAL_SERVICE_KEY: 'f72-test-service-key',
      ADMIN_JWT_SECRET: 'f72-admin-access-secret-0123456789abcdef01',
      ADMIN_JWT_REFRESH_SECRET: 'f72-admin-refresh-secret-0123456789abcdef0',
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: String(REVIEW_HOURS),
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const client = new NuvionClient(
      standin.settings({
        operationalAccountId: pay.operationalAccountId,
        moneyTimeoutMs: 500,
        readTimeoutMs: 2_000,
      }),
      'nv_test_sk_F72payoutKEY00000000000000',
    );
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        SchoolSettlementModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useFactory({
        inject: [PrismaService],
        factory: (db: PrismaService) =>
          new NuvionWalletProvider(
            client,
            nuvionAreas(client, { bookStore: new PrismaNuvionBookStore(db) }),
          ),
      })
      .setLogger(logger)
      .compile();
    app = moduleRef.createNestApplication({ ...HUB_APP_OPTIONS, logger });
    app.useLogger(logger);
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
    await app.listen(0, '127.0.0.1');
    prisma = moduleRef.get(PrismaService);
    settlements = moduleRef.get(SchoolSettlementService);
  });

  afterAll(async () => {
    if (prisma) {
      const refs = settlementIds.flatMap((id) =>
        [1, 2, 3].map((n) => payoutReference(id, n)),
      );
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { customerReference: { in: refs } },
      });
      await prisma.schoolSettlement.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      await prisma.schoolEnrolment.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      await prisma.walletHold.deleteMany({
        where: { paymentId: { in: paymentIds } },
      });
      await prisma.walletPayment.deleteMany({
        where: { id: { in: paymentIds } },
      });
      await prisma.schoolPayee.deleteMany({
        where: { schoolId: { in: schoolIds } },
      });
      await prisma.school.deleteMany({ where: { id: { in: schoolIds } } });
    }
    if (app) await app.close();
    await standin.stop();
    await wawuId.stop();
    await new Promise<void>((r) => outsideCounter.close(() => r()));
    guard.restore();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  afterEach(() => {
    // Nothing reached a provider host, and Fintava was never asked.
    expect(guard.violations).toEqual([]);
    expect(outsideHits).toEqual([]);
  });

  // -------------------------------------------------------------------------

  it('a payout Nuvion accepts and fails at once is sent again under a NEW reference, once, and the school is paid once', async () => {
    const before = available();
    const p = await payable();
    pay.failCreateNext(1);
    const t0 = later(MINUTE);
    const s = await start(p, t0);

    // The first try: Nuvion made the transfer and failed it. Its record is the
    // proof; the reference is spent and is never asked again.
    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect(transferOf(s.ref1).status).toBe('failed');
    const afterFirst = await settlementOf(p.enrolmentId);
    expect(afterFirst).toMatchObject({
      status: 'pending',
      attempt: 2,
      customerReference: s.ref2,
      sentAt: null,
    });
    // The new try rests at least the sweep interval (a minute).
    expect(
      afterFirst.nextAttemptAt!.getTime() - t0.getTime(),
    ).toBeGreaterThanOrEqual(MINUTE);
    expect(available()).toBe(before);

    // A sweep inside the rest sends nothing; two sweeps never make two tries.
    await settlements.run(at(t0, 30_000));
    await settlements.run(at(t0, 40_000));
    expect(postsOf(s.id)).toEqual([s.ref1]);

    // After the rest: one new try, under the new reference.
    const t1 = at(t0, 10 * MINUTE);
    await settlements.run(t1);
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    expect((await settlementOf(p.enrolmentId)).status).toBe('sent');
    // Never two tries in flight: the first is failed, the second is pending.
    expect(
      transfersOf(s.id).filter(
        (t) => t.status === 'pending' || t.status === 'processing',
      ),
    ).toHaveLength(1);
    await ledgerEqualsNuvion([s.id], before);

    // Nuvion completes the second try: the school is paid, once.
    pay.settle(transferOf(s.ref2).id, 'successful');
    const t2 = at(t1, 61 * MINUTE);
    await settlements.run(t2);
    await settlements.run(at(t2, 61 * MINUTE));
    const paid = await settlementOf(p.enrolmentId);
    expect(paid).toMatchObject({
      status: 'paid',
      attempt: 2,
      customerReference: s.ref2,
    });
    expect((await holdOf(p.holdId)).status).toBe('released');
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    expect(
      transfersOf(s.id)
        .filter((t) => t.status === 'successful')
        .map((t) => [t.unique_reference, Number(t.amount)]),
    ).toEqual([[s.ref2, SCHOOL_SHARE]]);
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));

    const rows = await ledgerEqualsNuvion([s.id], before);
    expect(rows.map((r) => [r.customerReference, r.status]).sort()).toEqual(
      [
        [s.ref1, 'failed'],
        [s.ref2, 'completed'],
      ].sort(),
    );
  });

  it('a second failure sends nothing more, goes to a person and stays out of the sweep, past the review bound too', async () => {
    const before = available();
    const p = await payable();
    pay.failCreateNext(2);
    const t0 = later(MINUTE);
    const s = await start(p, t0);
    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect((await settlementOf(p.enrolmentId)).attempt).toBe(2);

    // The one new try is made after the rest, and Nuvion fails that too.
    await settlements.run(at(t0, 10 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    expect(transferOf(s.ref2).status).toBe('failed');
    const row = await settlementOf(p.enrolmentId);
    expect(row.status).toBe('review');
    expect(row.reviewNote).toContain('failed on its second try');
    expect(row.nextAttemptAt).toBeNull();
    expect((await holdOf(p.holdId)).status).toBe('held');

    // No third reference, now or past the review bound: it left the sweep.
    await settlements.run(at(t0, HOUR));
    await settlements.run(at(t0, (REVIEW_HOURS + 1) * HOUR));
    await settlements.run(at(t0, 100 * HOUR));
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    expect((await settlementOf(p.enrolmentId)).status).toBe('review');

    // Both tries failed at Nuvion: nothing left the account, and no row counts.
    expect(available()).toBe(before);
    const rows = await ledgerEqualsNuvion([s.id], before);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed']);
  });

  it("a timeout (the answer is lost) never starts a new reference; Nuvion's failed record starts exactly one", async () => {
    const before = available();
    const p = await payable();
    pay.loseAnswerNext();
    const t0 = later(MINUTE);
    const s = await start(p, t0);

    // Nuvion made the transfer, the answer never came: asked about, not sent.
    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect((await settlementOf(p.enrolmentId)).status).toBe('sent');
    await settlements.run(at(t0, 3 * MINUTE));
    await settlements.run(at(t0, 70 * MINUTE));
    await settlements.run(at(t0, 140 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect((await settlementOf(p.enrolmentId)).attempt).toBe(1);
    await ledgerEqualsNuvion([s.id], before);

    // Only Nuvion's own record that it failed starts one new try.
    pay.settle(transferOf(s.ref1).id, 'failed');
    const t1 = at(t0, 210 * MINUTE);
    await settlements.run(t1);
    const retry = await settlementOf(p.enrolmentId);
    expect(retry).toMatchObject({ status: 'pending', attempt: 2 });
    expect(postsOf(s.id)).toEqual([s.ref1]);
    await settlements.run(at(t1, 10 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    pay.settle(transferOf(s.ref2).id, 'successful');
    await settlements.run(at(t1, 80 * MINUTE));
    expect((await settlementOf(p.enrolmentId)).status).toBe('paid');
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));
    await ledgerEqualsNuvion([s.id], before);
  });

  it('a 5xx on the send (Nuvion made the transfer) never starts a new reference; its failed record starts exactly one', async () => {
    const before = available();
    const p = await payable();
    pay.answerAfterNext(503);
    const t0 = later(MINUTE);
    const s = await start(p, t0);

    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect(transferOf(s.ref1).status).toBe('pending');
    expect((await settlementOf(p.enrolmentId)).status).toBe('sent');
    await settlements.run(at(t0, 3 * MINUTE));
    await settlements.run(at(t0, 70 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1]);
    await ledgerEqualsNuvion([s.id], before);

    pay.settle(transferOf(s.ref1).id, 'failed');
    const t1 = at(t0, 140 * MINUTE);
    await settlements.run(t1);
    expect(postsOf(s.id)).toEqual([s.ref1]);
    await settlements.run(at(t1, 10 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    pay.settle(transferOf(s.ref2).id, 'successful');
    await settlements.run(at(t1, 80 * MINUTE));
    expect((await settlementOf(p.enrolmentId)).status).toBe('paid');
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));
    await ledgerEqualsNuvion([s.id], before);
  });

  it('a 5xx before Nuvion made anything never sends again under any reference; past the review bound it goes to a person', async () => {
    const p = await payable();
    pay.answerNext('POST', /^\/transfers$/, {
      status: 503,
      body: errorBody('error_service_unavailable', 'Try again later.'),
    });
    const t0 = later(MINUTE);
    const s = await start(p, t0);

    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect(transfersOf(s.id)).toHaveLength(0);
    expect((await settlementOf(p.enrolmentId)).status).toBe('sent');
    // Asked about at each look, never sent: one request only, ever.
    await settlements.run(at(t0, 3 * MINUTE));
    await settlements.run(at(t0, 70 * MINUTE));
    await settlements.run(at(t0, 10 * HOUR));
    expect(postsOf(s.id)).toEqual([s.ref1]);

    // Past the bound a person takes it; it leaves the sweep.
    await settlements.run(at(t0, (REVIEW_HOURS + 1) * HOUR));
    const row = await settlementOf(p.enrolmentId);
    expect(row.status).toBe('review');
    expect(row.reviewNote).toContain(`${REVIEW_HOURS} hours`);
    await settlements.run(at(t0, 100 * HOUR));
    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect(transfersOf(s.id)).toHaveLength(0);
    // Nothing was made at Nuvion. The ledger keeps the send pending (money may
    // have moved) until the person decides: it is the one row it holds.
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: s.ref1 },
    });
    expect(rows.map((r) => r.status)).toEqual(['pending']);
  });

  it('a failed record Nuvion cannot be read for is asked again; only the readable failed record starts a new reference', async () => {
    const before = available();
    const p = await payable();
    pay.failCreateNext(1);
    // The read of the failed transfer is a 5xx: the failure is not proven.
    pay.answerNext('GET', /^\/transfers$/, {
      status: 503,
      body: errorBody('error_service_unavailable', 'Try again later.'),
    });
    const t0 = later(MINUTE);
    const s = await start(p, t0);

    expect(postsOf(s.id)).toEqual([s.ref1]);
    const held = await settlementOf(p.enrolmentId);
    expect(held).toMatchObject({ status: 'sent', attempt: 1 });
    // Not a refusal: the lease is not given back, the reference is not asked.
    expect(held.sentAt).not.toBeNull();
    await settlements.run(at(t0, 30_000));
    expect(postsOf(s.id)).toEqual([s.ref1]);

    // The record is read now: it says failed, and the one new try follows.
    const t1 = at(t0, 5 * MINUTE);
    await settlements.run(t1);
    expect(await settlementOf(p.enrolmentId)).toMatchObject({
      status: 'pending',
      attempt: 2,
    });
    expect(postsOf(s.id)).toEqual([s.ref1]);
    await settlements.run(at(t1, 10 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    pay.settle(transferOf(s.ref2).id, 'successful');
    await settlements.run(at(t1, 80 * MINUTE));
    expect((await settlementOf(p.enrolmentId)).status).toBe('paid');
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));
    await ledgerEqualsNuvion([s.id], before);
  });

  it('a transfer Nuvion has accepted and not finished never starts a new reference; past the review bound it goes to a person', async () => {
    const before = available();
    const p = await payable();
    const t0 = later(MINUTE);
    const s = await start(p, t0);

    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect(transferOf(s.ref1).status).toBe('pending');
    for (const hours of [1, 6, 12, 23]) {
      await settlements.run(at(t0, hours * HOUR));
      expect((await settlementOf(p.enrolmentId)).status).toBe('sent');
    }
    expect(postsOf(s.id)).toEqual([s.ref1]);
    await ledgerEqualsNuvion([s.id], before);

    await settlements.run(at(t0, (REVIEW_HOURS + 1) * HOUR));
    const row = await settlementOf(p.enrolmentId);
    expect(row.status).toBe('review');
    expect(row.nextAttemptAt).toBeNull();
    await settlements.run(at(t0, 100 * HOUR));
    expect(postsOf(s.id)).toEqual([s.ref1]);
    // The money left the account as the pending transfer says, and the ledger agrees.
    await ledgerEqualsNuvion([s.id], before);
  });

  // -------------------------------------------------------------------------
  // SWEEP-MONEY-4 C2 and L1 (FIX-72). The retry rule held for every way the
  // provider's answer can be unclear: each confirmed provider failure gets
  // one new try under a new reference; a timeout, a 5xx, an unreadable record
  // or a word we do not know asks again and never sends again; never two
  // transfers in flight; and a payout Nuvion refuses, or that waits for
  // funds, is asked again under the SAME reference, which cannot pay twice.
  // -------------------------------------------------------------------------

  /** Transfers Nuvion holds for this payout that are not finished: never more than one. */
  const inFlight = (id: string) =>
    transfersOf(id).filter(
      (t) => t.status === 'pending' || t.status === 'processing',
    ).length;

  /**
   * Nuvion's list of transfers (the read that finds a payout's record by its
   * reference) answers `how` for as long as it is held. Returns the way back.
   */
  const unreadable = (how: 'a 5xx' | 'a cut connection'): (() => void) => {
    const handler = () =>
      how === 'a 5xx'
        ? {
            status: 503,
            body: errorBody('error_service_unavailable', 'Try again later.'),
          }
        : { status: 0, hangUp: true };
    standin.on('GET', /^\/transfers$/, handler);
    return () => {
      const routes = (
        standin as unknown as { routes: Array<{ handler: unknown }> }
      ).routes;
      routes.splice(
        routes.findIndex((r) => r.handler === handler),
        1,
      );
    };
  };

  it('a failed payout whose record cannot be read, read after read for hours, never starts a new reference or sends again; the readable failed record then starts exactly one (C2)', async () => {
    const before = available();
    const p = await payable();
    pay.failCreateNext(1);
    const t0 = later(MINUTE);
    let back = unreadable('a 5xx');
    let s: { id: string; ref1: string; ref2: string };
    try {
      s = await start(p, t0);
      // Nuvion made the transfer and failed it; the Hub cannot read that, so
      // the failure is not proven and the reference is not given up.
      expect(postsOf(s.id)).toEqual([s.ref1]);
      expect(transferOf(s.ref1).status).toBe('failed');
      let step = 0;
      for (const ms of [
        30_000,
        5 * MINUTE,
        70 * MINUTE,
        6 * HOUR,
        12 * HOUR,
        20 * HOUR,
      ]) {
        // The first looks meet a 5xx, the later ones a cut connection.
        if (step === 3) {
          back();
          back = unreadable('a cut connection');
        }
        step += 1;
        await settlements.run(at(t0, ms));
        expect(postsOf(s.id)).toEqual([s.ref1]);
        expect(transfersOf(s.id)).toHaveLength(1);
        expect(inFlight(s.id)).toBe(0);
        expect(await settlementOf(p.enrolmentId)).toMatchObject({
          status: 'sent',
          attempt: 1,
          customerReference: s.ref1,
        });
      }
    } finally {
      back();
    }
    expect(available()).toBe(before);

    // Readable at last: the record says failed. The pass that reads it only
    // marks the new reference; the one new try follows after the rest.
    const t1 = at(t0, 21 * HOUR);
    await settlements.run(t1);
    expect(await settlementOf(p.enrolmentId)).toMatchObject({
      status: 'pending',
      attempt: 2,
      customerReference: s.ref2,
    });
    expect(postsOf(s.id)).toEqual([s.ref1]);
    await settlements.run(at(t1, 10 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    expect(inFlight(s.id)).toBe(1);
    pay.settle(transferOf(s.ref2).id, 'successful');
    await settlements.run(at(t1, 80 * MINUTE));
    await settlements.run(at(t1, 200 * MINUTE));
    expect((await settlementOf(p.enrolmentId)).status).toBe('paid');
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref2]);
    expect(inFlight(s.id)).toBe(0);
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));
    const rows = await ledgerEqualsNuvion([s.id], before);
    expect(rows.map((r) => [r.customerReference, r.status]).sort()).toEqual(
      [
        [s.ref1, 'failed'],
        [s.ref2, 'completed'],
      ].sort(),
    );
  });

  it('a failed payout whose record stays unreadable past the review bound goes to a person and is never sent again, even when the record is readable later (C2)', async () => {
    const before = available();
    const p = await payable();
    pay.failCreateNext(1);
    const t0 = later(MINUTE);
    const back = unreadable('a 5xx');
    let s: { id: string; ref1: string; ref2: string };
    try {
      s = await start(p, t0);
      await settlements.run(at(t0, 10 * HOUR));
      expect((await settlementOf(p.enrolmentId)).status).toBe('sent');
      await settlements.run(at(t0, (REVIEW_HOURS + 1) * HOUR));
    } finally {
      back();
    }
    const row = await settlementOf(p.enrolmentId);
    expect(row.status).toBe('review');
    expect(row.nextAttemptAt).toBeNull();
    // It left the sweep: a readable record changes nothing now.
    await settlements.run(at(t0, 100 * HOUR));
    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect(transfersOf(s.id)).toHaveLength(1);
    expect(inFlight(s.id)).toBe(0);
    expect(available()).toBe(before);
  });

  it('a payout Nuvion refuses (nothing made) is asked again under the SAME reference after the rest: one transfer at Nuvion, the school paid once (L1)', async () => {
    const before = available();
    const p = await payable();
    pay.answerNext('POST', /^\/transfers$/, {
      status: 422,
      body: errorBody('error_validation_error', 'A field is invalid'),
    });
    const t0 = later(MINUTE);
    const s = await start(p, t0);

    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect(transfersOf(s.id)).toHaveLength(0);
    expect(await settlementOf(p.enrolmentId)).toMatchObject({
      status: 'pending',
      attempt: 1,
      waiting: 'refused',
      customerReference: s.ref1,
    });
    expect(available()).toBe(before);

    // A sweep inside the rest sends nothing; after it the same reference is used.
    await settlements.run(at(t0, 30_000));
    expect(postsOf(s.id)).toEqual([s.ref1]);
    await settlements.run(at(t0, 10 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref1]);
    expect(transfersOf(s.id)).toHaveLength(1);
    pay.settle(transferOf(s.ref1).id, 'successful');
    await settlements.run(at(t0, 80 * MINUTE));
    await settlements.run(at(t0, 200 * MINUTE));
    expect((await settlementOf(p.enrolmentId)).status).toBe('paid');
    expect(transfersOf(s.id)).toHaveLength(1);
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));
    const rows = await ledgerEqualsNuvion([s.id], before);
    expect(rows.map((r) => [r.customerReference, r.status])).toEqual([
      [s.ref1, 'completed'],
    ]);
  });

  it('a payout that waits for funds is asked again under the SAME reference at each rest; when WAWU account is topped up it is made once and the school paid once (L1)', async () => {
    const before = available();
    const p = await payable();
    // WAWU's account cannot cover the send and its charge.
    pay.operational.balance = {
      available: SCHOOL_SHARE + FEE - 1,
      current: SCHOOL_SHARE + FEE - 1,
      overdraft_used: 0,
    };
    const t0 = later(MINUTE);
    let s: { id: string; ref1: string; ref2: string };
    try {
      s = await start(p, t0);
      expect(await settlementOf(p.enrolmentId)).toMatchObject({
        status: 'pending',
        waiting: 'funds',
        customerReference: s.ref1,
      });
      for (const ms of [10 * MINUTE, 70 * MINUTE, 3 * HOUR]) {
        await settlements.run(at(t0, ms));
      }
      // Asked each time it was due, always under the one reference; nothing made.
      expect(new Set(postsOf(s.id))).toEqual(new Set([s.ref1]));
      expect(postsOf(s.id).length).toBeGreaterThanOrEqual(3);
      expect(transfersOf(s.id)).toHaveLength(0);
      expect((await settlementOf(p.enrolmentId)).attempt).toBe(1);
    } finally {
      pay.operational.balance = {
        available: before,
        current: before,
        overdraft_used: 0,
      };
    }
    const asked = postsOf(s.id).length;
    await settlements.run(at(t0, 6 * HOUR));
    expect(postsOf(s.id)).toHaveLength(asked + 1);
    expect(new Set(postsOf(s.id))).toEqual(new Set([s.ref1]));
    expect(transfersOf(s.id)).toHaveLength(1);
    pay.settle(transferOf(s.ref1).id, 'successful');
    await settlements.run(at(t0, 8 * HOUR));
    await settlements.run(at(t0, 10 * HOUR));
    expect((await settlementOf(p.enrolmentId)).status).toBe('paid');
    expect(transfersOf(s.id)).toHaveLength(1);
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));
    await ledgerEqualsNuvion([s.id], before);
  });

  it('even if a refusal were wrong (Nuvion made the transfer and then answered a refusal), asking again under the SAME reference returns that transfer and the school is paid once (L1, the worst case)', async () => {
    const before = available();
    const p = await payable();
    // The transfer is made and the connection answers a refusal.
    (
      pay as unknown as { overrides: Array<Record<string, unknown>> }
    ).overrides.push({
      match: /^\/transfers$/,
      method: 'POST',
      what: {
        after: {
          status: 422,
          body: errorBody('error_validation_error', 'A field is invalid'),
        },
      },
    });
    const t0 = later(MINUTE);
    const s = await start(p, t0);

    expect(postsOf(s.id)).toEqual([s.ref1]);
    expect(transfersOf(s.id)).toHaveLength(1);
    expect(await settlementOf(p.enrolmentId)).toMatchObject({
      status: 'pending',
      waiting: 'refused',
      customerReference: s.ref1,
    });
    // The money left WAWU's account once, as Nuvion's pending transfer says.
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));

    await settlements.run(at(t0, 10 * MINUTE));
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref1]);
    // Nuvion answered the repeat with the original: still one transfer, one debit.
    expect(transfersOf(s.id)).toHaveLength(1);
    expect(inFlight(s.id)).toBe(1);
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));
    pay.settle(transferOf(s.ref1).id, 'successful');
    await settlements.run(at(t0, 80 * MINUTE));
    await settlements.run(at(t0, 200 * MINUTE));
    expect((await settlementOf(p.enrolmentId)).status).toBe('paid');
    expect(postsOf(s.id)).toEqual([s.ref1, s.ref1]);
    expect(transfersOf(s.id)).toHaveLength(1);
    expect(available()).toBe(before - BigInt(SCHOOL_SHARE + FEE));
    const rows = await ledgerEqualsNuvion([s.id], before);
    expect(rows.map((r) => [r.customerReference, r.status])).toEqual([
      [s.ref1, 'completed'],
    ]);
  });
});
