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
import { LedgerStatusService } from '../../ledger/ledger-status.service';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type { PaymentQuoteView, PaymentView } from '../../money-view.type';
import { type CompletedPayment, PayableRegistry } from '../payable-registry';
import { DEFAULT_PAYMENT_CHARGE_REVIEW_ABOVE_KOBO } from '../payment-config';
import {
  STILL_CONFIRMING_MESSAGE,
  WalletPaymentService,
} from '../wallet-payment.service';

/**
 * N2 of MONEY-17 round 8 (carried into MONEY-18; lead ruling, Default (lead),
 * owner may override) with NUVION stood in: a provider charge below 0, or
 * above the quoted fee by more than PAYMENT_CHARGE_REVIEW_ABOVE_KOBO
 * (PROVISIONAL, default ₦1,000), is not trusted. The payment goes to review
 * with both figures and is not delivered until a person releases it.
 *
 * Nuvion's record carries its charge (`applicable_fee`) on every path, so
 * every path is exercised: the answer to the send (`successful` at once), the
 * payment sweep's read of a transfer that finished later, the ledger's status
 * check before it, and the sticky review afterwards (no path completes it).
 */

const BASE = '/api/hub/money/payments';
const PIN = '5937';
const NUVION_FEES = '0:1500,500000:2500';
const QUOTE_FEE = 1500;
const CAP = DEFAULT_PAYMENT_CHARGE_REVIEW_ABOVE_KOBO;
const PRICE = 100_000;

jest.setTimeout(120_000);

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `fu-nuv-${sub}@test.wawu.dev`,
      phone: '+2348000009921',
      firstName: 'Follow',
      lastName: 'Nuvion',
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

