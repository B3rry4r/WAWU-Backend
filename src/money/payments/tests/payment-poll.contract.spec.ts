import { createHash, randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  FintavaDouble,
  fintavaError,
  MERCHANT_BALANCE,
  recordByReference,
  customerHistory,
  type SeenRequest,
} from '../../../../test/fintava/fintava-double';
import {
  body,
  mintToken,
  QuietLogger,
} from '../../../../test/payments/poll-helpers';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type { PaymentQuoteView, PaymentView } from '../../money-view.type';
import { type CompletedPayment, PayableRegistry } from '../payable-registry';
import {
  PAYMENT_FAILED_REASON,
  STILL_CONFIRMING_MESSAGE,
  WalletPaymentService,
} from '../wallet-payment.service';

/**
 * Not enough money, and still confirming (task MONEY-19) on FINTAVA: the real
 * MoneyModule, a real database, real RS256 tokens, and the real MONEY-06
 * Fintava client over a socket to FintavaDouble (the sandbox's own bodies),
 * charging the dashboard's balance-transfer rates on top of the amount
 * (`docs/fintava/fees.md`: ₦23.25 below ₦5,000). No Fintava host is called.
 *
 * Check 1 reads exactly as the task writes it: ₦500 in the wallet, a ₦1,000
 * purchase, a ₦523.25 shortfall on a ₦1,023.25 total. Check 2: a payment
 * whose answer was lost is `pending` and is polled by its id until the sweep
 * settles it as paid or failed, with Fintava's record lagging first.
 */

const BASE = '/api/hub/money/payments';
const PIN = '4826';
const PRICE = 100_000;
/** The dashboard's balance-transfer charge (`fees.md`), in kobo. */
const liveFee = (amountKobo: number) => (amountKobo < 500_000 ? 2325 : 1575);

jest.setTimeout(120_000);

/** Fintava's record by our reference, with the ids that belong to ONE transfer. */
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

/** Fintava's wallets, as the double keeps them. */
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
  /** `live`: answers; `timeout`: takes the transfer and drops the connection. */
  mode: 'live' | 'timeout' = 'live';
  /** References Fintava's lookup does not show yet (its record lags). */
  readonly hidden = new Set<string>();
  /** References Fintava reports as FAILURE. */
  readonly failures = new Set<string>();
}

