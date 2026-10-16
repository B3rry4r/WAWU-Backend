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
import { CreditWalletModule } from '../../src/credit-purchase/wallet/credit-wallet.module';
import { CreditSpendModule } from '../../src/credit-spend/credit-spend.module';
import { CreditsStateModule } from '../../src/credits-state/credits-state.module';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import { MoneyModule } from '../../src/money/money.module';
import { WalletPaymentService } from '../../src/money/payments/wallet-payment.service';
import { WALLET_PROVIDER } from '../../src/wallet-provider/wallet-provider.interface';
import { FintavaDouble } from '../fintava/fintava-double';
import type { NuvionSeamStandIn } from '../payments/nuvion-seam-standin';
import { mintToken, QuietLogger } from '../payments/poll-helpers';
import {
  installFintava,
  type Person,
  PIN,
  Wallets,
} from '../plans/tier-purchase-harness';

/**
 * INBOX-16's stand-ins in one place: the real Hub modules for money and for
 * credits, a real database, real RS256 tokens for the stand-in WAWU ID, and
 * the real MONEY-06 Fintava client over a socket to FintavaDouble (the
 * sandbox's own bodies) with a small book of wallets behind it, the same one
 * TIER-03 uses. No Fintava, Nuvion or wawuafrica.com host is called.
 */

export interface CreditBootOptions {
  /** Run the wallet provider seam on this Nuvion stand-in instead of the Fintava double. */
  nuvion?: NuvionSeamStandIn;
  /** The fee Nuvion's settings charge on a book transfer, in kobo (a spec value). */
  nuvionFeeKobo?: number;
  /** More settings for the Hub, for the one spec that needs them (a daily limit). */
  env?: Record<string, string>;
}

export interface CreditHarness {
  app: INestApplication<App>;
  prisma: PrismaService;
  payments: WalletPaymentService;
  double: FintavaDouble;
  wallets: Wallets;
  logger: QuietLogger;
  users: string[];
  /** A person with an open wallet holding `kobo`, a PIN and a token. */
  buyer(kobo: number): Promise<Person>;
  /** A signed-in person with no wallet. */
  walletless(): Promise<Person>;
  /** Runs the payment sweep as if `ms` more had passed since the last call. */
  sweepLater(ms?: number): ReturnType<WalletPaymentService['sweep']>;
  close(): Promise<void>;
}

/** Boots the stand-ins; call from `beforeAll`, and `close()` from `afterAll`. */
export async function bootCreditApp(
  tag: string,
  opts: CreditBootOptions = {},
): Promise<CreditHarness> {
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
    PIN_LOCK_MINUTES: '',
    IDEMPOTENCY_KEY_HOURS: '',
    ...(opts.nuvion
      ? {
          NUVION_FEE_BOOK_TRANSFER: String(opts.nuvionFeeKobo ?? 0),
          NUVION_FEE_BANK_PAYOUT: String(opts.nuvionFeeKobo ?? 0),
          NUVION_FEE_INFLOW: String(opts.nuvionFeeKobo ?? 0),
          WAWU_LIMIT_PURCHASE_DAILY_KOBO: '100000000',
        }
      : {}),
    ...opts.env,
  };
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  installFintava(double, wallets);
  let builder = Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      MoneyModule,
      CreditsStateModule,
      CreditSpendModule,
      CreditWalletModule,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  });
  if (opts.nuvion)
    builder = builder.overrideProvider(WALLET_PROVIDER).useValue(opts.nuvion);
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
  let accountSeq = 0;
  let clock = Date.now();

  const harness: CreditHarness = {
    app,
    prisma,
    payments,
    double,
    wallets,
    logger,
    users,
    async buyer(kobo) {
      const id = randomUUID();
      users.push(id);
      accountSeq += 1;
      const accountNumber = `32${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: cheapPinHash },
      });
      if (opts.nuvion) {
        // An approved Nuvion account holding `kobo`, as NUV-04 will record it.
        const account = opts.nuvion.openAccount(BigInt(kobo), accountNumber);
        await prisma.fintavaWallet.create({
          data: {
            wawuUserId: id,
            customerId: account.entityId,
            walletId: account.accountId,
            accountNumber,
            provider: 'nuvion',
          },
        });
        return {
          id,
          auth: `Bearer ${mintToken(id, tag)}`,
          walletId: account.accountId,
          accountNumber,
          account,
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
      return Promise.resolve({
        id,
        auth: `Bearer ${mintToken(id, tag)}`,
        walletId: '',
        accountNumber: '',
      });
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
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          customerReference: { in: rows.map((r) => r.customerReference) },
        },
      });
      await prisma.walletHold.deleteMany({
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.walletPayment.deleteMany({
        where: { payerWawuUserId: { in: users } },
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
      // A spend and its earning go with their community (onDelete: Cascade).
      await prisma.community.deleteMany({
        where: { hostWawuId: { in: users } },
      });
      // The lots go with their purchases (onDelete: Cascade).
      await prisma.creditPurchase.deleteMany({
        where: { userWawuId: { in: users } },
      });
      await prisma.creditsState.deleteMany({
        where: { userWawuId: { in: users } },
      });
      await app.close();
      await double.stop();
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
  return harness;
}

/** The routes, as the app calls them. */
export const creditApi = (h: CreditHarness) => ({
  packs: (p: Person) =>
    request(h.app.getHttpServer())
      .get('/api/hub/credits/packs')
      .set('Authorization', p.auth),
  quote: (p: Person, pack: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/credits/purchase/wallet/quote?pack=${pack}`)
      .set('Authorization', p.auth),
  buy: (
    p: Person,
    body: Record<string, unknown>,
    opts: { key?: string; pin?: string | null } = {},
  ) => {
    const req = request(h.app.getHttpServer())
      .post('/api/hub/credits/purchase/wallet')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.pin !== null) req.set('X-Transaction-Pin', opts.pin ?? PIN);
    return req.send(body);
  },
  read: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/credits/purchase/wallet/${id}`)
      .set('Authorization', p.auth),
  credits: (p: Person) =>
    request(h.app.getHttpServer())
      .get('/api/hub/credits')
      .set('Authorization', p.auth),
  history: (p: Person) =>
    request(h.app.getHttpServer())
      .get('/api/hub/money/transactions')
      .set('Authorization', p.auth),
});
