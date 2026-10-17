import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  type NuvionAccount,
  NuvionSeamStandIn,
} from '../../../../test/payments/nuvion-seam-standin';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { FeeQuoteService } from '../../fees/fee-quote.service';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type {
  EarningsView,
  PaymentQuoteView,
  PaymentView,
} from '../../money-view.type';
import { PayableRegistry } from '../../payments/payable-registry';
import { PaymentSettings } from '../../payments/payment-config';
import { moveReference } from '../earning-rules';
import { EarningSettlementService } from '../earning-settlement.service';

/**
 * A sale's 85% lands in the payee's wallet by itself (task WALLET-16, R-11)
 * on the wallet provider seam with NUVION stood in
 * (`test/payments/nuvion-seam-standin.ts`: Nuvion's documented accounts, book
 * transfers answered `pending` first, the fee on top as `applicable_fee`,
 * statuses, error types, no lookup by our reference). WAWU's own account is
 * Nuvion's operational account (its `nuvion_ban`). No Nuvion, Fintava or
 * wawuafrica.com host is called.
 */

const BASE = '/api/hub/money';
const PIN = '5271';
const NUVION_FEES = '0:1500,500000:2500';
const FEE = 1500n;

jest.setTimeout(120_000);

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `earn-nuv-${sub}@test.wawu.dev`,
      phone: '+2348000009917',
      firstName: 'Nuvion',
      lastName: 'Earner',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

