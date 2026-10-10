import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type INestApplication,
  type LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  FintavaDouble,
  fintavaError,
  MERCHANT_BALANCE,
  customerHistory,
  recordByReference,
  type SeenRequest,
} from '../../../../test/fintava/fintava-double';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  FINTAVA_SIGNATURE_HEADER,
  signFintavaBody,
} from '../../../fintava/webhook/fintava-signature';
import { FintavaWebhookModule } from '../../../fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { LedgerConsumerService } from '../../ledger/ledger-consumer.service';
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
 * Two follow-ups of MONEY-17 round 8, carried into MONEY-18 (lead rulings,
 * Default (lead), owner may override), on the Fintava adapter:
 *
 * - **D8-1.** When another job completes a payment between a path's figures
 *   update and its `complete()` call, the payment's `discrepancy` note (both
 *   figures) must not be dropped. The two held-path specs are the verifier's
 *   (`V8 D1`, lost note and receipt variant), made permanent.
 * - **N2.** A provider charge below 0, or above the quoted fee by more than
 *   PAYMENT_CHARGE_REVIEW_ABOVE_KOBO (PROVISIONAL, default ₦1,000), is not
 *   trusted: the payment goes to review with both figures and is not
 *   delivered until a person releases it, on every path that completes a
 *   payment (the answer to the send, a signed report after a lost answer, the
 *   payment sweep, the ledger's status check).
 *
 * Fintava's lookups and history carry no charge for a wallet-to-wallet send,
 * so on the sweep and the status check the quote stands and nothing is
 * untrusted; the signed report and the answer to the send are its two
 * sources of a charge. The Nuvion adapter, whose record carries the charge on
 * every path, is `payment-follow-ups-nuvion.contract.spec.ts`.
 */

const BASE = '/api/hub/money/payments';
const MONEY_TIMEOUT_MS = 120_000;
const PIN = '4826';
const WEBHOOK_SECRET = 'whsec_local_m18_follow_Qv7Lp3Xc9Ty2Hb5Jn';
const QUOTE_FEE = 2325;
const CAP = DEFAULT_PAYMENT_CHARGE_REVIEW_ABOVE_KOBO;

jest.setTimeout(300_000);

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `fu-${sub}@test.wawu.dev`,
      phone: '+2348000009920',
      firstName: 'Follow',
      lastName: 'Up',
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

function recordFor(ourReference: string, status: string, amount: string) {
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

class Wallets {
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
  mode: 'live' | 'timeout' = 'live';
  /** Fintava's charge when set, whatever the band. */
  feeOverride: number | null = null;
}

async function until(ok: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 2_400; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('until: the condition never held');
}

describe('MONEY-17 follow-ups (D8-1, N2) on Fintava', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let statusChecks: LedgerStatusService;
  let consumer: LedgerConsumerService;
  let cheapPinHash: string;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const previous: Record<string, string | undefined> = {};
  let accountSeq = 0;
  let clock = Date.now();
  const later = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  const creator = {
    wawuUserId: randomUUID(),
    displayName: 'Ada Lovelace',
    handle: 'ada',
    avatarUrl: null,
    tick: 'creator' as const,
  };

  type Person = {
    id: string;
    auth: string;
    customerId: string;
    accountNumber: string;
  };

  async function buyer(kobo: number): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `20${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    const walletId = randomUUID();
    const customerId = randomUUID();
    await prisma.fintavaWallet.create({
      data: { wawuUserId: id, customerId, walletId, accountNumber },
    });
    wallets.kobo.set(accountNumber, kobo);
    wallets.byId.set(walletId, accountNumber);
    await prisma.transactionPin.create({
      data: { wawuUserId: id, pinHash: cheapPinHash },
    });
    return { id, auth: `Bearer ${mintToken(id)}`, customerId, accountNumber };
  }

  async function quoted(
    p: Person,
    targetId: string,
  ): Promise<PaymentQuoteView> {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/quote?kind=content_unlock&targetId=${targetId}`)
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    return body<PaymentQuoteView>(res).data!;
  }

  function pay(p: Person, q: PaymentQuoteView) {
    return request(app.getHttpServer())
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

  /** The quote's ₦23.25 and a payment whose answer was lost while Fintava took `fee`. */
  async function lostAnswerTaking(fee: number) {
    const p = await buyer(1_000_000);
    const q = await quoted(p, `once-fu-${randomUUID()}`);
    expect(q.totalKobo).toBe(102_325);
    wallets.mode = 'timeout';
    wallets.feeOverride = fee;
    const res = await pay(p, q);
    wallets.mode = 'live';
    wallets.feeOverride = null;
    const paid = body<PaymentView>(res).data!;
    expect(paid.status).toBe('pending');
    return { p, q, paid };
  }

  /** Fintava's signed wallet-to-wallet delivery for a payment's send, stored by the real route. */
  async function deliverWebhook(p: Person, paymentId: string): Promise<string> {
    const ref = `wawu-pay-${paymentId}`;
    const send = wallets.sends.find((x) => x.reference === ref)!;
    const text = JSON.stringify({
      event: 'wallet_to_wallet_transfer_v2',
      data: {
        amount: send.amountKobo / 100,
        reference: `tagapay${randomUUID().replace(/-/g, '')}`,
        customerReference: ref,
        total: (send.amountKobo + send.feeKobo) / 100,
        transaction_fee: send.feeKobo / 100,
        target_customer_id: randomUUID(),
        source_customer_id: p.customerId,
        target_customer_accname: 'WAWU',
        source_customer_accname: 'Pay Tester',
        target_customer_accno: send.to,
        source_customer_accno: send.from,
        source_customer_wallet: send.from,
        target_customer_wallet: send.to,
        target_availableBalance: 1,
        target_bookedBalance: 1,
        source_availableBalance: 1,
        source_bookedBalance: 1,
        description: 'Fund transfer between customers',
        customer_id: randomUUID(),
      },
    });
    const res = await request(app.getHttpServer())
      .post('/api/hub/webhooks/fintava')
      .set('Content-Type', 'application/json')
      .set(
        FINTAVA_SIGNATURE_HEADER,
        signFintavaBody(WEBHOOK_SECRET, Buffer.from(text)),
      )
      .send(text);
    expect(res.status).toBe(200);
    const ids = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "FintavaWebhookEvent"
       WHERE position(convert_to(${ref}, 'UTF8') in "rawBody") > 0
       ORDER BY "receivedAt" DESC`;
    return ids[0].id;
  }

  function installFintava() {
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
      if (!send) {
        return {
          status: 404,
          body: fintavaError(404, 'Transaction not found!'),
        };
      }
      return {
        status: 200,
        body: recordFor(ref, 'SUCCESS', (send.amountKobo / 100).toFixed(2)),
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
      const feeKobo = wallets.feeOverride ?? QUOTE_FEE;
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
            source_customer_accname: 'Pay Tester',
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

  beforeAll(async () => {
    cheapPinHash = await argon2.hash(PIN, {
      type: argon2.argon2id,
      timeCost: 1,
      memoryCost: 1024,
      parallelism: 1,
    });
    await double.start();
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_m18_follow_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FEE_QUOTE_KEY: 'm18-follow-fee-quote-key-0123456789abcdef0',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      FINTAVA_WEBHOOK_SECRET: WEBHOOK_SECRET,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
      PAYMENT_CHARGE_REVIEW_ABOVE_KOBO: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    installFintava();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        FintavaWebhookModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
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
    payments = moduleRef.get(WalletPaymentService);
    statusChecks = moduleRef.get(LedgerStatusService);
    consumer = moduleRef.get(LedgerConsumerService);

    const registry = moduleRef.get(PayableRegistry);
    registry.register({
      kind: 'content_unlock',
      resolve: async ({ targetId }) => {
        await Promise.resolve();
        if (!targetId.startsWith('once-')) {
          throw new MoneyError('target_not_found', 'That piece is gone.');
        }
        return {
          title: `Piece ${targetId}`,
          priceKobo: 100_000,
          payee: creator,
        };
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
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    wallets.mode = 'live';
    wallets.feeOverride = null;
  });

  // -------------------------------------------------------------------------
  // D8-1: the note is not lost when two completions race
  // -------------------------------------------------------------------------

  /** Holds the first `complete()` until `release()`, so another job can finish the payment first. */
  function holdFirstComplete() {
    const inner = payments as unknown as {
      complete: (...a: unknown[]) => Promise<unknown>;
      completeFromRecord: (...a: unknown[]) => Promise<unknown>;
    };
    const complete = inner.complete.bind(payments);
    const completeFromRecord = inner.completeFromRecord.bind(payments);
    let first = true;
    let reached = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // The whole of the held path, so a test can wait for it to end (its note
    // is written after `complete()` returns) instead of for a time.
    let heldPath: Promise<unknown> = Promise.resolve();
    const spy = jest
      .spyOn(inner, 'complete')
      .mockImplementation(async (...a: unknown[]) => {
        if (first) {
          first = false;
          reached = true;
          await gate;
        }
        return complete(...a);
      });
    let tracked = false;
    const pathSpy = jest
      .spyOn(inner, 'completeFromRecord')
      .mockImplementation((...a: unknown[]) => {
        const run = completeFromRecord(...a);
        if (!tracked) {
          tracked = true;
          heldPath = run;
        }
        return run;
      });
    return {
      reached: () => reached,
      release,
      finished: () => heldPath,
      restore: () => {
        spy.mockRestore();
        pathSpy.mockRestore();
      },
    };
  }

  it.each([3000, 1500])(
    'D8-1 (lost note, signed report): the report has written the real figures and is about to complete the payment; a lookup completes it first; the note with both figures is still written (fee %i)',
    async (fee) => {
      const { p, paid } = await lostAnswerTaking(fee);
      const held = holdFirstComplete();
      try {
        const consuming = consumer.consume(await deliverWebhook(p, paid.id));
        await until(() => held.reached());
        // The lookup now completes the payment: it sees the figures the
        // report already wrote, so it has no note of its own.
        await payments.settle(paid.id, new Date(), true);
        held.release();
        await consuming;
        await held.finished();
        await until(async () => (await rowOf(paid.id)).fulfilledAt !== null);
      } finally {
        held.restore();
      }
      const row = await rowOf(paid.id);
      expect(row.status).toBe('completed');
      expect(row.totalKobo).toBe(BigInt(100_000 + fee));
      expect(row.discrepancy ?? '').toContain(`took ${100_000 + fee} kobo`);
      expect(row.discrepancy ?? '').toContain('quoted 102325 kobo');
      // Above the quote it is flagged for NUV-08; below it is not.
      expect(row.debitReviewSince !== null).toBe(fee > QUOTE_FEE);
      expect(deliveries(paid.id)).toBe(1);
    },
  );

  it.each([3000, 1500])(
    'D8-1 (receipt): the answer to the send has written the real figures and is about to complete the payment; the sweep completes it first; the note is still written (fee %i)',
    async (fee) => {
      const p = await buyer(1_000_000);
      const q = await quoted(p, `once-fu-rc-${fee}`);
      const held = holdFirstComplete();
      let res: Response;
      let id = '';
      try {
        wallets.feeOverride = fee;
        const sending = pay(p, q).then((r) => r);
        await until(() => held.reached());
        wallets.feeOverride = null;
        id = (
          await prisma.walletPayment.findFirstOrThrow({
            where: { payerWawuUserId: p.id },
          })
        ).id;
        await payments.settle(id, new Date(), true);
        held.release();
        res = await sending;
        await until(async () => (await rowOf(id)).fulfilledAt !== null);
      } finally {
        held.restore();
      }
      const row = await rowOf(id);
      expect(row.status).toBe('completed');
      expect(row.discrepancy ?? '').toContain(`took ${100_000 + fee} kobo`);
      expect(row.discrepancy ?? '').toContain('quoted 102325 kobo');
      // The buyer is answered the real total.
      expect(body<PaymentView>(res).data).toMatchObject({
        status: 'completed',
        totalKobo: 100_000 + fee,
      });
      expect(deliveries(id)).toBe(1);
    },
  );

  // -------------------------------------------------------------------------
  // N2: a charge that is not believed is reviewed, not delivered
  // -------------------------------------------------------------------------

  /** What a payment in charge review looks like, on any path. */
  async function expectChargeReview(
    id: string,
    reference: string,
    reportedFee: number,
  ) {
    const row = await rowOf(id);
    expect(row.status).toBe('pending');
    expect(row.chargeReviewSince).not.toBeNull();
    expect(row.reviewSince).not.toBeNull();
    expect(row.nextCheckAt).toBeNull();
    // Nothing the provider reported is written as the payment's figures.
    expect(row.providerFeeKobo).toBe(BigInt(QUOTE_FEE));
    expect(row.totalKobo).toBe(BigInt(100_000 + QUOTE_FEE));
    expect(row.debitReviewSince).toBeNull();
    // Both figures are on the payment, in words.
    expect(row.discrepancy).toContain('charge not trusted');
    expect(row.discrepancy).toContain(
      `reported ${100_000 + reportedFee} kobo (fee ${reportedFee})`,
    );
    expect(row.discrepancy).toContain(
      `quoted ${100_000 + QUOTE_FEE} kobo (fee ${QUOTE_FEE})`,
    );
    // Not delivered, and the item stays claimed.
    expect(deliveries(id)).toBe(0);
    expect(row.fulfilledAt).toBeNull();
    expect(row.openKey).not.toBeNull();
    // The buyer's ledger row is marked for the person too, and not completed.
    const out = (await ledgerRows(reference)).find(
      (r) => r.direction === 'out',
    )!;
    expect(out.status).toBe('pending');
    expect(out.discrepancy).toContain('charge not trusted');
  }

  /** Every path that could complete it, tried: none does, none delivers. */
  async function expectNoPathCompletes(
    id: string,
    reference: string,
    p: Person,
  ) {
    await payments.sweep(later());
    await payments.settle(id, later(), true);
    const out = (await ledgerRows(reference)).find(
      (r) => r.direction === 'out',
    )!;
    await statusChecks.check(out.id, later(5 * 60_000));
    await statusChecks.sweep(later(10 * 60_000));
    await payments.sweep(later(60 * 60_000));
    const row = await rowOf(id);
    expect(row.status).toBe('pending');
    expect(deliveries(id)).toBe(0);
    expect(row.fulfilledAt).toBeNull();
    // A second report of the same charge changes nothing either.
    expect(await consumer.consume(await deliverWebhook(p, id))).toBe(
      'processed',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect((await rowOf(id)).status).toBe('pending');
    expect(deliveries(id)).toBe(0);
    expect(wallets.sends.filter((s) => s.reference === reference)).toHaveLength(
      1,
    );
  }

  it('N2 receipt, above the cap: the answer to the send carries a charge ₦1,000.01 above the quote: reviewed with both figures, not delivered, no path completes it', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'once-fu-n2-receipt');
    const fee = QUOTE_FEE + CAP + 1;
    wallets.feeOverride = fee;
    const res = await pay(p, q);
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    // The buyer is told it is still being confirmed, never "paid".
    expect(view.status).toBe('pending');
    expect(view.statusMessage).toBe(STILL_CONFIRMING_MESSAGE);
    await expectChargeReview(view.id, view.reference, fee);
    wallets.feeOverride = null;
    await expectNoPathCompletes(view.id, view.reference, p);
    await expectChargeReview(view.id, view.reference, fee);
  });

  it('N2 receipt, a negative charge: a provider that gives money back on a purchase is not believed', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'once-fu-n2-negative');
    wallets.feeOverride = -825;
    const res = await pay(p, q);
    wallets.feeOverride = null;
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('pending');
    const row = await rowOf(view.id);
    expect(row.chargeReviewSince).not.toBeNull();
    expect(row.discrepancy).toContain('reported 99175 kobo (fee -825)');
    expect(row.providerFeeKobo).toBe(BigInt(QUOTE_FEE));
    expect(deliveries(view.id)).toBe(0);
  });

  it('N2 boundary: a charge exactly at the cap above the quote is believed (completed, flagged for NUV-08, delivered); one kobo more is not', async () => {
    const at = await buyer(1_000_000);
    const qAt = await quoted(at, 'once-fu-n2-at');
    wallets.feeOverride = QUOTE_FEE + CAP;
    const resAt = await pay(at, qAt);
    wallets.feeOverride = null;
    const viewAt = body<PaymentView>(resAt).data!;
    expect(viewAt).toMatchObject({
      status: 'completed',
      totalKobo: 100_000 + QUOTE_FEE + CAP,
    });
    const rowAt = await rowOf(viewAt.id);
    expect(rowAt.chargeReviewSince).toBeNull();
    expect(rowAt.debitReviewSince).not.toBeNull();
    expect(deliveries(viewAt.id)).toBe(1);

    const over = await buyer(1_000_000);
    const qOver = await quoted(over, 'once-fu-n2-over');
    wallets.feeOverride = QUOTE_FEE + CAP + 1;
    const viewOver = body<PaymentView>(await pay(over, qOver)).data!;
    wallets.feeOverride = null;
    expect(viewOver.status).toBe('pending');
    expect((await rowOf(viewOver.id)).chargeReviewSince).not.toBeNull();
    expect(deliveries(viewOver.id)).toBe(0);
  });

  it("N2 signed report after a lost answer: Fintava's webhook says it took far more than the quote: reviewed, not delivered, and neither the sweep nor the status check completes it", async () => {
    const fee = QUOTE_FEE + CAP + 500;
    const { p, paid } = await lostAnswerTaking(fee);
    expect(await consumer.consume(await deliverWebhook(p, paid.id))).toBe(
      'processed',
    );
    await until(async () => (await rowOf(paid.id)).chargeReviewSince !== null);
    await expectChargeReview(paid.id, paid.reference, fee);
    await expectNoPathCompletes(paid.id, paid.reference, p);
    await expectChargeReview(paid.id, paid.reference, fee);
  });

  it("N2 sweep and status check alone: Fintava's lookups carry no charge, so the quote stands and nothing is untrusted (the boundary of the Fintava record)", async () => {
    const { paid } = await lostAnswerTaking(QUOTE_FEE + CAP + 500);
    await payments.settle(paid.id, new Date(), true);
    const row = await rowOf(paid.id);
    expect(row.status).toBe('completed');
    expect(row.chargeReviewSince).toBeNull();
    expect(row.totalKobo).toBe(BigInt(100_000 + QUOTE_FEE));
  });

  it('N2 late report: a payment the sweep already completed at the quote and delivered is marked, not changed, when a report of an untrusted charge arrives', async () => {
    const fee = QUOTE_FEE + CAP + 500;
    const { p, paid } = await lostAnswerTaking(fee);
    await payments.settle(paid.id, new Date(), true);
    await until(async () => (await rowOf(paid.id)).fulfilledAt !== null);
    expect(deliveries(paid.id)).toBe(1);
    expect(await consumer.consume(await deliverWebhook(p, paid.id))).toBe(
      'processed',
    );
    await until(async () => (await rowOf(paid.id)).chargeReviewSince !== null);
    const row = await rowOf(paid.id);
    expect(row.status).toBe('completed');
    expect(row.totalKobo).toBe(BigInt(100_000 + QUOTE_FEE));
    expect(row.providerFeeKobo).toBe(BigInt(QUOTE_FEE));
    expect(row.reviewSince).toBeNull();
    expect(row.discrepancy).toContain('charge not trusted');
    expect(deliveries(paid.id)).toBe(1);
  });

  it('a payment of a kind that is not held has no hold', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'once-fu-nohold');
    const view = body<PaymentView>(await pay(p, q)).data!;
    expect(view.status).toBe('completed');
    expect(view.hold).toBeNull();
    expect(
      await prisma.walletHold.count({ where: { paymentId: view.id } }),
    ).toBe(0);
  });
});
