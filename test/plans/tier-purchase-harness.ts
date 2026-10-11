import { createHash, randomUUID } from 'node:crypto';
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
import { MoneyModule } from '../../src/money/money.module';
import { PayableRegistry } from '../../src/money/payments/payable-registry';
import { WalletPaymentService } from '../../src/money/payments/wallet-payment.service';
import { PlanPurchasesModule } from '../../src/plans/purchases/plan-purchases.module';
import { PlansModule } from '../../src/plans/plans.module';
import { purgePersonPoints } from '../../src/points/points-purge';
import {
  customerHistory,
  FintavaDouble,
  fintavaError,
  MERCHANT_BALANCE,
  recordByReference,
  type SeenRequest,
} from '../fintava/fintava-double';
import { WALLET_PROVIDER } from '../../src/wallet-provider/wallet-provider.interface';
import {
  type NuvionAccount,
  type NuvionSeamStandIn,
} from '../payments/nuvion-seam-standin';
import { mintToken, QuietLogger } from '../payments/poll-helpers';

/**
 * TIER-03's stand-ins in one place: the real Hub modules for money, plans and
 * points, a real database, real RS256 tokens for the stand-in WAWU ID, and
 * the real MONEY-06 Fintava client over a socket to FintavaDouble (the
 * sandbox's own bodies) with a small book of wallets behind it. No Fintava,
 * Nuvion or wawuafrica.com host is called.
 */

export const PIN = '4826';
/** The dashboard's balance-transfer charge (docs/fintava/fees.md), in kobo. */
export const liveFee = (amountKobo: number) =>
  amountKobo < 500_000 ? 2325 : 1575;

/** Fintava's record by our reference, with the ids that belong to ONE transfer. */
export function recordFor(
  ourReference: string,
  status: string,
  amount: string,
) {
  const record = recordByReference(ourReference, status, amount);
  const h = createHash('sha256').update(ourReference).digest('hex');
  const uuid = (o: number) =>
    `${h.slice(o, o + 8)}-${h.slice(o + 8, o + 12)}-4${h.slice(o + 12, o + 15)}-8${h.slice(o + 15, o + 18)}-${h.slice(o + 18, o + 30)}`;
  return {
    ...record,
    data: {
      ...record.data,
      id: uuid(0),
      reference: uuid(2),
      sessionId: `09062026${BigInt(`0x${h.slice(0, 15)}`)
        .toString()
        .slice(0, 22)}`,
    },
  };
}

/** Fintava's wallets, as the double keeps them. */
export class Wallets {
  readonly kobo = new Map<string, number>();
  readonly byId = new Map<string, string>();
  readonly references = new Set<string>();
  readonly sends: Array<{
    from: string;
    to: string;
    amountKobo: number;
    feeKobo: number;
    reference: string;
  }> = [];
  /** `live`: answers; `timeout`: takes the transfer and drops the connection. */
  mode: 'live' | 'timeout' = 'live';
  /** References Fintava's lookup does not show yet (its record lags). */
  readonly hidden = new Set<string>();
  /** References Fintava reports as FAILURE. */
  readonly failures = new Set<string>();
}

export function installFintava(double: FintavaDouble, wallets: Wallets): void {
  double.reset();
  double.on('GET', '/merchant/balance', {
    status: 200,
    body: MERCHANT_BALANCE,
  });
  double.on('GET', /^\/customer\/wallet\/balance\//, (req: SeenRequest) => {
    const account = wallets.byId.get(req.path.split('/').pop()!);
    if (!account) {
      return { status: 400, body: fintavaError(400, 'Wallet not found') };
    }
    const naira = (wallets.kobo.get(account) ?? 0) / 100;
    return {
      status: 200,
      body: {
        data: {
          balance: { bookedBalance: naira, availableBalance: naira },
          tier: 'TIER_2',
        },
        status: 200,
        message: 'Wallet details fetched',
      },
    };
  });
  double.on('GET', /^\/transaction\/reference\//, (req: SeenRequest) => {
    const ref = decodeURIComponent(
      req.path.replace('/transaction/reference/', ''),
    );
    const send = wallets.sends.find((x) => x.reference === ref);
    if (!send || wallets.hidden.has(ref)) {
      return { status: 404, body: fintavaError(404, 'Transaction not found!') };
    }
    return {
      status: 200,
      body: recordFor(
        ref,
        wallets.failures.has(ref) ? 'FAILURE' : 'SUCCESS',
        (send.amountKobo / 100).toFixed(2),
      ),
    };
  });
  double.on('GET', '/txn', { status: 200, body: customerHistory([]) });
  double.on('POST', '/transaction/wallet-to-wallet', (req: SeenRequest) => {
    const b = req.body as {
      senderAccount: string;
      receiverAccount: string;
      amount: number;
      CustomerReference: string;
    };
    if (wallets.references.has(b.CustomerReference)) {
      return {
        status: 400,
        body: fintavaError(400, 'customerReference already exists'),
      };
    }
    const amountKobo = Math.round(b.amount * 100);
    const feeKobo = liveFee(amountKobo);
    const have = wallets.kobo.get(b.senderAccount) ?? 0;
    if (have < amountKobo + feeKobo) {
      return {
        status: 400,
        body: fintavaError(
          400,
          'Insufficient balance on source wallet to complete this transfer.',
        ),
      };
    }
    // The money moves when Fintava takes the request, whether or not the
    // answer reaches the caller.
    wallets.references.add(b.CustomerReference);
    wallets.kobo.set(b.senderAccount, have - amountKobo - feeKobo);
    wallets.kobo.set(
      b.receiverAccount,
      (wallets.kobo.get(b.receiverAccount) ?? 0) + amountKobo,
    );
    wallets.sends.push({
      from: b.senderAccount,
      to: b.receiverAccount,
      amountKobo,
      feeKobo,
      reference: b.CustomerReference,
    });
    const after = (have - amountKobo - feeKobo) / 100;
    return {
      status: 200,
      hangUp: wallets.mode === 'timeout',
      body: {
        data: {
          amount: amountKobo / 100,
          reference: `tagapay${randomUUID().replace(/-/g, '')}`,
          customerReference: randomUUID(),
          total: (amountKobo + feeKobo) / 100,
          transaction_fee: feeKobo / 100,
          source_customer_id: randomUUID(),
          source_customer_accname: 'Tier Tester',
          source_customer_accno: b.senderAccount,
          source_customer_wallet: b.senderAccount,
          source_availableBalance: after,
          source_bookedBalance: after,
          description: 'Fund transfer between customers',
        },
        status: 200,
        message: 'successful',
      },
    };
  });
}

