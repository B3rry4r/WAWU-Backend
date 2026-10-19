import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../src/common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../src/common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { WalletHoldService } from '../../src/money/holds/wallet-hold.service';
import { MoneyModule } from '../../src/money/money.module';
import { PayableRegistry } from '../../src/money/payments/payable-registry';
import { WalletPaymentService } from '../../src/money/payments/wallet-payment.service';
import { SchoolEnrolmentService } from '../../src/schools/enrolment/school-enrolment.service';
import { SchoolsPublicModule } from '../../src/schools/schools-public.module';
import { FintavaDouble, MERCHANT_ACCOUNT } from '../fintava/fintava-double';
import { mintToken, QuietLogger } from '../payments/poll-helpers';
import { installFintava, PIN, Wallets } from '../plans/tier-purchase-harness';
import { WALLET_PROVIDER } from '../../src/wallet-provider/wallet-provider.interface';
import {
  NuvionHarnessRig,
  runsOnFintavaDouble,
} from '../nuvion/harness-wallets';

/**
 * SCHOOLS-07's stand-ins: the real Hub modules for money and schools, a real
 * database, real RS256 tokens for the stand-in WAWU ID, and
 * WALLET_PROVIDER=nuvion with Nuvion stood in at the seam (HARNESS-NUV, 17 Oct
 * 2026: `test/nuvion/harness-wallets.ts` says how `h.wallets` and `h.double`
 * are served); a spec on FINTAVA_BOUND_SPECS still gets the real Fintava
 * client over a socket to FintavaDouble (the tier harness's book of wallets).
 * No provider and no wawuafrica.com host is called.
 */

export { PIN };

export interface Person {
  id: string;
  auth: string;
  walletId: string;
  accountNumber: string;
}

export interface SeededClass {
  schoolId: string;
  courseId: string;
  /** In the order given, soonest first. */
  intakeIds: string[];
}

export interface SchoolHarness {
  app: INestApplication<App>;
  prisma: PrismaService;
  payments: WalletPaymentService;
  holds: WalletHoldService;
  enrolments: SchoolEnrolmentService;
  registry: PayableRegistry;
  double: FintavaDouble;
  wallets: Wallets;
  logger: QuietLogger;
  users: string[];
  buyer(kobo: number): Promise<Person>;
  walletless(): Person;
  /** A school with one course and these intakes (capacity, start date, optional hidden). */
  seed(opts: {
    priceKobo: number;
    intakes: Array<{
      capacity: number;
      startDate: string;
      hidden?: boolean;
    }>;
    title?: string;
    schoolName?: string;
  }): Promise<SeededClass>;
  /** Runs the payment sweep as if `ms` more had passed since the last call. */
  sweepLater(ms?: number): ReturnType<WalletPaymentService['sweep']>;
  close(): Promise<void>;
}

