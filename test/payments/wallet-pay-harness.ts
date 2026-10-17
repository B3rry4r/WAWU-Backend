import { randomUUID } from 'node:crypto';
import {
  type INestApplication,
  type Type,
  ValidationPipe,
} from '@nestjs/common';
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
import { EarningSettlementService } from '../../src/money/earnings/earning-settlement.service';
import { WalletHoldService } from '../../src/money/holds/wallet-hold.service';
import { MoneyModule } from '../../src/money/money.module';
import { WalletPaymentService } from '../../src/money/payments/wallet-payment.service';
import { WALLET_PROVIDER } from '../../src/wallet-provider/wallet-provider.interface';
import { type NuvionAccount, NuvionSeamStandIn } from './nuvion-seam-standin';
import { mintToken, QuietLogger } from './poll-helpers';

/**
 * The one harness the pay-from-wallet specs of bundle B1 share (HOME-14
 * tips, HOME-15 unlocks, LEGAL-05 legal fees; WALLET-16's start time): the
 * real MoneyModule and the feature's own module on a real database, with the
 * wallet provider seam on the NUVION stand-in. No Fintava, Nuvion or
 * wawuafrica.com host is called: the Fintava settings point at a socket that
 * counts what reaches it, and a spec can assert it stayed at nothing.
 */

export const PAY_PIN = '4826';
/** What the stand-in charges on a book transfer, in kobo (a spec value, not a fact about Nuvion). */
export const STAND_IN_FEE_KOBO = 2325;

export interface PayPerson {
  id: string;
  auth: string;
  account: NuvionAccount | null;
  /** What the person's account held when it was opened, in kobo. */
  opening: bigint;
}

export interface PayHarness {
  app: INestApplication<App>;
  prisma: PrismaService;
  nuvion: NuvionSeamStandIn;
  payments: WalletPaymentService;
  holds: WalletHoldService;
  earnings: EarningSettlementService;
  logger: QuietLogger;
  users: string[];
  /** A person with an open wallet holding `kobo`, a PIN and a token. */
  person(kobo: number): Promise<PayPerson>;
  /** A signed-in person with no wallet. */
  walletless(): PayPerson;
  /** Runs the payment, hold and earning sweeps as if `ms` more had passed. */
  pass(ms?: number): Promise<void>;
  get(p: PayPerson, url: string): request.Test;
  post(
    p: PayPerson,
    url: string,
    body: Record<string, unknown>,
    opts?: { key?: string; pin?: string | null },
  ): request.Test;
  /**
   * The ledger agrees with the stand-in: for every person given, the stand-in
   * account holds what the account opened with, plus the ledger's completed
   * money in, minus its completed money out (the total, charge included).
   * WAWU's own account is checked by the spec that moves it, by exact figures.
   */
  expectLedgerEqualsStandIn(people: PayPerson[]): Promise<void>;
  /** Pieces of the stand-in's send history of one person. */
  sendsFrom(p: PayPerson): ReturnType<NuvionSeamStandIn['sendsFrom']>;
  /** Anything that reached the Fintava socket. */
  fintavaHits: string[];
  close(): Promise<void>;
}

export interface PayBootOptions {
  /** More settings for the Hub. */
  env?: Record<string, string>;
  /** Feature modules, mounted beside MoneyModule. */
  modules: Type[];
  /** Registers things on the booted app (a payable kind for a harness-only feature). */
  extra?: (app: INestApplication<App>) => void | Promise<void>;
  /** Tables to clear for the people created, once their payments are gone. */
  cleanup?: (prisma: PrismaService, users: string[]) => Promise<void>;
}

