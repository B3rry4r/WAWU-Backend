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
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type { PaymentQuoteView, PaymentView } from '../../money-view.type';
import {
  type CompletedPayment,
  PayableRegistry,
} from '../../payments/payable-registry';
import { WalletHoldService } from '../wallet-hold.service';

/**
 * Hold, release and refund (task MONEY-18, R-19, R-42) on the wallet provider
 * seam with NUVION stood in (`test/payments/nuvion-seam-standin.ts`: Nuvion's
 * documented accounts, book transfers answered `pending` first, the fee on
 * top as `applicable_fee`, statuses, error types, no lookup by our reference).
 * WAWU's own account is Nuvion's operational account (its `nuvion_ban`). No
 * Nuvion, Fintava or wawuafrica.com host is called.
 */

const BASE = '/api/hub/money';
const PIN = '5937';
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
      email: `hold-nuv-${sub}@test.wawu.dev`,
      phone: '+2348000009919',
      firstName: 'Nuvion',
      lastName: 'Holder',
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

describe('Hold, release and refund (MONEY-18) on the provider seam, Nuvion stood in', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let holds: WalletHoldService;
  const nuvion = new NuvionSeamStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const previous: Record<string, string | undefined> = {};
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

  type Person = { id: string; auth: string; account: NuvionAccount };

  async function person(kobo: number, withPin = true): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `83${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
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
    const auth = `Bearer ${mintToken(id)}`;
    if (withPin) {
      const set = await request(app.getHttpServer())
        .post(`${BASE}/pin`)
        .set('Authorization', auth)
        .send({ pin: PIN, pinConfirmation: PIN });
      expect(set.status).toBe(201);
    }
    return { id, auth, account };
  }

  function listing(payee: Person | null, priceKobo = 100_000): string {
    const id = `dm-${randomUUID()}`;
    targets.set(id, { priceKobo, payee: payee ? payee.id : null });
    return id;
  }

  /** Pays for a held item (Nuvion answers the payment's book transfer at once). */
  async function paid(
    p: Person,
    kind: 'paid_dm' | 'event_ticket' | 'bill',
    targetId: string,
  ): Promise<PaymentView> {
    nuvion.mode = 'successful';
    const qres = await request(app.getHttpServer())
      .get(`${BASE}/payments/quote?kind=${kind}&targetId=${targetId}`)
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
      });
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    // WAWU's own account is the operational account: it received the price.
    nuvion.feeKobo = () => FEE;
    nuvion.mode = 'pending';
    return view;
  }

  const holdOf = (paymentId: string) =>
    prisma.walletHold.findUniqueOrThrow({ where: { paymentId } });
  const transfersOf = (reference: string) =>
    nuvion.transfers.filter((t) => t.request.unique_reference === reference);
  const available = (p: Person) =>
    nuvion.accounts.get(p.account.accountId)!.availableKobo;

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
      FINTAVA_API_KEY: 'live_test_m18_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'm18-nuvion-fee-quote-key-0123456789abcdef01',
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
    holds = moduleRef.get(WalletHoldService);

    // WAWU's own money beyond what is held (its shares and fees).
    nuvion.operational.availableKobo = 5_000_000n;

    const registry = moduleRef.get(PayableRegistry);
    for (const kind of ['paid_dm', 'event_ticket', 'bill'] as const) {
      registry.register({
        kind,
        resolve: async ({ targetId }) => {
          await Promise.resolve();
          const t = targets.get(targetId);
          if (!t) throw new MoneyError('target_not_found', 'That is gone.');
          return {
            title: `A ${kind}`,
            priceKobo: t.priceKobo,
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
        onCompleted: async (p) => {
          await Promise.resolve();
          delivered.push(p);
        },
      });
    }
  });

  afterAll(async () => {
    if (prisma) {
      const rows = await prisma.walletPayment.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { id: true, customerReference: true },
      });
      const holdRows = await prisma.walletHold.findMany({
        where: { paymentId: { in: rows.map((r) => r.id) } },
        select: { customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          customerReference: {
            in: [
              ...rows.map((r) => r.customerReference),
              ...holdRows
                .map((h) => h.customerReference)
                .filter((r): r is string => !!r),
            ],
          },
        },
      });
      await prisma.walletHold.deleteMany({
        where: { paymentId: { in: rows.map((r) => r.id) } },
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
    nuvion.extraKobo = 0n;
    nuvion.feeKobo = () => FEE;
    nuvion.platformOverride = null;
  });

  it('a held payment sits in the operational account: the payer cannot spend it, the payee is not paid', async () => {
    const creator = await person(0, false);
    const buyer = await person(500_000);
    const before = nuvion.operational.availableKobo;
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOf(payment.id);
    expect(hold).toMatchObject({
      status: 'held',
      provider: 'nuvion',
      amountKobo: 100_000n,
      payeeShareKobo: 85_000n,
      wawuShareKobo: 15_000n,
      merchantAccountNumber: nuvion.operational.nuvionBan,
    });
    // The price (not the fee Nuvion took from the buyer) is in WAWU's account.
    expect(nuvion.operational.availableKobo - before).toBe(100_000n);
    expect(available(creator)).toBe(0n);
    expect(payment.hold).toMatchObject({ status: 'held', amountKobo: 100_000 });
    expect(delivered.find((d) => d.paymentId === payment.id)!.holdId).toBe(
      hold.id,
    );
    expect(nuvion.sendsFrom(creator.account.accountId)).toEqual([]);
  });

  it('a release is asynchronous at Nuvion: held while it is pending, released when Nuvion says successful, with its own fee', async () => {
    const creator = await person(0, false);
    const buyer = await person(500_000);
    const payment = await paid(buyer, 'event_ticket', listing(creator));
    const hold = await holdOf(payment.id);
    const reference = `wawu-rel-${hold.id}`;
    expect(reference.length).toBeLessThanOrEqual(64);
    const op = nuvion.operational.availableKobo;

    // Nuvion's first answer is `pending`: accepted, not finished.
    const s = await holds.release({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'pending', status: 'held' });
    expect(transfersOf(reference)).toHaveLength(1);
    expect(transfersOf(reference)[0].request).toMatchObject({
      payment_type: 'book-transfer',
      amount: 85_000,
      nuvion_ban: creator.account.nuvionBan,
      account_id: nuvion.operational.accountId,
      narration: 'WAWU earning',
    });
    // Not paid yet; a repeat does not send again.
    expect(available(creator)).toBe(0n);
    await holds.release({ paymentId: payment.id });
    expect(transfersOf(reference)).toHaveLength(1);
    expect((await holdOf(payment.id)).status).toBe('held');

    // Nuvion finishes it; the sweep reads its record (the fee is in it).
    nuvion.settle(reference, 'successful');
    const swept = await holds.sweep(later());
    expect(swept.settled).toBe(1);
    const done = await holdOf(payment.id);
    expect(done).toMatchObject({ status: 'released', providerFeeKobo: FEE });
    expect(available(creator)).toBe(85_000n);
    // WAWU's account paid the amount and Nuvion's charge (R-31).
    expect(op - nuvion.operational.availableKobo).toBe(85_000n + FEE);
    // And nothing more moves after.
    await holds.sweep(later());
    expect(transfersOf(reference)).toHaveLength(1);
    const p = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(p.payeeSettledAt).not.toBeNull();
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
    expect(rows.map((r) => [r.walletKind, r.direction, r.status, String(r.feeKobo)])).toEqual([
      ['user', 'in', 'completed', '0'],
      ['merchant', 'out', 'completed', String(FEE)],
    ]);
  });

  it('a refund returns the price, not Nuvion\'s fee on the payment, once, even asked twice and while pending', async () => {
    const creator = await person(0, false);
    const buyer = await person(500_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOf(payment.id);
    const reference = `wawu-ref-${hold.id}`;
    const buyerAfterPaying = available(buyer);
    expect(500_000n - buyerAfterPaying).toBe(100_000n + FEE);

    const a = await holds.refund({ paymentId: payment.id });
    const b = await holds.refund({ paymentId: payment.id });
    expect(a.state).toBe('pending');
    expect(b.state).toBe('pending');
    expect(transfersOf(reference)).toHaveLength(1);
    nuvion.settle(reference, 'successful');
    await holds.sweep(later());
    await holds.refund({ paymentId: payment.id });
    expect(transfersOf(reference)).toHaveLength(1);
    expect(available(buyer) - buyerAfterPaying).toBe(100_000n);
    expect(500_000n - available(buyer)).toBe(FEE);
    expect(await holdOf(payment.id)).toMatchObject({
      status: 'refunded',
      refundedKobo: 100_000n,
    });
  });

  it('a move Nuvion answers `successful` at once is released in the request', async () => {
    const creator = await person(0, false);
    const buyer = await person(500_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    nuvion.mode = 'successful';
    const s = await holds.release({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'settled', status: 'released' });
    expect(available(creator)).toBe(85_000n);
  });

  it('a lost answer after Nuvion took the move is found in its transfers by our reference, never sent again', async () => {
    const creator = await person(0, false);
    const buyer = await person(500_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOf(payment.id);
    const reference = `wawu-rel-${hold.id}`;
    nuvion.mode = 'timeout';
    const s = await holds.release({ paymentId: payment.id });
    expect(s.state).toBe('pending');
    expect(transfersOf(reference)).toHaveLength(1);
    nuvion.settle(reference, 'successful');
    nuvion.mode = 'pending';
    await holds.sweep(later());
    expect(transfersOf(reference)).toHaveLength(1);
    expect((await holdOf(payment.id)).status).toBe('released');
    expect(available(creator)).toBe(85_000n);
  });

  it('Nuvion\'s own word that the move failed starts a new try under a new reference, once', async () => {
    const creator = await person(0, false);
    const buyer = await person(900_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOf(payment.id);
    await holds.release({ paymentId: payment.id });
    nuvion.settle(`wawu-rel-${hold.id}`, 'failed');
    await holds.sweep(later());
    const retried = await holdOf(payment.id);
    expect(retried).toMatchObject({ attempt: 2, sentAt: null });
    expect(retried.customerReference).toBe(`wawu-rel-${hold.id}-2`);
    nuvion.mode = 'successful';
    await holds.sweep(later(10 * 60_000));
    expect((await holdOf(payment.id)).status).toBe('released');
    expect(transfersOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect(transfersOf(`wawu-rel-${hold.id}-2`)).toHaveLength(1);
    expect(available(creator)).toBe(85_000n);
    await holds.sweep(later(10 * 60_000));
    expect(transfersOf(`wawu-rel-${hold.id}-2`)).toHaveLength(1);
  });

  it('a move Nuvion completed and then reversed is not retried: a person looks, the hold stays held', async () => {
    const creator = await person(0, false);
    const buyer = await person(900_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOf(payment.id);
    await holds.release({ paymentId: payment.id });
    nuvion.settle(`wawu-rel-${hold.id}`, 'successful');
    nuvion.settle(`wawu-rel-${hold.id}`, 'reversed');
    await holds.sweep(later());
    const row = await holdOf(payment.id);
    expect(row.status).toBe('held');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toContain('reversed');
    nuvion.mode = 'successful';
    await holds.sweep(later(2 * 60 * 60_000));
    expect(transfersOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect(transfersOf(`wawu-rel-${hold.id}-2`)).toEqual([]);
  });

  it('Nuvion\'s refusals keep the hold held: funds, compliance, a limit; each goes through once it clears', async () => {
    const creator = await person(0, false);
    const buyer = await person(900_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOf(payment.id);
    const reference = `wawu-rel-${hold.id}`;

    nuvion.mode = 'insufficient';
    expect(await holds.release({ paymentId: payment.id })).toMatchObject({
      state: 'waiting',
      waiting: 'funds',
    });
    nuvion.mode = 'compliance_rejected';
    await holds.sweep(later(5 * 60_000));
    expect((await holdOf(payment.id)).waiting).toBe('refused');
    nuvion.mode = 'limit';
    await holds.sweep(later(10 * 60_000));
    expect((await holdOf(payment.id)).waiting).toBe('provider');
    nuvion.mode = 'account_not_active';
    await holds.sweep(later(60 * 60_000));
    expect((await holdOf(payment.id)).waiting).toBe('recipient_frozen');
    expect(transfersOf(reference)).toEqual([]);

    nuvion.mode = 'successful';
    await holds.sweep(later(2 * 60 * 60_000));
    expect((await holdOf(payment.id)).status).toBe('released');
    expect(transfersOf(reference)).toHaveLength(1);
    expect(available(creator)).toBe(85_000n);
  });

  it('the operational account is never the destination, however Nuvion names it', async () => {
    const creator = await person(0, false);
    const buyer = await person(500_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    // The payee's wallet row names WAWU's own account by its nuvion_ban.
    const row = await prisma.fintavaWallet.findUniqueOrThrow({
      where: { wawuUserId: creator.id },
    });
    await prisma.fintavaWallet.update({
      where: { wawuUserId: creator.id },
      data: { accountNumber: nuvion.operational.accountId },
    });
    const s = await holds.release({ paymentId: payment.id });
    expect(s.state).toBe('review');
    const hold = await holdOf(payment.id);
    expect(transfersOf(`wawu-rel-${hold.id}`)).toEqual([]);
    expect(hold.discrepancy).toContain(
      "WAWU's account to WAWU's account",
    );
    await prisma.fintavaWallet.update({
      where: { wawuUserId: creator.id },
      data: { accountNumber: row.accountNumber },
    });
  });

  it('after a rollback to Fintava a Nuvion hold is not moved by Fintava, and a Fintava hold is not moved by Nuvion', async () => {
    const creator = await person(0, false);
    const buyer = await person(500_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    await prisma.walletHold.update({
      where: { paymentId: payment.id },
      data: { provider: 'fintava' },
    });
    const s = await holds.refund({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'waiting', waiting: 'provider' });
    nuvion.mode = 'successful';
    await holds.sweep(later(2 * 60 * 60_000));
    expect(
      transfersOf(`wawu-ref-${(await holdOf(payment.id)).id}`),
    ).toEqual([]);
    expect(fintavaHits).toEqual([]);
    await prisma.walletHold.update({
      where: { paymentId: payment.id },
      data: { provider: 'nuvion' },
    });
    await holds.sweep(later(3 * 60 * 60_000));
    expect((await holdOf(payment.id)).status).toBe('refunded');
  });

  it('nothing reached the Fintava client in this spec', () => {
    expect(fintavaHits).toEqual([]);
  });
});
