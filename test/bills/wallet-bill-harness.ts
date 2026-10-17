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
import { WalletPaymentService } from '../../src/money/payments/wallet-payment.service';
import { WalletBillsModule } from '../../src/wallet-bills/wallet-bills.module';
import {
  FintavaDouble,
  fintavaError,
  historyRow,
  merchantHistory,
  MERCHANT_ACCOUNT,
  type SeenRequest,
} from '../fintava/fintava-double';
import { mintToken, QuietLogger } from '../payments/poll-helpers';
import { installFintava, PIN, Wallets } from '../plans/tier-purchase-harness';
import { SANDBOX_DISCOS } from './sandbox-discos';

/**
 * BILLS-04's stand-ins: the real Hub modules for money and bills, a real
 * database, real RS256 tokens for the stand-in WAWU ID, and the real Fintava
 * client over a socket to FintavaDouble. The double keeps a small book of
 * wallets (the tier harness's) and answers the bill calls as `mode` says.
 * Fintava's bill purchase answers were never seen in the sandbox (question 17
 * in docs/fintava/naira-api.md), so every success body here is a labelled
 * guess; the refusals are the sandbox's own words.
 */

export { PIN };

/** What a bill purchase at the double does next. */
export interface BillBook {
  /** `ok`: delivers; `refuse`: "Unable to find customers"; `unavailable`: a 2xx "service not currently available"; `lost`: takes it and drops the connection; `gateway`: a 504 and nothing bought. */
  mode: 'ok' | 'refuse' | 'unavailable' | 'lost' | 'gateway';
  /** `unknown`: the meter check answers Fintava's bare 400 "Http Exception" (S10). */
  meter: 'found' | 'unknown';
  /** Fintava takes this long to answer a purchase (a spec that needs two callers at once). */
  delayMs: number;
  purchases: Array<{
    path: string;
    body: Record<string, unknown>;
    amountKobo: number;
  }>;
  /** What the merchant history answers: rows added by a spec. */
  history: unknown[];
}

/** A guess at Fintava's electricity success body: the token and units are where the record keeps them (`metertoken`). */
export const TOKEN = '48210937551022867734';
export const UNITS = '45.2';

export function installBills(
  double: FintavaDouble,
  wallets: Wallets,
): BillBook {
  const book: BillBook = {
    mode: 'ok',
    meter: 'found',
    delayMs: 0,
    purchases: [],
    history: [],
  };
  double.on('GET', '/billing/discos', { status: 200, body: SANDBOX_DISCOS });
  double.on('POST', '/billing/preview-meter', () =>
    book.meter === 'unknown'
      ? { status: 400, body: fintavaError(400, 'Http Exception') }
      : {
          status: 200,
          body: {
            data: {
              Customer_Name: 'Chidinma Okoro',
              Address: '14 Admiralty Way',
            },
            status: 200,
            message: 'Meter details fetched',
          },
        },
  );
  double.on('GET', '/billing/data-bundles/MTN', {
    status: 200,
    body: {
      data: [
        {
          id: 'x1',
          code: '30',
          title: 'MTN 1.5GB Monthly',
          price: '1000',
          validity: '30 days',
        },
      ],
      status: 200,
      message: 'Provider bundles fetched',
    },
  });
  double.on('GET', '/cable-service-name/DSTV', {
    status: 200,
    body: {
      data: [
        {
          id: 'p1',
          title: 'DStv Compact',
          network: 'DSTV',
          price: '15700',
          code: 'COMPACT',
          available: 'Yes',
        },
      ],
      status: 200,
      message: 'Cable subscriptions fetched',
    },
  });
  double.on('GET', '/txn/merchant', () => ({
    status: 200,
    body: merchantHistory(book.history),
  }));
  const purchase = (
    path: string,
    amountOf: (b: Record<string, unknown>) => number,
  ) =>
    double.on('POST', path, (req: SeenRequest) => {
      const b = req.body as Record<string, unknown>;
      const amountKobo = amountOf(b);
      if (book.mode === 'refuse') {
        return {
          status: 400,
          body: fintavaError(400, 'Unable to find customers'),
        };
      }
      if (book.mode === 'gateway') {
        return {
          status: 504,
          body: 'gateway timeout',
          contentType: 'text/plain',
        };
      }
      if (book.mode === 'unavailable') {
        return {
          status: 201,
          body: { status: 200, message: 'service not currently available' },
        };
      }
      // The merchant's wallet pays the biller (the amount) and Fintava's bill charge.
      const have = wallets.kobo.get(MERCHANT_ACCOUNT) ?? 0;
      wallets.kobo.set(MERCHANT_ACCOUNT, have - amountKobo);
      book.purchases.push({ path, body: b, amountKobo });
      return {
        status: 200,
        hangUp: book.mode === 'lost',
        delayMs: book.delayMs,
        body: {
          data: {
            id: randomUUID(),
            reference: randomUUID(),
            amount: amountKobo / 100,
            metertoken: path.endsWith('electricity') ? TOKEN : null,
            units: path.endsWith('electricity') ? UNITS : null,
          },
          status: 200,
          message: 'successful',
        },
      };
    });
  purchase('/billing/electricity', (b) => Math.round(Number(b.amount) * 100));
  purchase('/billing/airtime', (b) => Math.round(Number(b.vtu_amount) * 100));
  purchase('/billing/data-bundle', () => 100_000);
  purchase('/billing/cable-subscription', () => 1_570_000);
  return book;
}