class QuietLogger implements LoggerService {
  lines: string[] = [];
  log(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  error(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  warn(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
  debug() {}
  verbose() {}
  fatal(...a: unknown[]) {
    this.lines.push(a.map(String).join(' '));
  }
}

type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response) => res.body as Envelope<T>;

/** The payee's 85%, rounded down to the kobo (R-5), worked out here and not by the code under test. */
const shareOf = (priceKobo: number) => Math.floor((priceKobo * 85) / 100);

describe('Earnings land in the wallet by themselves (WALLET-16), Nuvion stood in', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let earnings: EarningSettlementService;
  let other: EarningSettlementService;
  const nuvion = new NuvionSeamStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const startedAt = new Date();
  const targets = new Map<
    string,
    { priceKobo: number; payee: string | null }
  >();
  const fintavaHits: string[] = [];
  let fintavaCounter: Server;
  let accountSeq = 0;
  let clock = Date.now();
  const later = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  type Person = { id: string; auth: string; account: NuvionAccount | null };

  function mint(): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}`, account: null };
  }

  /** A person with an open Nuvion wallet holding `kobo`. */
  async function openFor(p: Person, kobo: number): Promise<Person> {
    accountSeq += 1;
    const accountNumber = `84${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    p.account = nuvion.openAccount(BigInt(kobo), accountNumber);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: p.id,
        customerId: p.account.entityId,
        walletId: p.account.accountId,
        accountNumber,
        provider: 'nuvion',
      },
    });
    return p;
  }

  async function person(kobo: number, withPin = true): Promise<Person> {
    const p = await openFor(mint(), kobo);
    if (withPin) {
      const set = await request(app.getHttpServer())
        .post(`${BASE}/pin`)
        .set('Authorization', p.auth)
        .send({ pin: PIN, pinConfirmation: PIN });
      expect(set.status).toBe(201);
    }
    return p;
  }

  function listing(payee: Person | null, priceKobo = 200_000): string {
    const id = `unlock-${randomUUID()}`;
    targets.set(id, { priceKobo, payee: payee ? payee.id : null });
    return id;
  }

  /** Pays for an ordinary item (Nuvion answers the payment's book transfer at once). */
  async function sale(
    p: Person,
    kind: 'content_unlock' | 'tip',
    targetId: string,
    amountKobo?: number,
  ): Promise<PaymentView> {
    nuvion.mode = 'successful';
    const qres = await request(app.getHttpServer())
      .get(
        `${BASE}/payments/quote?kind=${kind}&targetId=${targetId}${amountKobo ? `&amountKobo=${amountKobo}` : ''}`,
      )
      .set('Authorization', p.auth);
    expect(qres.status).toBe(200);
    const q = body<PaymentQuoteView>(qres).data!;
    // Nuvion charges what its settings say, which is what the quote says.
    nuvion.feeKobo = () => BigInt(q.fee.providerFeeKobo);
    const res = await request(app.getHttpServer())
      .post(`${BASE}/payments`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send({
        kind: q.kind,
        targetId: q.targetId,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
        ...(amountKobo ? { amountKobo } : {}),
      });
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    // The earning's move: Nuvion's own charge on a book transfer from WAWU's
    // account, and its documented first answer, `pending`.
    nuvion.feeKobo = () => FEE;
    nuvion.mode = 'pending';
    return view;
  }

  const settlementOrThrow = (paymentId: string) =>
    prisma.earningSettlement.findUniqueOrThrow({ where: { paymentId } });
  /**
   * The creator's move of the day (R-55): the one transfer their earnings
   * travel in, which the provider and the ledger know by its reference.
   */
  const moveOf = (p: Person) =>
    prisma.earningMove.findFirstOrThrow({
      where: { payeeWawuUserId: p.id },
      orderBy: { createdAt: 'asc' },
    });
  const transfersOf = (reference: string) =>
    nuvion.transfers.filter((t) => t.request.unique_reference === reference);
  const available = (p: Person) =>
    nuvion.accounts.get(p.account!.accountId)!.availableKobo;
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
  const pass = (ms?: number) => earnings.sweep(later(ms));
  const earningsOf = (p: Person) =>
    request(app.getHttpServer())
      .get(`${BASE}/earnings`)
      .set('Authorization', p.auth);

  beforeAll(async () => {
    fintavaCounter = createServer((req, res) => {
      fintavaHits.push(`${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('{}');
    });
    await new Promise<void>((r) =>
      fintavaCounter.listen(0, '127.0.0.1', () => r()),
    );
    const port = (fintavaCounter.address() as AddressInfo).port;
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_w16_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'w16-nuvion-fee-quote-key-0123456789abcdef01',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: NUVION_FEES,
      NUVION_FEE_BANK_PAYOUT: NUVION_FEES,
      NUVION_FEE_INFLOW: NUVION_FEES,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
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
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(nuvion)
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
    earnings = moduleRef.get(EarningSettlementService);
    // A second process: its own service on the same database and provider.
    other = new EarningSettlementService(
      prisma,
      nuvion,
      moduleRef.get(LedgerService),
      moduleRef.get(FeeQuoteService),
      moduleRef.get(PaymentSettings),
    );

    // WAWU's own money beyond what is held (its shares and fees).
    nuvion.operational.availableKobo = 5_000_000n;

    const registry = moduleRef.get(PayableRegistry);
    for (const kind of ['content_unlock', 'tip'] as const) {
      registry.register({
        kind,
        resolve: async ({ targetId, amountKobo }) => {
          await Promise.resolve();
          const t = targets.get(targetId);
          if (!t) throw new MoneyError('target_not_found', 'That is gone.');
          return {
            title: `A ${kind}`,
            priceKobo:
              kind === 'tip' ? (amountKobo ?? t.priceKobo) : t.priceKobo,
            payee: t.payee
              ? {
                  wawuUserId: t.payee,
                  displayName: 'Chimamanda Adichie',
                  handle: 'chimamanda',
                  avatarUrl: null,
                  tick: 'creator' as const,
                }
              : null,
          };
        },
        onCompleted: async () => {
          await Promise.resolve();
        },
      });
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.earningSettlement.deleteMany({
        where: { createdAt: { gte: startedAt } },
      });
      await prisma.earningMove.deleteMany({
        where: { createdAt: { gte: startedAt } },
      });
      const rows = await prisma.walletPayment.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { payeeWawuUserId: { in: users } },
          ],
        },
        select: { id: true, customerReference: true },
      });
      const ids = rows.map((r) => r.id);
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: rows.map((r) => r.customerReference) } },
            { customerReference: { startsWith: 'wawu-earn-' } },
          ],
        },
      });
      await prisma.earningSettlement.deleteMany({
        where: { paymentId: { in: ids } },
      });
      await prisma.earningMove.deleteMany({
        where: { payeeWawuUserId: { in: users } },
      });
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
    }
    if (app) await app.close();
    await new Promise<void>((r) => fintavaCounter.close(() => r()));
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    nuvion.mode = 'pending';
    nuvion.feeKobo = () => FEE;
  });

  it('check 1: what a creator is shown as earned is the sum of the shares that reached their Nuvion wallet, in the one book transfer of the day', async () => {
    const creator = await person(0, false);
    const buyers = [await person(2_000_000), await person(2_000_000)];
    const unlock = listing(creator, 200_001);
    const tipTarget = listing(creator, 1);
    const pays = [
      await sale(buyers[0], 'content_unlock', unlock),
      await sale(buyers[1], 'content_unlock', unlock),
      await sale(buyers[0], 'tip', tipTarget, 12_345),
    ];
    const expected = shareOf(200_001) * 2 + shareOf(12_345);
    expect(expected).toBe(170_000 * 2 + 10_493);
    const operationalBefore = nuvion.operational.availableKobo;

    // R-55: the three earnings travel in ONE book transfer. Nuvion takes it
    // and answers `pending`: nothing is landed until it says `successful`,
    // and nothing is sent twice meanwhile.
    await pass();
    const move = await moveOf(creator);
    const ref = move.customerReference;
    expect(move).toMatchObject({ earnings: 3, status: 'owed' });
    expect(move.amountKobo).toBe(BigInt(expected));
    expect(ref).toBe(moveReference(creator.id, move.dayKey, 1));
    expect(transfersOf(ref)).toHaveLength(1);
    for (const p of pays) {
      const e = await settlementOrThrow(p.id);
      expect(e.status).toBe('owed');
      expect(e.moveId).toBe(move.id);
    }
    expect(available(creator)).toBe(0n);
    await pass(10 * 60_000);
    expect(transfersOf(ref)).toHaveLength(1);

    nuvion.settle(ref, 'successful');
    await pass(10 * 60_000);
    // Nuvion's balance is the truth: the creator has exactly the shares.
    expect(available(creator)).toBe(BigInt(expected));
    // WAWU's account paid the shares and Nuvion's charge on the one move (R-31).
    expect(operationalBefore - nuvion.operational.availableKobo).toBe(
      BigInt(expected) + FEE,
    );
    expect(transfersOf(ref)).toHaveLength(1);
    const done = await moveOf(creator);
    expect(done.status).toBe('landed');
    expect(done.providerFeeKobo).toBe(FEE);
    for (const p of pays) {
      expect((await settlementOrThrow(p.id)).status).toBe('landed');
    }
    const rows = await ledgerRows(ref);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('completed');
      expect(r.category).toBe('earning');
      expect(r.provider).toBe('nuvion');
    }
    const out = rows.find((r) => r.direction === 'out')!;
    expect(out.feeKobo).toBe(1500n);
    expect(rows.find((r) => r.direction === 'in')!.amountKobo).toBe(
      BigInt(expected),
    );
    const view = body<EarningsView>(await earningsOf(creator)).data!;
    expect(view.allTime.earnedKobo).toBe(expected);
    expect(view.allTime.sales).toBe(3);
    expect(view.allTime.streams).toEqual([
      { kind: 'content_unlock', earnedKobo: 340_000, sales: 2 },
      { kind: 'tip', earnedKobo: 10_493, sales: 1 },
    ]);
    expect(view.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(view.walletOpen).toBe(true);
    // Not one call went to Fintava.
    expect(fintavaHits).toEqual([]);
  });

  it('check 2: a creator with no wallet keeps earning, and the share lands once, in the move of the day the wallet opens', async () => {
    const creator = mint();
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 250_000));
    await pass();
    const waiting = await settlementOrThrow(paid.id);
    expect(waiting.waiting).toBe('payee_wallet');
    expect(waiting.moveId).toBeNull();
    expect(
      await prisma.earningMove.count({
        where: { payeeWawuUserId: creator.id },
      }),
    ).toBe(0);
    const before = body<EarningsView>(await earningsOf(creator)).data!;
    expect(before.walletOpen).toBe(false);
    expect(before.waiting).toEqual({ count: 1, amountKobo: shareOf(250_000) });
    expect(before.allTime.earnedKobo).toBe(shareOf(250_000));

    for (let i = 0; i < 3; i += 1) await pass(30 * 60_000);
    expect(
      await prisma.earningMove.count({
        where: { payeeWawuUserId: creator.id },
      }),
    ).toBe(0);

    await openFor(creator, 0);
    nuvion.mode = 'successful';
    await earnings.sweep(new Date(Date.now() + 1_000));
    const move = await moveOf(creator);
    const ref = move.customerReference;
    expect(transfersOf(ref)).toHaveLength(1);
    expect(available(creator)).toBe(BigInt(shareOf(250_000)));
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    for (let i = 0; i < 3; i += 1) await pass();
    expect(transfersOf(ref)).toHaveLength(1);
    expect(available(creator)).toBe(BigInt(shareOf(250_000)));
    expect(await ledgerRows(ref)).toHaveLength(2);
    const after = body<EarningsView>(await earningsOf(creator)).data!;
    expect(after.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(after.walletOpen).toBe(true);
  });

  it('lands once between two Hub processes asking at the same moment', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 120_000));
    nuvion.mode = 'successful';
    const now = later();
    await Promise.all([earnings.sweep(now), other.sweep(now)]);
    const row = await settlementOrThrow(paid.id);
    const ref = (await moveOf(creator)).customerReference;
    await Promise.all([
      earnings.drive(row.id, later()),
      other.drive(row.id, later()),
      other.sweep(later()),
    ]);
    expect(transfersOf(ref)).toHaveLength(1);
    expect(available(creator)).toBe(BigInt(shareOf(120_000)));
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    expect(await ledgerRows(ref)).toHaveLength(2);
  });

  it('a lost answer (Nuvion took the transfer, the line dropped) is found again by its reference and never sent under a new one', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 300_000));
    nuvion.mode = 'timeout';
    await pass();
    const ref = (await moveOf(creator)).customerReference;
    expect(transfersOf(ref)).toHaveLength(1);
    expect((await settlementOrThrow(paid.id)).status).toBe('owed');
    // Nuvion finishes it; the next question finds it (it has no lookup by
    // our reference: the adapter walks the payer's transfers).
    nuvion.mode = 'pending';
    nuvion.settle(ref, 'successful');
    await pass(10 * 60_000);
    const done = await moveOf(creator);
    expect(done.status).toBe('landed');
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    expect(done.customerReference).toBe(ref);
    expect(transfersOf(ref)).toHaveLength(1);
    expect(
      nuvion.transfers.filter(
        (t) =>
          t.toAccountId === creator.account!.accountId &&
          t.request.unique_reference.startsWith('wawu-earn-'),
      ),
    ).toHaveLength(1);
    expect(available(creator)).toBe(BigInt(shareOf(300_000)));
  });

  it('a move Nuvion marks failed is tried again under a new reference, once', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    await pass();
    const first = await moveOf(creator);
    expect(transfersOf(first.customerReference)).toHaveLength(1);
    const operationalMid = nuvion.operational.availableKobo;
    nuvion.settle(first.customerReference, 'failed'); // Nuvion gives the amount and fee back
    expect(nuvion.operational.availableKobo).toBe(
      operationalMid + 85_000n + FEE,
    );
    await pass(10 * 60_000);
    const retry = await moveOf(creator);
    expect(retry.attempt).toBe(2);
    expect(retry.customerReference).toBe(
      moveReference(creator.id, retry.dayKey, 2),
    );
    nuvion.mode = 'successful';
    await pass(2 * 60 * 60_000);
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    expect(transfersOf(retry.customerReference)).toHaveLength(1);
    expect(available(creator)).toBe(85_000n);
  });

  it('Nuvion reversing a move it completed is a stop for a person, not a second move', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    await pass();
    const move = await moveOf(creator);
    const ref = move.customerReference;
    nuvion.settle(ref, 'successful');
    nuvion.settle(ref, 'reversed');
    await pass(10 * 60_000);
    const row = await moveOf(creator);
    expect(row.status).toBe('owed');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toContain('reversed it');
    expect((await settlementOrThrow(paid.id)).status).toBe('owed');
    await pass(2 * 60 * 60_000);
    expect(transfersOf(ref)).toHaveLength(1);
    expect(transfersOf(moveReference(creator.id, move.dayKey, 2))).toHaveLength(
      0,
    );
  });

  it('a provider that cannot make the move yet (not supported) leaves the earning waiting, says so in the log, and lands it when it can', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    logger.lines.length = 0;
    nuvion.mode = 'not_supported';
    await pass();
    const waiting = await moveOf(creator);
    const ref = waiting.customerReference;
    expect(waiting.status).toBe('owed');
    expect(waiting.waiting).toBe('not_supported');
    expect(waiting.sentAt).toBeNull();
    expect(transfersOf(ref)).toHaveLength(0);
    expect(
      logger.lines.some(
        (l) =>
          l.includes(`earning move ${waiting.id}`) &&
          l.includes('not supported'),
      ),
    ).toBe(true);
    // The creator still sees it as earned and waiting.
    const view = body<EarningsView>(await earningsOf(creator)).data!;
    expect(view.waiting).toEqual({ count: 1, amountKobo: 85_000 });
    // The provider can now: it lands, once.
    nuvion.mode = 'successful';
    await pass(2 * 60 * 60_000);
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    expect(transfersOf(ref)).toHaveLength(1);
    expect(available(creator)).toBe(85_000n);
  });

  it('WAWU’s own account short of money is an error in the log and a wait, never a lost earning', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    logger.lines.length = 0;
    nuvion.mode = 'insufficient';
    await pass();
    const waiting = await moveOf(creator);
    const ref = waiting.customerReference;
    expect(waiting.waiting).toBe('funds');
    expect(transfersOf(ref)).toHaveLength(0);
    expect(
      logger.lines.some(
        (l) =>
          l.includes(`earning move ${waiting.id}`) &&
          l.includes('cannot cover'),
      ),
    ).toBe(true);
    nuvion.mode = 'successful';
    await pass(2 * 60 * 60_000);
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    expect(available(creator)).toBe(85_000n);
  });
});