describe('N2 on the provider seam, Nuvion stood in: a charge that is not believed is reviewed, not delivered', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let statusChecks: LedgerStatusService;
  const nuvion = new NuvionSeamStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const previous: Record<string, string | undefined> = {};
  const fintavaHits: string[] = [];
  let fintavaCounter: Server;
  let accountSeq = 0;
  let clock = Date.now();
  const later = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  const creator = {
    wawuUserId: randomUUID(),
    displayName: 'Chimamanda Adichie',
    handle: 'chimamanda',
    avatarUrl: null,
    tick: 'creator' as const,
  };

  type Person = { id: string; auth: string; account: NuvionAccount };

  async function buyer(kobo: number): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `84${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
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
    const set = await request(app.getHttpServer())
      .post('/api/hub/money/pin')
      .set('Authorization', auth)
      .send({ pin: PIN, pinConfirmation: PIN });
    expect(set.status).toBe(201);
    return { id, auth, account };
  }

  /** A payment at a Nuvion charge of `fee` kobo, whatever the quote said. */
  async function payAt(p: Person, mode: 'successful' | 'pending', fee: number) {
    const target = `n-${randomUUID()}`;
    const qres = await request(app.getHttpServer())
      .get(`${BASE}/quote?kind=content_unlock&targetId=${target}`)
      .set('Authorization', p.auth);
    expect(qres.status).toBe(200);
    const q = body<PaymentQuoteView>(qres).data!;
    expect(q.fee.providerFeeKobo).toBe(QUOTE_FEE);
    nuvion.feeKobo = () => BigInt(fee);
    nuvion.mode = mode;
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send({
        kind: q.kind,
        targetId: q.targetId,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      });
    nuvion.mode = 'pending';
    expect(res.status).toBe(201);
    return body<PaymentView>(res).data!;
  }

  const rowOf = (id: string) =>
    prisma.walletPayment.findUniqueOrThrow({ where: { id } });
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
  const deliveries = (id: string) =>
    delivered.filter((d) => d.paymentId === id).length;
  const transfersOf = (reference: string) =>
    nuvion.transfers.filter((t) => t.request.unique_reference === reference);

  async function expectChargeReview(view: PaymentView, reportedFee: number) {
    const row = await rowOf(view.id);
    expect(row.status).toBe('pending');
    expect(row.chargeReviewSince).not.toBeNull();
    expect(row.reviewSince).not.toBeNull();
    expect(row.providerFeeKobo).toBe(BigInt(QUOTE_FEE));
    expect(row.totalKobo).toBe(BigInt(PRICE + QUOTE_FEE));
    expect(row.debitReviewSince).toBeNull();
    expect(row.discrepancy).toContain('charge not trusted');
    expect(row.discrepancy).toContain(
      `reported ${PRICE + reportedFee} kobo (fee ${reportedFee})`,
    );
    expect(row.discrepancy).toContain(
      `quoted ${PRICE + QUOTE_FEE} kobo (fee ${QUOTE_FEE})`,
    );
    expect(deliveries(view.id)).toBe(0);
    expect(row.fulfilledAt).toBeNull();
    // The item stays claimed: nobody pays again while a person looks.
    expect(row.openKey).not.toBeNull();
    const out = (await ledgerRows(view.reference)).find(
      (r) => r.direction === 'out',
    )!;
    expect(out.status).not.toBe('completed');
  }

  /** No path completes it: the payment sweep, a direct settle, the ledger's check and sweep. */
  async function expectNoPathCompletes(view: PaymentView) {
    nuvion.mode = 'successful';
    await payments.sweep(later());
    await payments.settle(view.id, later(), true);
    const out = (await ledgerRows(view.reference)).find(
      (r) => r.direction === 'out',
    )!;
    await statusChecks.check(out.id, later(5 * 60_000)).catch(() => undefined);
    await statusChecks.sweep(later(10 * 60_000));
    await payments.sweep(later(60 * 60_000));
    nuvion.mode = 'pending';
    const row = await rowOf(view.id);
    expect(row.status).toBe('pending');
    expect(deliveries(view.id)).toBe(0);
    expect(row.fulfilledAt).toBeNull();
    expect(transfersOf(view.reference)).toHaveLength(1);
  }

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
      FINTAVA_API_KEY: 'live_test_m18_fu_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'm18-fu-nuvion-fee-quote-key-0123456789abcdef',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: NUVION_FEES,
      NUVION_FEE_BANK_PAYOUT: NUVION_FEES,
      NUVION_FEE_INFLOW: NUVION_FEES,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
      PAYMENT_CHARGE_REVIEW_ABOVE_KOBO: '',
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
    payments = moduleRef.get(WalletPaymentService);
    statusChecks = moduleRef.get(LedgerStatusService);

    moduleRef.get(PayableRegistry).register({
      kind: 'content_unlock',
      resolve: async ({ targetId }) => {
        await Promise.resolve();
        if (!targetId.startsWith('n-')) {
          throw new MoneyError('target_not_found', 'That piece is gone.');
        }
        return { title: `Piece ${targetId}`, priceKobo: PRICE, payee: creator };
      },
      onCompleted: async (p) => {
        await Promise.resolve();
        delivered.push(p);
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
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
  });

  it('the answer to the send (successful at once) carries a charge ₦1,000.01 above the quote: reviewed, the buyer is told it is being confirmed, and no path completes it', async () => {
    const p = await buyer(5_000_000);
    const fee = QUOTE_FEE + CAP + 1;
    const view = await payAt(p, 'successful', fee);
    expect(view.status).toBe('pending');
    expect(view.statusMessage).toBe(STILL_CONFIRMING_MESSAGE);
    await expectChargeReview(view, fee);
    await expectNoPathCompletes(view);
    await expectChargeReview(view, fee);
  });

  it('the payment sweep reads a transfer that finished later with a charge ₦1,000.01 above the quote: reviewed, not delivered', async () => {
    const p = await buyer(5_000_000);
    const fee = QUOTE_FEE + CAP + 1;
    const view = await payAt(p, 'pending', fee);
    expect(view.status).toBe('pending');
    // Pending first: nothing untrusted yet, nothing reviewed.
    expect((await rowOf(view.id)).chargeReviewSince).toBeNull();
    nuvion.settle(view.reference, 'successful');
    await payments.sweep(later());
    await expectChargeReview(view, fee);
    await expectNoPathCompletes(view);
  });

  it('the ledger status check sees the charge first (the row keeps the disagreement), then the payment sweep reviews the payment', async () => {
    const p = await buyer(5_000_000);
    const fee = QUOTE_FEE + CAP + 7;
    const view = await payAt(p, 'pending', fee);
    nuvion.settle(view.reference, 'successful');
    const out = (await ledgerRows(view.reference)).find(
      (r) => r.direction === 'out',
    )!;
    const check = await statusChecks.check(out.id, later(5 * 60_000));
    expect(check.outcome).toBe('disagrees');
    expect((await rowOf(view.id)).status).toBe('pending');
    await payments.sweep(later());
    await expectChargeReview(view, fee);
  });

  it.each([-500, -1_500])(
    'a negative charge (%i kobo) is not believed on the answer, the sweep or the ledger check, and the check does not crash the sweep',
    async (fee) => {
      const p = await buyer(5_000_000);
      const receipt = await payAt(p, 'successful', fee);
      expect(receipt.status).toBe('pending');
      await expectChargeReview(receipt, fee);

      const later1 = await payAt(p, 'pending', fee);
      nuvion.settle(later1.reference, 'successful');
      // The ledger refuses a negative charge; the sweep of rows logs and goes on.
      await expect(
        statusChecks.sweep(later(10 * 60_000)),
      ).resolves.toBeDefined();
      await payments.sweep(later());
      await expectChargeReview(later1, fee);
      await expectNoPathCompletes(later1);
    },
  );

  it('a charge exactly at the cap above the quote is believed: completed, flagged for NUV-08, delivered; one kobo more is not', async () => {
    const p = await buyer(5_000_000);
    const at = await payAt(p, 'successful', QUOTE_FEE + CAP);
    expect(at).toMatchObject({
      status: 'completed',
      totalKobo: PRICE + QUOTE_FEE + CAP,
    });
    const row = await rowOf(at.id);
    expect(row.chargeReviewSince).toBeNull();
    expect(row.debitReviewSince).not.toBeNull();
    expect(deliveries(at.id)).toBe(1);

    const over = await payAt(p, 'successful', QUOTE_FEE + CAP + 1);
    expect(over.status).toBe('pending');
    expect((await rowOf(over.id)).chargeReviewSince).not.toBeNull();
  });

  it('a charge below the quote but not below 0 is believed (nobody is owed anything): completed at what was taken, not flagged', async () => {
    const p = await buyer(5_000_000);
    const view = await payAt(p, 'successful', 0);
    expect(view).toMatchObject({ status: 'completed', totalKobo: PRICE });
    const row = await rowOf(view.id);
    expect(row.chargeReviewSince).toBeNull();
    expect(row.debitReviewSince).toBeNull();
    expect(row.discrepancy).toContain('took 100000 kobo (fee 0)');
    expect(deliveries(view.id)).toBe(1);
  });

  it('nothing reached the Fintava client', () => {
    expect(fintavaHits).toEqual([]);
  });
});