/**
 * A merchant history row for one purchase, as Fintava would list it. Every
 * row has an id and a reference of its own (a record settles at most one
 * bill, so rows that share them would not be told apart).
 */
export function purchaseRow(over: Record<string, unknown>) {
  return historyRow({
    id: randomUUID(),
    reference: randomUUID(),
    transType: 'ELECTRICITY',
    entry: 'DEBIT',
    status: 'SUCCESS',
    createdAt: new Date().toISOString(),
    ...over,
  });
}

export interface Person {
  id: string;
  auth: string;
  walletId: string;
  accountNumber: string;
}

export interface BillHarness {
  app: INestApplication<App>;
  prisma: PrismaService;
  payments: WalletPaymentService;
  holds: WalletHoldService;
  double: FintavaDouble;
  wallets: Wallets;
  book: BillBook;
  logger: QuietLogger;
  users: string[];
  buyer(kobo: number): Promise<Person>;
  walletless(): Person;
  /** Runs the payment sweep as if `ms` more had passed since the last call. */
  sweepLater(ms?: number): ReturnType<WalletPaymentService['sweep']>;
  close(): Promise<void>;
}

export async function bootBillApp(
  tag: string,
  extraEnv: Record<string, string> = {},
): Promise<BillHarness> {
  const cheapPinHash = await argon2.hash(PIN, {
    type: argon2.argon2id,
    timeCost: 1,
    memoryCost: 1024,
    parallelism: 1,
  });
  const double = new FintavaDouble();
  await double.start();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const previous: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    FINTAVA_BASE_URL: double.baseUrl,
    FINTAVA_API_KEY: `live_test_${tag}_0123456789FAKEKEY`,
    FINTAVA_TIMEOUT_MS: '120000',
    FINTAVA_MONEY_TIMEOUT_MS: '120000',
    FINTAVA_CHECK_TIMEOUT_MS: '120000',
    FEE_QUOTE_KEY: `${tag}-test-fee-quote-key-0123456789abcdef0123`,
    MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
    BILLS_CATALOGUE_CACHE_SECONDS: '0',
    BILLS_PREVIEW_PER_MINUTE: '600',
    PIN_LOCK_MINUTES: '',
    IDEMPOTENCY_KEY_HOURS: '',
    ...extraEnv,
  };
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  installFintava(double, wallets);
  wallets.kobo.set(MERCHANT_ACCOUNT, 5_000_000_000);
  const book = installBills(double, wallets);
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      MoneyModule,
      WalletBillsModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  })
    .setLogger(logger)
    .compile();
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
  let accountSeq = 0;
  let clock = Date.now();

  return {
    app,
    prisma,
    payments,
    holds: moduleRef.get(WalletHoldService),
    double,
    wallets,
    book,
    logger,
    users,
    async buyer(kobo) {
      const id = randomUUID();
      users.push(id);
      accountSeq += 1;
      const accountNumber = `41${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
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
      const bills = await prisma.walletBill.findMany({
        where: { wawuUserId: { in: users } },
        select: { id: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          customerReference: {
            in: [
              ...bills.map((b) => `wawu-bill-${b.id}`),
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
      await prisma.walletBill.deleteMany({
        where: { wawuUserId: { in: users } },
      });
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
      await double.stop();
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** The routes, as the app calls them. */
export const api = (h: BillHarness) => ({
  create: (p: Person, body: Record<string, unknown>) =>
    request(h.app.getHttpServer())
      .post('/api/hub/bills/wallet')
      .set('Authorization', p.auth)
      .send(body),
  quote: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/bills/wallet/${id}/quote`)
      .set('Authorization', p.auth),
  pay: (
    p: Person,
    body: Record<string, unknown>,
    opts: { key?: string; pin?: string | null } = {},
  ) => {
    const req = request(h.app.getHttpServer())
      .post('/api/hub/bills/wallet/pay')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.pin !== null) req.set('X-Transaction-Pin', opts.pin ?? PIN);
    return req.send(body);
  },
  read: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/bills/wallet/${id}`)
      .set('Authorization', p.auth),
});