export async function bootSchoolApp(
  tag: string,
  extraEnv: Record<string, string> = {},
): Promise<SchoolHarness> {
  const cheapPinHash = await argon2.hash(PIN, {
    type: argon2.argon2id,
    timeCost: 1,
    memoryCost: 1024,
    parallelism: 1,
  });
  const nuv = runsOnFintavaDouble() ? null : new NuvionHarnessRig();
  const fintava = nuv ? null : new FintavaDouble();
  if (fintava) await fintava.start();
  const double = nuv ? nuv.double : fintava!;
  const logger = new QuietLogger();
  const wallets = nuv ? nuv.wallets : new Wallets();
  const previous: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    ...(fintava
      ? {
          FINTAVA_BASE_URL: fintava.baseUrl,
          FINTAVA_API_KEY: `live_test_${tag}_0123456789FAKEKEY`,
          FINTAVA_TIMEOUT_MS: '120000',
          FINTAVA_MONEY_TIMEOUT_MS: '120000',
          FINTAVA_CHECK_TIMEOUT_MS: '120000',
        }
      : nuv!.env),
    FEE_QUOTE_KEY: `${tag}-test-fee-quote-key-0123456789abcdef0123`,
    MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
    PIN_LOCK_MINUTES: '',
    IDEMPOTENCY_KEY_HOURS: '',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  if (fintava) installFintava(fintava, wallets);
  wallets.kobo.set(MERCHANT_ACCOUNT, 5_000_000_000);
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      MoneyModule,
      SchoolsPublicModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  });
  if (nuv)
    builder = builder.overrideProvider(WALLET_PROVIDER).useValue(nuv.standin);
  const moduleRef = await builder.setLogger(logger).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>({
    ...HUB_APP_OPTIONS,
    logger,
  });
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
  const prisma = moduleRef.get(PrismaService);
  const payments = moduleRef.get(WalletPaymentService);
  const users: string[] = [];
  const schools: string[] = [];
  let accountSeq = 0;
  let clock = Date.now();

  return {
    app,
    prisma,
    payments,
    holds: moduleRef.get(WalletHoldService),
    enrolments: moduleRef.get(SchoolEnrolmentService, { strict: false }),
    registry: moduleRef.get(PayableRegistry),
    double,
    wallets,
    logger,
    users,
    async buyer(kobo) {
      const id = randomUUID();
      users.push(id);
      accountSeq += 1;
      const accountNumber = `42${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
      if (nuv) {
        // An approved Nuvion account holding `kobo`, as NUV-04 records it.
        const account = nuv.openAccount(kobo, accountNumber);
        await prisma.fintavaWallet.create({
          data: {
            wawuUserId: id,
            customerId: account.entityId,
            walletId: account.accountId,
            accountNumber,
            provider: 'nuvion',
          },
        });
        await prisma.transactionPin.create({
          data: { wawuUserId: id, pinHash: cheapPinHash },
        });
        return {
          id,
          auth: `Bearer ${mintToken(id, tag)}`,
          walletId: account.accountId,
          accountNumber,
        };
      }
      const walletId = randomUUID();
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id,
          customerId: randomUUID(),
          walletId,
          accountNumber,
        },
      });
      wallets.kobo.set(accountNumber, kobo);
      wallets.byId.set(walletId, accountNumber);
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: cheapPinHash },
      });
      return {
        id,
        auth: `Bearer ${mintToken(id, tag)}`,
        walletId,
        accountNumber,
      };
    },
    walletless() {
      const id = randomUUID();
      users.push(id);
      return {
        id,
        auth: `Bearer ${mintToken(id, tag)}`,
        walletId: '',
        accountNumber: '',
      };
    },
    async seed(opts) {
      const school = await prisma.school.create({
        data: {
          name: opts.schoolName ?? `Greenfield Tech Academy ${tag}`,
          category: 'tech',
          location: 'Yaba, Lagos',
          about: 'A test school.',
          reportEmail: 'report@school.test',
          courses: {
            create: {
              title: opts.title ?? 'Product Design',
              weeks: 12,
              mode: 'in_person',
              syllabus: ['One'],
              outcomes: ['Certificate'],
              priceKobo: opts.priceKobo,
            },
          },
        },
        include: { courses: true },
      });
      schools.push(school.id);
      const course = school.courses[0];
      const intakeIds: string[] = [];
      for (const i of opts.intakes) {
        const row = await prisma.courseIntake.create({
          data: {
            courseId: course.id,
            startDate: new Date(`${i.startDate}T00:00:00.000Z`),
            schedule: 'Weekend class',
            location: 'Yaba',
            capacity: i.capacity,
            hiddenAt: i.hidden ? new Date() : null,
          },
        });
        intakeIds.push(row.id);
      }
      return { schoolId: school.id, courseId: course.id, intakeIds };
    },
    sweepLater(ms = 2 * 60_000) {
      clock = Math.max(clock, Date.now()) + ms;
      return payments.sweep(new Date(clock));
    },
    async close() {
      const rows = await prisma.walletPayment.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { customerReference: true },
      });
      const holds = await prisma.walletHold.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          customerReference: {
            in: [
              ...rows.map((r) => r.customerReference),
              ...holds.flatMap((h) =>
                h.customerReference ? [h.customerReference] : [],
              ),
            ],
          },
        },
      });
      await prisma.walletHold.deleteMany({
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.walletPayment.deleteMany({
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.schoolEnrolment.deleteMany({
        where: { schoolId: { in: schools } },
      });
      await prisma.school.deleteMany({ where: { id: { in: schools } } });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await app.close();
      await fintava?.stop();
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** The routes, as the app calls them. */
export const api = (h: SchoolHarness) => ({
  enrol: (p: Person, body: Record<string, unknown>) =>
    request(h.app.getHttpServer())
      .post('/api/hub/schools/enrolments')
      .set('Authorization', p.auth)
      .send(body),
  read: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/schools/enrolments/${id}`)
      .set('Authorization', p.auth),
  quote: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get('/api/hub/money/payments/quote')
      .query({ kind: 'school_fee', targetId: id })
      .set('Authorization', p.auth),
  pay: (
    p: Person,
    body: Record<string, unknown>,
    opts: { key?: string; pin?: string | null } = {},
  ) => {
    const req = request(h.app.getHttpServer())
      .post('/api/hub/money/payments')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.pin !== null) req.set('X-Transaction-Pin', opts.pin ?? PIN);
    return req.send(body);
  },
  payment: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/money/payments/${id}`)
      .set('Authorization', p.auth),
  course: (id: string) =>
    request(h.app.getHttpServer()).get(`/api/hub/schools/courses/${id}`),
});