export async function bootPayApp(
  tag: string,
  opts: PayBootOptions,
): Promise<PayHarness> {
  const { createServer } = await import('node:http');
  const cheapPinHash = await argon2.hash(PAY_PIN, {
    type: argon2.argon2id,
    timeCost: 1,
    memoryCost: 1024,
    parallelism: 1,
  });
  const nuvion = new NuvionSeamStandIn();
  nuvion.feeKobo = () => BigInt(STAND_IN_FEE_KOBO);
  nuvion.mode = 'successful';
  nuvion.operational.availableKobo = 50_000_000n;
  const logger = new QuietLogger();
  const fintavaHits: string[] = [];
  const counter = createServer((req, res) => {
    fintavaHits.push(`${req.method} ${req.url}`);
    res.statusCode = 503;
    res.end('{}');
  });
  await new Promise<void>((r) => counter.listen(0, '127.0.0.1', () => r()));
  const port = (counter.address() as { port: number }).port;
  const previous: Record<string, string | undefined> = {};
  const env: Record<string, string> = {
    FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
    FINTAVA_API_KEY: `live_test_${tag}_0123456789FAKEKEY`,
    FEE_QUOTE_KEY: `${tag}-test-fee-quote-key-0123456789abcdef0123`,
    MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
    NUVION_FEE_BOOK_TRANSFER: String(STAND_IN_FEE_KOBO),
    NUVION_FEE_BANK_PAYOUT: String(STAND_IN_FEE_KOBO),
    NUVION_FEE_INFLOW: String(STAND_IN_FEE_KOBO),
    WAWU_LIMIT_PURCHASE_DAILY_KOBO: '100000000',
    PIN_LOCK_MINUTES: '',
    IDEMPOTENCY_KEY_HOURS: '',
    PAYMENT_REVIEW_AFTER_HOURS: '',
    EARNINGS_SWEEP_START: '',
    ...opts.env,
  };
  for (const [k, v] of Object.entries(env)) {
    previous[k] = process.env[k];
    process.env[k] = v;
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
      PrismaModule,
      MoneyModule,
      ...opts.modules,
    ],
    providers: [WawuJwtStrategy, WawuIdClient],
  })
    .overrideProvider(WALLET_PROVIDER)
    .useValue(nuvion)
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
  if (opts.extra) await opts.extra(app);
  const prisma = moduleRef.get(PrismaService);
  const payments = moduleRef.get(WalletPaymentService);
  const holds = moduleRef.get(WalletHoldService);
  const earnings = moduleRef.get(EarningSettlementService);
  const users: string[] = [];
  const accountNumbers: string[] = [];
  let accountSeq = 0;
  let clock = Date.now();

  const harness: PayHarness = {
    app,
    prisma,
    nuvion,
    payments,
    holds,
    earnings,
    logger,
    users,
    fintavaHits,
    async person(kobo) {
      const id = randomUUID();
      users.push(id);
      accountSeq += 1;
      const accountNumber = `71${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
      accountNumbers.push(accountNumber);
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: cheapPinHash },
      });
      const account = nuvion.openAccount(BigInt(kobo), accountNumber);
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
        account,
        opening: BigInt(kobo),
      };
    },
    walletless() {
      const id = randomUUID();
      users.push(id);
      return {
        id,
        auth: `Bearer ${mintToken(id, tag)}`,
        account: null,
        opening: 0n,
      };
    },
    async pass(ms = 2 * 60_000) {
      clock = Math.max(clock, Date.now()) + ms;
      const at = new Date(clock);
      await payments.sweep(at);
      await holds.sweep(at);
      await earnings.sweep(at);
    },
    get: (p, url) =>
      request(app.getHttpServer())
        .get(`/api/hub${url}`)
        .set('Authorization', p.auth),
    post(p, url, payload, o = {}) {
      const req = request(app.getHttpServer())
        .post(`/api/hub${url}`)
        .set('Authorization', p.auth)
        .set('Idempotency-Key', o.key ?? randomUUID());
      if (o.pin !== null) req.set('X-Transaction-Pin', o.pin ?? PAY_PIN);
      return req.send(payload);
    },
    sendsFrom: (p) => nuvion.sendsFrom(p.account!.accountId),
    async expectLedgerEqualsStandIn(people) {
      for (const p of people) {
        if (!p.account) continue;
        const rows = await prisma.fintavaLedgerEntry.findMany({
          where: {
            accountNumber: p.account.accountNumber!,
            status: 'completed',
          },
          select: { direction: true, amountKobo: true, totalKobo: true },
        });
        let held = p.opening;
        for (const r of rows)
          held += r.direction === 'in' ? r.amountKobo : -r.totalKobo;
        expect({
          who: 'person',
          standIn: nuvion.accounts.get(p.account.accountId)!.availableKobo,
        }).toEqual({ who: 'person', standIn: held });
      }
    },
    async close() {
      const payRows = await prisma.walletPayment.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { payeeWawuUserId: { in: users } },
          ],
        },
        select: { id: true, customerReference: true },
      });
      const ids = payRows.map((r) => r.id);
      const holdRows = await prisma.walletHold.findMany({
        where: { paymentId: { in: ids } },
        select: { id: true, customerReference: true },
      });
      const earningRows = await prisma.earningSettlement.findMany({
        where: { paymentId: { in: ids } },
        select: { customerReference: true },
      });
      // The creator's move of the day (R-55) is the transfer the provider
      // and the ledger know; its earnings are the rows above.
      const moveRows = await prisma.earningMove.findMany({
        where: { payeeWawuUserId: { in: users } },
        select: { customerReference: true },
      });
      const refs = [
        ...payRows.map((r) => r.customerReference),
        ...holdRows.flatMap((r) =>
          r.customerReference ? [r.customerReference] : [],
        ),
        ...earningRows.map((r) => r.customerReference),
        ...moveRows.map((r) => r.customerReference),
      ];
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: refs } },
            { accountNumber: { in: accountNumbers } },
          ],
        },
      });
      await prisma.earningSettlement.deleteMany({
        where: { paymentId: { in: ids } },
      });
      await prisma.earningMove.deleteMany({
        where: { payeeWawuUserId: { in: users } },
      });
      await prisma.walletHold.deleteMany({ where: { paymentId: { in: ids } } });
      if (opts.cleanup) await opts.cleanup(prisma, users);
      await prisma.walletPayment.deleteMany({ where: { id: { in: ids } } });
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
      await new Promise<void>((r) => counter.close(() => r()));
      for (const [k, v] of Object.entries(previous)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
  return harness;
}