export interface Person {
  id: string;
  auth: string;
  walletId: string;
  accountNumber: string;
  /** The person's account at the Nuvion stand-in, when one is booted. */
  account?: NuvionAccount;
}

export interface BootOptions {
  /** Run the wallet provider seam on this Nuvion stand-in instead of the Fintava double. */
  nuvion?: NuvionSeamStandIn;
  /** The fee Nuvion's settings charge on a book transfer, in kobo (a spec value). */
  nuvionFeeKobo?: number;
}

export interface TierHarness {
  app: INestApplication<App>;
  prisma: PrismaService;
  payments: WalletPaymentService;
  registry: PayableRegistry;
  double: FintavaDouble;
  wallets: Wallets;
  logger: QuietLogger;
  users: string[];
  /** Any provider of the booted modules. */
  get<T>(token: abstract new (...args: never[]) => T): T;
  /** A person with an open wallet holding `kobo`, a PIN and a token. */
  buyer(kobo: number): Promise<Person>;
  /** A signed-in person with no wallet. */
  walletless(): Promise<Person>;
  /** Runs the payment sweep as if `ms` more had passed since the last call. */
  sweepLater(ms?: number): ReturnType<WalletPaymentService['sweep']>;
  close(): Promise<void>;
}

/** Boots the stand-ins; call from `beforeAll`, and `close()` from `afterAll`. */
export async function bootTierApp(
  tag: string,
  opts: BootOptions = {},
): Promise<TierHarness> {
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
      PlansModule,
      PlanPurchasesModule,
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

  const harness: TierHarness = {
    app,
    prisma,
    payments,
    registry: moduleRef.get(PayableRegistry),
    double,
    wallets,
    logger,
    users,
    get: (token) => moduleRef.get(token, { strict: false }),
    async buyer(kobo) {
      const id = randomUUID();
      users.push(id);
      accountSeq += 1;
      const accountNumber = `31${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
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
        await prisma.transactionPin.create({
          data: { wawuUserId: id, pinHash: cheapPinHash },
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
      await prisma.makerPurchase.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.eventPass.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.makerTier.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.personBilling.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      for (const id of users) await purgePersonPoints(prisma, id);
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
export const api = (h: TierHarness) => ({
  quote: (p: Person, q: { kind: string; tierId: string; bump?: boolean }) => {
    const qs = new URLSearchParams({ kind: q.kind, tierId: q.tierId });
    if (q.bump !== undefined) qs.set('bump', String(q.bump));
    return request(h.app.getHttpServer())
      .get(`/api/hub/plans/purchases/quote?${qs.toString()}`)
      .set('Authorization', p.auth);
  },
  buy: (
    p: Person,
    body: Record<string, unknown>,
    opts: { key?: string; pin?: string | null } = {},
  ) => {
    const req = request(h.app.getHttpServer())
      .post('/api/hub/plans/purchases')
      .set('Authorization', p.auth)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.pin !== null) req.set('X-Transaction-Pin', opts.pin ?? PIN);
    return req.send(body);
  },
  read: (p: Person, id: string) =>
    request(h.app.getHttpServer())
      .get(`/api/hub/plans/purchases/${id}`)
      .set('Authorization', p.auth),
  tier: (p: Person) =>
    request(h.app.getHttpServer())
      .get('/api/hub/me/tier')
      .set('Authorization', p.auth),
  points: (p: Person) =>
    request(h.app.getHttpServer())
      .get('/api/hub/me/points')
      .set('Authorization', p.auth),
});