describe('Not enough money, and still confirming (MONEY-19), Fintava double', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let cheapPinHash: string;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const previous: Record<string, string | undefined> = {};
  let accountSeq = 0;
  let clock = Date.now();
  const sweepLater = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return payments.sweep(new Date(clock));
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
    walletId: string;
    accountNumber: string;
  };

  async function buyer(kobo: number): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `19${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
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
      auth: `Bearer ${mintToken(id, 'poll-f')}`,
      walletId,
      accountNumber,
    };
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

  function pay(p: Person, q: PaymentQuoteView, key: string = randomUUID()) {
    return request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send({
        kind: q.kind,
        targetId: q.targetId,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      });
  }

  async function polled(p: Person, id: string): Promise<PaymentView> {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/${id}`)
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    return body<PaymentView>(res).data!;
  }

  const sendsFrom = (p: Person) =>
    wallets.sends.filter((s) => s.from === p.accountNumber);
  const w2wSeen = () =>
    double.seen.filter((r) => r.path === '/transaction/wallet-to-wallet');
  const rowOf = (id: string) =>
    prisma.walletPayment.findUniqueOrThrow({ where: { id } });

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
      if (!send || wallets.hidden.has(ref)) {
        return {
          status: 404,
          body: fintavaError(404, 'Transaction not found!'),
        };
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
            source_customer_accname: 'Poll Tester',
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
      FINTAVA_API_KEY: 'live_test_m19_poll_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: '120000',
      FINTAVA_MONEY_TIMEOUT_MS: '120000',
      FINTAVA_CHECK_TIMEOUT_MS: '120000',
      FEE_QUOTE_KEY: 'm19-test-fee-quote-key-0123456789abcdef0123',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
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

    moduleRef.get(PayableRegistry).register({
      kind: 'content_unlock',
      resolve: async ({ targetId }) => {
        await Promise.resolve();
        if (!targetId.startsWith('f-')) {
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
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    wallets.mode = 'live';
  });

  it('check 1: with ₦500 in the wallet, a ₦1,000 purchase is refused with a ₦523.25 shortfall (₦1,023.25 total), and Fintava is asked for no transfer', async () => {
    const p = await buyer(50_000);
    const q = await quoted(p, 'f-short');
    expect(q).toMatchObject({
      priceKobo: 100_000,
      totalKobo: 102_325,
      balanceKobo: 50_000,
      shortfallKobo: 52_325,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 0 },
    });

    const key = randomUUID();
    const res = await pay(p, q, key);
    expect(res.status).toBe(402);
    expect(res.body).toEqual({
      statusCode: 402,
      message: 'You need ₦523.25 more in your wallet.',
      data: null,
      reason: {
        code: 'insufficient_funds',
        message: 'You need ₦523.25 more in your wallet.',
        balanceKobo: 50_000,
        totalKobo: 102_325,
        shortfallKobo: 52_325,
      },
    });
    expect(w2wSeen()).toHaveLength(0);
    expect(wallets.kobo.get(p.accountNumber)).toBe(50_000);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);

    // The person adds exactly the shortfall; the same key pays once.
    wallets.kobo.set(p.accountNumber, 102_325);
    const again = await pay(p, q, key);
    expect(again.status).toBe(201);
    expect(body<PaymentView>(again).data).toMatchObject({
      status: 'completed',
      totalKobo: 102_325,
      delivered: true,
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(wallets.kobo.get(p.accountNumber)).toBe(0);
  });

  it('check 2: a payment whose answer was lost is polled as pending while Fintava’s record lags, and the sweep settles it as paid once the record shows', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'f-lag');
    wallets.mode = 'timeout';
    const first = await pay(p, q);
    wallets.mode = 'live';
    const pending = body<PaymentView>(first).data!;
    expect(pending).toMatchObject({
      status: 'pending',
      statusMessage: STILL_CONFIRMING_MESSAGE,
      delivered: false,
    });
    wallets.hidden.add(pending.reference);

    // Fintava's lookup says nothing yet: still pending, never "no money moved".
    await sweepLater();
    expect(await polled(p, pending.id)).toMatchObject({
      status: 'pending',
      statusMessage: STILL_CONFIRMING_MESSAGE,
    });
    expect(delivered.filter((d) => d.paymentId === pending.id)).toHaveLength(0);

    // The record shows: the next sweep settles it, delivers once, sends nothing again.
    wallets.hidden.delete(pending.reference);
    await sweepLater();
    const paid = await polled(p, pending.id);
    expect(paid).toMatchObject({
      status: 'completed',
      delivered: true,
      statusMessage: null,
      totalKobo: 102_325,
    });
    expect(delivered.filter((d) => d.paymentId === pending.id)).toHaveLength(1);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('check 2: Fintava reporting the transfer as FAILURE settles the pending payment as failed, with its reason, and frees the item', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'f-fail');
    wallets.mode = 'timeout';
    const pending = body<PaymentView>(await pay(p, q)).data!;
    wallets.mode = 'live';
    expect(pending.status).toBe('pending');
    wallets.failures.add(pending.reference);

    await sweepLater();
    const failed = await polled(p, pending.id);
    expect(failed).toMatchObject({
      status: 'failed',
      failureReason: PAYMENT_FAILED_REASON,
      delivered: false,
      statusMessage: null,
    });
    expect((await rowOf(pending.id)).openKey).toBeNull();
    expect(delivered.filter((d) => d.paymentId === pending.id)).toHaveLength(0);
  });

  it('a poll asks Fintava for nothing', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'f-quiet');
    wallets.mode = 'timeout';
    const pending = body<PaymentView>(await pay(p, q)).data!;
    wallets.mode = 'live';
    const seen = double.seen.length;
    for (let i = 0; i < 5; i += 1) {
      expect((await polled(p, pending.id)).status).toBe('pending');
    }
    expect(double.seen).toHaveLength(seen);
  });
});
