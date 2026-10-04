import { randomUUID } from 'node:crypto';
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
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  FintavaDouble,
  fintavaConfig,
  fintavaError,
  MERCHANT_ACCOUNT,
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
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { FeeSettings } from '../../fees/fee-config';
import { FeeQuoteService } from '../../fees/fee-quote.service';
import { NO_WALLET_MESSAGE } from '../../gate/wallet-gate';
import { AccountPurgeService } from '../../../account-purge/account-purge.service';
import { LedgerStatusService } from '../../ledger/ledger-status.service';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type {
  PaymentQuoteView,
  PaymentView,
  PinStateView,
} from '../../money-view.type';
import { IDEMPOTENT_REPLAYED_HEADER } from '../idempotency';
import {
  type CompletedPayment,
  type PayableKindHandler,
  PayableRegistry,
} from '../payable-registry';
import {
  PAY_ROUTE,
  PAYMENT_FAILED_REASON,
  WalletPaymentService,
} from '../wallet-payment.service';

/**
 * POST /money/payments and GET /money/payments/quote over HTTP (task
 * MONEY-17): the real MoneyModule, a real database, real RS256 tokens
 * checked against the stand-in WAWU ID's JWKS (WAWU_ID_JWKS_URL), and the
 * real MONEY-06 Fintava client over a socket to FintavaDouble.
 *
 * The double plays Fintava's wallets: it holds a balance per wallet,
 * answers `GET /customer/wallet/balance/{walletId}` and
 * `GET /merchant/balance` with the sandbox's bodies (`sandbox/08-`, `22-`),
 * and `POST /transaction/wallet-to-wallet` with the sandbox's body
 * (`sandbox/13-`), refusing a repeated reference and a send above the
 * balance with the sandbox's own messages. It charges the dashboard's
 * balance-transfer rates (`docs/fintava/fees.md`: ₦23.25 below ₦5,000,
 * ₦15.75 from ₦5,000) on top of the amount, as the live account will; one
 * test switches it to the sandbox's ₦0.
 *
 * Two kinds are registered for the test the way a selling feature will
 * register its own (PayableRegistry): `content_unlock` (a ₦1,000 piece by a
 * creator, plus a missing and an already-owned one) and `credit_pack` (WAWU
 * itself is paid), and `tip` (the payer's amount). One server for the file,
 * listening (FIX-02); money timeout 1.5 s (no sub-second client timeouts).
 */

const BASE = '/api/hub/money/payments';
const MONEY_TIMEOUT_MS = 1_500;
const PIN = '4826';
const WRONG_PIN = '1397';

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `pay-${sub}@test.wawu.dev`,
      phone: '+2348000009917',
      firstName: 'Pay',
      lastName: 'Tester',
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
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response) => res.body as Envelope<T>;

/** The dashboard's balance-transfer charge (`fees.md`), in kobo. */
const liveFee = (amountKobo: number) => (amountKobo < 500_000 ? 2325 : 1575);

/** Fintava's wallets, as the double keeps them. */
class Wallets {
  /** accountNumber to kobo. */
  readonly kobo = new Map<string, number>();
  /** walletId to accountNumber. */
  readonly byId = new Map<string, string>();
  readonly references = new Set<string>();
  /** Every accepted send. */
  readonly sends: Array<{
    from: string;
    to: string;
    amountKobo: number;
    feeKobo: number;
    reference: string;
  }> = [];
  mode:
    | 'live'
    | 'sandbox'
    | 'slow'
    | 'timeout'
    | 'error500'
    | 'refuse'
    | 'insufficient'
    | 'wrongamount' = 'live';
  delayMs = 0;
  /** Fintava's charge when set, whatever the band (its fee changed before our config). */
  feeOverride: number | null = null;
  /** References Fintava's lookup does not show yet (its record lags). */
  readonly hidden = new Set<string>();
  /** References Fintava reports as FAILURE. */
  readonly failures = new Set<string>();
  /** Held before a transfer is taken (a barrier for requests at once). */
  sendGate: (() => Promise<void>) | null = null;
  /** Held before a balance is answered. */
  balanceGate: ((account: string) => Promise<void>) | null = null;
}

/** Resolves once `n` callers have arrived, for all of them. */
function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((r) => (open = r));
  return () => {
    arrived += 1;
    if (arrived >= n) open();
    return all;
  };
}

/** Polls until `ok` answers true, for at most 10 s. */
async function until(ok: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('until: the condition never held');
}

describe('Pay from wallet (MONEY-17) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let statusChecks: LedgerStatusService;
  let ledger: LedgerService;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const previous: Record<string, string | undefined> = {};
  let accountSeq = 0;

  type Person = {
    id: string;
    auth: string;
    walletId: string;
    accountNumber: string;
    customerId: string;
  };

  const creator = {
    wawuUserId: randomUUID(),
    displayName: 'Ada Lovelace',
    handle: 'ada',
    avatarUrl: null,
    tick: 'creator' as const,
  };

  /** A person with an open wallet holding `kobo`, and the PIN set. */
  async function buyer(kobo: number): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `17${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    const walletId = randomUUID();
    const customerId = randomUUID();
    await prisma.fintavaWallet.create({
      data: { wawuUserId: id, customerId, walletId, accountNumber },
    });
    wallets.kobo.set(accountNumber, kobo);
    wallets.byId.set(walletId, accountNumber);
    const auth = `Bearer ${mintToken(id)}`;
    const set = await request(app.getHttpServer())
      .post('/api/hub/money/pin')
      .set('Authorization', auth)
      .send({ pin: PIN, pinConfirmation: PIN });
    expect(set.status).toBe(201);
    return { id, auth, walletId, accountNumber, customerId };
  }

  function quote(p: Person, kind: string, targetId: string, extra = '') {
    return request(app.getHttpServer())
      .get(`${BASE}/quote?kind=${kind}&targetId=${targetId}${extra}`)
      .set('Authorization', p.auth);
  }

  async function quoted(
    p: Person,
    kind: string,
    targetId: string,
    extra = '',
  ): Promise<PaymentQuoteView> {
    const res = await quote(p, kind, targetId, extra);
    expect(res.status).toBe(200);
    return body<PaymentQuoteView>(res).data!;
  }

  function pay(
    p: Person,
    payload: Record<string, unknown>,
    key: string | null = randomUUID(),
    pin: string | null = PIN,
  ) {
    let req = request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth);
    if (key !== null) req = req.set('Idempotency-Key', key);
    if (pin !== null) req = req.set('X-Transaction-Pin', pin);
    return req.send(payload);
  }

  function payBody(q: PaymentQuoteView, extra: Record<string, unknown> = {}) {
    return {
      kind: q.kind,
      targetId: q.targetId,
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
      ...extra,
    };
  }

  const sendsFrom = (p: Person) =>
    wallets.sends.filter((s) => s.from === p.accountNumber);
  const w2wSeen = () =>
    double.seen.filter((r) => r.path === '/transaction/wallet-to-wallet');

  async function pinState(p: Person): Promise<PinStateView> {
    const res = await request(app.getHttpServer())
      .get('/api/hub/money/pin')
      .set('Authorization', p.auth);
    return body<PinStateView>(res).data!;
  }

  async function ledgerRows(reference: string) {
    return prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
  }

  function installFintava() {
    double.reset();
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
    });
    double.on(
      'GET',
      /^\/customer\/wallet\/balance\//,
      async (req: SeenRequest) => {
        const id = req.path.split('/').pop()!;
        const account = wallets.byId.get(id);
        if (!account) {
          return { status: 400, body: fintavaError(400, 'Wallet not found') };
        }
        if (wallets.balanceGate) await wallets.balanceGate(account);
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
      },
    );
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
        body: recordByReference(
          ref,
          wallets.failures.has(ref) ? 'FAILURE' : 'SUCCESS',
          (send.amountKobo / 100).toFixed(2),
        ),
      };
    });
    double.on('GET', '/txn', {
      status: 200,
      body: customerHistory([]),
    });
    double.on(
      'POST',
      '/transaction/wallet-to-wallet',
      async (req: SeenRequest) => {
        if (wallets.sendGate) await wallets.sendGate();
        const b = req.body as {
          senderAccount: string;
          receiverAccount: string;
          amount: number;
          CustomerReference: string;
        };
        const mode = wallets.mode;
        if (mode === 'error500') {
          return { status: 500, body: fintavaError(500, 'read ECONNRESET') };
        }
        if (mode === 'refuse') {
          return {
            status: 400,
            body: fintavaError(400, 'Transfer could not be processed'),
          };
        }
        if (mode === 'insufficient') {
          return {
            status: 400,
            body: fintavaError(
              400,
              'Insufficient balance on source wallet to complete this transfer.',
            ),
          };
        }
        if (wallets.references.has(b.CustomerReference)) {
          return {
            status: 400,
            body: fintavaError(400, 'customerReference already exists'),
          };
        }
        const amountKobo =
          Math.round(b.amount * 100) + (mode === 'wrongamount' ? 100 : 0);
        const feeKobo =
          wallets.feeOverride ?? (mode === 'sandbox' ? 0 : liveFee(amountKobo));
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
        // answer reaches the caller in time.
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
          delayMs:
            mode === 'timeout'
              ? MONEY_TIMEOUT_MS + 1_000
              : mode === 'slow'
                ? 400
                : 0,
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
      },
    );
  }

  beforeAll(async () => {
    await double.start();
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_m17_pay_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FEE_QUOTE_KEY: 'm17-test-fee-quote-key-0123456789abcdef0123',
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
    statusChecks = moduleRef.get(LedgerStatusService);
    ledger = moduleRef.get(LedgerService);

    const registry = moduleRef.get(PayableRegistry);
    const unlock: PayableKindHandler = {
      kind: 'content_unlock',
      resolve: ({ targetId }) => {
        if (targetId === 'gone') {
          throw new MoneyError('target_not_found', 'That piece is gone.');
        }
        if (targetId === 'owned') {
          throw new MoneyError('target_not_payable', 'You already own this.');
        }
        const prices: Record<string, number> = {
          'piece-1000': 100_000,
          'piece-4999': 499_900,
          'piece-5000': 500_000,
          'piece-odd': 99_999,
          'piece-1000b': 100_000,
          'piece-1000c': 100_000,
          'piece-1000d': 100_000,
          'piece-1000e': 100_000,
          'piece-1000f': 100_000,
          'piece-1000g': 100_000,
          'piece-1000h': 100_000,
        };
        const priceKobo = prices[targetId];
        if (!priceKobo) {
          throw new MoneyError('target_not_found', 'That piece is gone.');
        }
        return Promise.resolve({
          title: `Piece ${targetId}`,
          priceKobo,
          payee: creator,
        });
      },
      onCompleted: (p) => {
        delivered.push(p);
        return Promise.resolve();
      },
    };
    registry.register(unlock);
    registry.register({
      kind: 'credit_pack',
      resolve: async ({ targetId }) => {
        await Promise.resolve();
        if (targetId !== 'starter') {
          throw new MoneyError('target_not_found', 'No such pack.');
        }
        return { title: 'Starter pack', priceKobo: 100_000, payee: null };
      },
    });
    registry.register({
      kind: 'tip',
      resolve: async ({ targetId, amountKobo }) => {
        await Promise.resolve();
        if (targetId === creator.wawuUserId) {
          return { title: 'Tip', priceKobo: amountKobo!, payee: creator };
        }
        return {
          title: 'Tip',
          priceKobo: amountKobo!,
          payee: { ...creator, wawuUserId: targetId },
        };
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      const payments = await prisma.walletPayment.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          customerReference: { in: payments.map((p) => p.customerReference) },
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

  // -------------------------------------------------------------------------
  // The task's two capability checks
  // -------------------------------------------------------------------------

  it('check 1: a ₦1,000 item debits ₦1,023.25 once; the ledger shows the creator ₦850 and WAWU ₦150', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    expect(q).toMatchObject({
      priceKobo: 100_000,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 0, totalFeeKobo: 2325 },
      totalKobo: 102_325,
      balanceKobo: 500_000,
      shortfallKobo: 0,
      willBeHeld: false,
      payee: { wawuUserId: creator.wawuUserId },
    });

    const res = await pay(p, payBody(q));
    expect(res.status).toBe(201);
    const paid = body<PaymentView>(res).data!;
    expect(paid).toMatchObject({
      status: 'completed',
      priceKobo: 100_000,
      totalKobo: 102_325,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 0, totalFeeKobo: 2325 },
      hold: null,
      failureReason: null,
    });

    // Fintava: one transfer of the price to WAWU's merchant wallet, under
    // our reference; the buyer's balance fell by the price plus the charge.
    expect(sendsFrom(p)).toEqual([
      {
        from: p.accountNumber,
        to: MERCHANT_ACCOUNT,
        amountKobo: 100_000,
        feeKobo: 2325,
        reference: paid.reference,
      },
    ]);
    expect(wallets.kobo.get(p.accountNumber)).toBe(500_000 - 102_325);
    expect(paid.reference).toBe(`wawu-pay-${paid.id}`);

    // The split, of the price only.
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect({
      payee: row.payeeWawuUserId,
      payeeShareKobo: row.payeeShareKobo,
      wawuShareKobo: row.wawuShareKobo,
      discrepancy: row.discrepancy,
    }).toEqual({
      payee: creator.wawuUserId,
      payeeShareKobo: 85_000n,
      wawuShareKobo: 15_000n,
      discrepancy: null,
    });

    // The ledger: the buyer's debit with Fintava's charge, WAWU's credit.
    const rows = await ledgerRows(paid.reference);
    expect(
      rows.map((r) => ({
        wallet: r.walletKind,
        direction: r.direction,
        status: r.status,
        amount: r.amountKobo,
        fee: r.feeKobo,
        total: r.totalKobo,
        paymentId: r.paymentId,
        link: r.linkKind,
        discrepancy: r.discrepancy,
      })),
    ).toEqual([
      {
        wallet: 'merchant',
        direction: 'in',
        status: 'completed',
        amount: 100_000n,
        fee: 0n,
        total: 100_000n,
        paymentId: paid.id,
        link: 'content_unlock',
        discrepancy: null,
      },
      {
        wallet: 'user',
        direction: 'out',
        status: 'completed',
        amount: 100_000n,
        fee: 2325n,
        total: 102_325n,
        paymentId: paid.id,
        link: 'content_unlock',
        discrepancy: null,
      },
    ]);
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(1);
  });

  it('check 2: the same request sent twice debits once; the repeat is the first answer, byte for byte, and checks no PIN', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const key = randomUUID();
    const first = await pay(p, payBody(q), key);
    expect(first.status).toBe(201);
    expect(first.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      undefined,
    );

    const again = await pay(p, payBody(q), key);
    expect(again.status).toBe(201);
    expect(again.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      'true',
    );
    expect(again.text).toBe(first.text);

    // A wrong PIN on the repeat: still the first answer, and no try used.
    const wrong = await pay(p, payBody(q), key, WRONG_PIN);
    expect(wrong.status).toBe(201);
    expect(wrong.text).toBe(first.text);
    expect((await pinState(p)).triesLeft).toBe(5);

    expect(sendsFrom(p)).toHaveLength(1);
    expect(wallets.kobo.get(p.accountNumber)).toBe(500_000 - 102_325);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Concurrency (FIX-02: one listening server, real sockets)
  // -------------------------------------------------------------------------

  it('8 taps at once with one key: one debit, and every answer is that payment or "still going through"', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const key = randomUUID();
    wallets.mode = 'slow';
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => pay(p, payBody(q), key)),
    );
    wallets.mode = 'live';
    expect(sendsFrom(p)).toHaveLength(1);
    expect(wallets.kobo.get(p.accountNumber)).toBe(500_000 - 102_325);
    const ok = answers.filter((a) => a.status === 201);
    const busy = answers.filter((a) => a.status === 409);
    expect(ok.length + busy.length).toBe(8);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(new Set(ok.map((a) => body<PaymentView>(a).data!.id)).size).toBe(1);
    for (const b of busy) {
      expect(body(b).reason).toEqual({
        code: 'idempotency_in_progress',
        message:
          'This payment is still going through. Check again in a moment.',
        retryAfterSeconds: 2,
      });
    }
    // Once it is done, every repeat is the stored answer.
    const later = await pay(p, payBody(q), key);
    expect(later.status).toBe(201);
    expect(later.headers['idempotent-replayed']).toBe('true');
    expect(later.text).toBe(ok[0].text);
  });

  it('three payments at once for three items with money for two, both ways it can fall: two debits, nothing negative, every refusal a real shortfall', async () => {
    // Order A: all three read a balance that covers them before any transfer
    // is taken (a barrier on Fintava's transfer); Fintava refuses the third.
    const a = await buyer(210_000);
    const items = ['piece-1000', 'piece-1000b', 'piece-1000c'];
    const qa = await Promise.all(
      items.map((t) => quoted(a, 'content_unlock', t)),
    );
    wallets.sendGate = barrier(3);
    const answersA = await Promise.all(qa.map((q) => pay(a, payBody(q))));
    wallets.sendGate = null;
    expect(answersA.map((r) => r.status).sort()).toEqual([201, 201, 402]);
    expect(sendsFrom(a)).toHaveLength(2);
    expect(wallets.kobo.get(a.accountNumber)).toBe(210_000 - 2 * 102_325);
    const refusedA = body(answersA.find((r) => r.status === 402)!).reason!;
    expect(refusedA).toEqual({
      code: 'insufficient_funds',
      message: 'You need ₦969.75 more in your wallet.',
      balanceKobo: 5350,
      totalKobo: 102_325,
      shortfallKobo: 96_975,
    });
    const rowsA = await prisma.walletPayment.findMany({
      where: { payerWawuUserId: a.id },
    });
    expect(rowsA.map((r) => r.status).sort()).toEqual([
      'completed',
      'completed',
      'failed',
    ]);

    // Order B: the third reads the balance only after the first two are
    // taken (a barrier on its balance read); our own check refuses it and
    // nothing is written.
    const b = await buyer(210_000);
    const qb = await Promise.all(
      items.map((t) => quoted(b, 'content_unlock', t)),
    );
    let reads = 0;
    wallets.balanceGate = async (account) => {
      if (account !== b.accountNumber) return;
      reads += 1;
      if (reads === 3) {
        await until(() => Promise.resolve(sendsFrom(b).length === 2));
      }
    };
    const answersB = await Promise.all(qb.map((q) => pay(b, payBody(q))));
    wallets.balanceGate = null;
    expect(answersB.map((r) => r.status).sort()).toEqual([201, 201, 402]);
    expect(sendsFrom(b)).toHaveLength(2);
    expect(body(answersB.find((r) => r.status === 402)!).reason).toEqual(
      refusedA,
    );
    const rowsB = await prisma.walletPayment.findMany({
      where: { payerWawuUserId: b.id },
    });
    expect(rowsB.map((r) => r.status).sort()).toEqual([
      'completed',
      'completed',
    ]);
  });

  // -------------------------------------------------------------------------
  // The Idempotency-Key rules
  // -------------------------------------------------------------------------

  it('the same key with another body is idempotency_key_reused, and nothing is sent', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const key = randomUUID();
    expect((await pay(p, payBody(q), key)).status).toBe(201);
    const other = await quoted(p, 'credit_pack', 'starter');
    const res = await pay(p, payBody(other), key);
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('idempotency_key_reused');
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('no Idempotency-Key, or a malformed one: 400 before the PIN, no try used', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    for (const key of [null, 'short', 'has space in it', 'x'.repeat(129)]) {
      const res = await pay(p, payBody(q), key, WRONG_PIN);
      expect(res.status).toBe(400);
      expect(body(res).reason?.code).toBe('idempotency_key_required');
    }
    expect((await pinState(p)).triesLeft).toBe(5);
    expect(sendsFrom(p)).toHaveLength(0);
  });

  it('a wrong PIN stores nothing: the same key with the right PIN then pays, once', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const key = randomUUID();
    const wrong = await pay(p, payBody(q), key, WRONG_PIN);
    expect(wrong.status).toBe(403);
    expect(body(wrong).reason).toMatchObject({
      code: 'pin_incorrect',
      triesLeft: 4,
    });
    const missing = await pay(p, payBody(q), key, null);
    expect(body(missing).reason?.code).toBe('pin_required');
    expect(sendsFrom(p)).toHaveLength(0);
    const right = await pay(p, payBody(q), key);
    expect(right.status).toBe(201);
    expect(body<PaymentView>(right).data!.status).toBe('completed');
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('a key whose request died mid-way is answered from its payment once the send can no longer be running', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const key = randomUUID();
    const res = await pay(p, payBody(q), key);
    const paid = body<PaymentView>(res).data!;
    // As if the server had died after sending and before storing the answer.
    await prisma.moneyIdempotencyKey.updateMany({
      where: { wawuUserId: p.id, key },
      data: { state: 'in_progress', responseBody: null, responseStatus: null },
    });
    const busy = await pay(p, payBody(q), key);
    expect(body(busy).reason?.code).toBe('idempotency_in_progress');
    await prisma.$executeRaw`
      UPDATE "MoneyIdempotencyKey" SET "updatedAt" = now() - interval '10 minutes'
       WHERE "wawuUserId" = ${p.id} AND "key" = ${key}`;
    const answered = await pay(p, payBody(q), key);
    expect(answered.status).toBe(201);
    expect(answered.headers['idempotent-replayed']).toBe('true');
    expect(body<PaymentView>(answered).data).toEqual(paid);
    expect(sendsFrom(p)).toHaveLength(1);
    const stored = await prisma.moneyIdempotencyKey.findFirstOrThrow({
      where: { wawuUserId: p.id, key },
    });
    expect(stored.state).toBe('done');
  });

  // -------------------------------------------------------------------------
  // Checks before money moves
  // -------------------------------------------------------------------------

  it('not enough money: 402 with the shortfall including the charge, nothing sent, and the key can be used after a top-up', async () => {
    const p = await buyer(50_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    expect(q).toMatchObject({ balanceKobo: 50_000, shortfallKobo: 52_325 });
    const key = randomUUID();
    const res = await pay(p, payBody(q), key);
    expect(res.status).toBe(402);
    expect(body(res).reason).toEqual({
      code: 'insufficient_funds',
      message: 'You need ₦523.25 more in your wallet.',
      balanceKobo: 50_000,
      totalKobo: 102_325,
      shortfallKobo: 52_325,
    });
    expect(
      w2wSeen().some(
        (r) =>
          (r.body as { senderAccount?: string }).senderAccount ===
          p.accountNumber,
      ),
    ).toBe(false);
    wallets.kobo.set(p.accountNumber, 200_000);
    const after = await pay(p, payBody(q), key);
    expect(after.status).toBe(201);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('a different total, a token from another person, or a forged one: 409 quote_changed with the payment quote as it stands', async () => {
    const p = await buyer(500_000);
    const other = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const theirs = await quoted(other, 'content_unlock', 'piece-1000');
    for (const payload of [
      payBody(q, { expectedTotalKobo: 100_000 }),
      payBody(q, { quoteToken: theirs.quoteToken }),
      payBody(q, { quoteToken: `${q.quoteToken.split('.')[0]}.AAAA` }),
    ]) {
      const res = await pay(p, payload);
      expect(res.status).toBe(409);
      const reason = body(res).reason!;
      expect(reason.code).toBe('quote_changed');
      expect(reason.paymentQuote).toMatchObject({
        kind: 'content_unlock',
        targetId: 'piece-1000',
        priceKobo: 100_000,
        totalKobo: 102_325,
        balanceKobo: 500_000,
      });
      expect(reason.paymentQuote?.quoteToken).toEqual(expect.any(String));
      expect(reason.feeQuote).toBeUndefined();
    }
    // A quote for ₦4,999 cannot pay for the ₦5,000 piece.
    const cheap = await quoted(p, 'content_unlock', 'piece-4999');
    const res = await pay(p, payBody(cheap, { targetId: 'piece-5000' }));
    expect(body(res).reason?.code).toBe('quote_changed');
    expect(sendsFrom(p)).toHaveLength(0);
  });

  it('a quote signed before a restart under another key (FEE_QUOTE_KEY unset, or rotated) is 409 quote_changed with the new quote, never a 500', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const before = new FeeQuoteService(
      new FeeSettings(
        fintavaConfig({
          FEE_QUOTE_KEY: 'another-boot-fee-quote-key-0123456789abcdef',
        }),
      ),
    ).quote(p.id, { kind: 'purchase', amountKobo: 100_000 });
    expect(before.totalKobo).toBe(q.totalKobo);
    const res = await pay(p, payBody(q, { quoteToken: before.quoteToken }));
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('quote_changed');
    const fresh = body(res).reason!.paymentQuote!;
    expect(fresh.totalKobo).toBe(102_325);
    // The new quote pays.
    const paid = await pay(p, payBody(fresh));
    expect(paid.status).toBe(201);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it("a kind nobody has moved onto the wallet, a missing target, an owned one, or the payer's own: refused before anything moves", async () => {
    const p = await buyer(500_000);
    const unregistered = await quote(p, 'legal_fee', randomUUID());
    expect(unregistered.status).toBe(409);
    expect(body(unregistered).reason).toEqual({
      code: 'target_not_payable',
      message: "This can't be paid for from your wallet yet.",
    });
    const held = await quote(p, 'paid_dm', randomUUID());
    expect(body(held).reason?.code).toBe('target_not_payable');
    expect((await quote(p, 'content_unlock', 'gone')).status).toBe(404);
    expect(body(await quote(p, 'content_unlock', 'owned')).reason?.code).toBe(
      'target_not_payable',
    );
    const own = await quote(p, 'tip', p.id, '&amountKobo=50000');
    expect(body(own).reason).toEqual({
      code: 'target_not_payable',
      message: "You can't pay yourself for this.",
    });
    // The pay route refuses the same way, after the PIN, with nothing sent.
    const res = await pay(p, {
      kind: 'legal_fee',
      targetId: randomUUID(),
      expectedTotalKobo: 102_325,
      quoteToken: 'x.y',
    });
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('target_not_payable');
    expect(sendsFrom(p)).toHaveLength(0);
  });

  it('an amount only on a tip, digits only, and a note only with a tip', async () => {
    const p = await buyer(500_000);
    for (const extra of [
      '&amountKobo=100.00',
      '&amountKobo=1e4',
      '&amountKobo=10,000',
    ]) {
      const res = await quote(p, 'tip', creator.wawuUserId, extra);
      expect(res.status).toBe(400);
    }
    expect((await quote(p, 'tip', creator.wawuUserId)).status).toBe(400);
    expect(
      (await quote(p, 'content_unlock', 'piece-1000', '&amountKobo=100'))
        .status,
    ).toBe(400);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const res = await pay(p, payBody(q, { note: 'thanks' }));
    expect(res.status).toBe(400);
    expect(sendsFrom(p)).toHaveLength(0);
  });

  it('a tip of ₦2,000 with a note: ₦2,023.25 leaves the wallet, the creator is owed ₦1,700 and WAWU keeps ₦300', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'tip', creator.wawuUserId, '&amountKobo=200000');
    expect(q.totalKobo).toBe(202_325);
    const res = await pay(
      p,
      payBody(q, { amountKobo: 200_000, note: 'Lovely work' }),
    );
    expect(res.status).toBe(201);
    const paid = body<PaymentView>(res).data!;
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect([row.payeeShareKobo, row.wawuShareKobo, row.note]).toEqual([
      170_000n,
      30_000n,
      'Lovely work',
    ]);
    expect(wallets.kobo.get(p.accountNumber)).toBe(500_000 - 202_325);
  });

  it("when WAWU itself is paid (no payee) the whole price is WAWU's", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'credit_pack', 'starter');
    expect(q.payee).toBeNull();
    const paid = body<PaymentView>(await pay(p, payBody(q))).data!;
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect([
      row.payeeShareKobo,
      row.wawuShareKobo,
      row.payeeWawuUserId,
    ]).toEqual([0n, 100_000n, null]);
  });

  it('85% is rounded down to the kobo and WAWU gets the rest: ₦999.99 owes the creator ₦849.99', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-odd');
    const paid = body<PaymentView>(await pay(p, payBody(q))).data!;
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect([row.payeeShareKobo, row.wawuShareKobo]).toEqual([84_999n, 15_000n]);
  });

  it('a person with no wallet gets wallet_not_open from both routes, whatever they send', async () => {
    const id = randomUUID();
    users.push(id);
    const auth = `Bearer ${mintToken(id)}`;
    const q = await request(app.getHttpServer())
      .get(`${BASE}/quote?kind=content_unlock&targetId=piece-1000`)
      .set('Authorization', auth);
    const p = await request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', auth)
      .set('X-Transaction-Pin', PIN)
      .send({});
    for (const res of [q, p]) {
      expect(res.status).toBe(409);
      expect(body(res).reason).toEqual({
        code: 'wallet_not_open',
        message: NO_WALLET_MESSAGE,
      });
    }
  });

  // -------------------------------------------------------------------------
  // What Fintava answers
  // -------------------------------------------------------------------------

  it('a Fintava timeout is pending, never sent again; the status check finds it and the sweep completes and delivers it once', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const key = randomUUID();
    wallets.mode = 'timeout';
    const res = await pay(p, payBody(q), key);
    wallets.mode = 'live';
    expect(res.status).toBe(201);
    const paid = body<PaymentView>(res).data!;
    expect(paid.status).toBe('pending');
    // The money moved at Fintava although the answer was lost.
    expect(sendsFrom(p)).toHaveLength(1);
    const again = await pay(p, payBody(q), key);
    expect(again.text).toBe(res.text);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(0);

    // MONEY-08's status check asks Fintava by our reference.
    double.on('GET', `/transaction/reference/${paid.reference}`, {
      status: 200,
      body: recordByReference(paid.reference, 'SUCCESS', '1000.00'),
    });
    const [out] = (await ledgerRows(paid.reference)).filter(
      (r) => r.direction === 'out',
    );
    const checked = await statusChecks.check(
      out.id,
      new Date(Date.now() + 5 * 60_000),
    );
    expect(checked.status).toBe('completed');

    // The ledger row's completion settles the payment at once (lead ruling
    // D2), without waiting for the sweep.
    await until(async () => {
      const r = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: paid.id },
      });
      return r.status === 'completed' && r.fulfilledAt !== null;
    });
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.status).toBe('completed');
    expect(row.fulfilledAt).not.toBeNull();
    await payments.sweep(new Date(Date.now() + 3 * 60_000));
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(1);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(
      w2wSeen().filter(
        (r) =>
          (r.body as { CustomerReference?: string }).CustomerReference ===
          paid.reference,
      ),
    ).toHaveLength(1);
  });

  it('a 5xx from Fintava is pending too, and nothing is sent again', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'error500';
    const res = await pay(p, payBody(q));
    wallets.mode = 'live';
    expect(res.status).toBe(201);
    const paid = body<PaymentView>(res).data!;
    expect(paid.status).toBe('pending');
    const sentOnce = w2wSeen().filter(
      (r) =>
        (r.body as { CustomerReference?: string }).CustomerReference ===
        paid.reference,
    );
    expect(sentOnce).toHaveLength(1);
    const rows = await ledgerRows(paid.reference);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
  });

  it('Fintava refusing the transfer is a failed payment with nothing moved, kept for the key', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const key = randomUUID();
    wallets.mode = 'refuse';
    const res = await pay(p, payBody(q), key);
    wallets.mode = 'live';
    expect(res.status).toBe(201);
    const paid = body<PaymentView>(res).data!;
    expect(paid).toMatchObject({
      status: 'failed',
      failureReason: PAYMENT_FAILED_REASON,
      completedAt: null,
    });
    expect(wallets.kobo.get(p.accountNumber)).toBe(500_000);
    const rows = await ledgerRows(paid.reference);
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed']);
    const again = await pay(p, payBody(q), key);
    expect(again.text).toBe(res.text);
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(0);
  });

  it('Fintava saying there is not enough (after our check passed) is 402, the payment failed, and the key given back', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const key = randomUUID();
    wallets.mode = 'insufficient';
    const res = await pay(p, payBody(q), key);
    wallets.mode = 'live';
    expect(res.status).toBe(402);
    // A fresh read still covers the total: no shortfall to show (lead
    // ruling D3), never "₦0.00 more".
    expect(body(res).reason).toEqual({
      code: 'insufficient_funds',
      message: 'Your balance changed. Check it and try again.',
      balanceKobo: 500_000,
      totalKobo: 102_325,
    });
    const failed = await prisma.walletPayment.findFirstOrThrow({
      where: { payerWawuUserId: p.id },
    });
    expect(failed.status).toBe('failed');
    const retry = await pay(p, payBody(q), key);
    expect(retry.status).toBe(201);
    expect(body<PaymentView>(retry).data!.status).toBe('completed');
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('the sandbox charging ₦0 instead of the quoted ₦23.25: paid, and the difference kept on the ledger row and the payment for review', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'sandbox';
    const res = await pay(p, payBody(q));
    wallets.mode = 'live';
    const paid = body<PaymentView>(res).data!;
    expect(paid.status).toBe('completed');
    expect(wallets.kobo.get(p.accountNumber)).toBe(500_000 - 100_000);
    const [, out] = await ledgerRows(paid.reference);
    expect(out.direction).toBe('out');
    expect(out.feeKobo).toBe(2325n);
    expect(out.discrepancy).toMatch(/feeKobo 2325 vs 0/);
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.discrepancy).toMatch(/feeKobo 2325 vs 0/);
  });

  // -------------------------------------------------------------------------
  // Round 2: an unknown outcome is never "no money moved" (lead ruling D1)
  // -------------------------------------------------------------------------

  it('D1: Fintava took it, the answer was lost and its record lags past the resend window: pending, "don\'t pay again", a second payment for the item refused, then completed and delivered once; one debit', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'timeout';
    const first = await pay(p, payBody(q));
    wallets.mode = 'live';
    const paid = body<PaymentView>(first).data!;
    wallets.hidden.add(paid.reference);
    expect(paid).toMatchObject({
      status: 'pending',
      statusMessage:
        "We're still confirming this payment. Don't pay again; we'll let you know.",
      failureReason: null,
    });
    expect(sendsFrom(p)).toHaveLength(1);

    // MONEY-08 concludes Fintava has no record (its 404, no history row,
    // past the window) and fails the ledger row as absent.
    const out = (await ledgerRows(paid.reference)).find(
      (r) => r.direction === 'out',
    )!;
    const absent = await statusChecks.check(
      out.id,
      new Date(Date.now() + 60 * 60_000),
    );
    expect(absent.outcome).toBe('failed_absent');
    // The sweep asks Fintava itself and still hears nothing: pending.
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    let row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.status).toBe('pending');
    expect(row.checks).toBe(1);

    // The buyer tries again, under a new key: refused, nothing sent.
    const q2 = await quoted(p, 'content_unlock', 'piece-1000');
    const again = await pay(p, payBody(q2));
    expect(again.status).toBe(409);
    expect(body(again).reason).toEqual({
      code: 'payment_in_progress',
      message:
        "We're still confirming this payment. Don't pay again; we'll let you know.",
      paymentId: paid.id,
    });
    expect(sendsFrom(p)).toHaveLength(1);

    // Fintava's record shows up: the next check completes it, revives the
    // ledger row, and delivers once.
    wallets.hidden.delete(paid.reference);
    await payments.sweep(new Date(Date.now() + 10 * 60_000));
    row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.status).toBe('completed');
    expect(row.openKey).toBeNull();
    const rows = await ledgerRows(paid.reference);
    expect(rows.map((r) => r.status)).toEqual(['completed', 'completed']);
    await payments.sweep(new Date(Date.now() + 20 * 60_000));
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(1);
    expect(sendsFrom(p)).toHaveLength(1);
    expect(wallets.kobo.get(p.accountNumber)).toBe(1_000_000 - 102_325);
  });

  it('D1: two payments for one item at once under two keys: one goes on, the other is payment_in_progress; one debit', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'slow';
    const answers = await Promise.all([pay(p, payBody(q)), pay(p, payBody(q))]);
    wallets.mode = 'live';
    expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
    const ok = body<PaymentView>(answers.find((r) => r.status === 201)!).data!;
    expect(body(answers.find((r) => r.status === 409)!).reason).toMatchObject({
      code: 'payment_in_progress',
      paymentId: ok.id,
    });
    expect(sendsFrom(p)).toHaveLength(1);
    // Once it completed, the item can be paid for again (a feature that
    // sells it once refuses that itself).
    expect(
      (await pay(p, payBody(await quoted(p, 'content_unlock', 'piece-1000'))))
        .status,
    ).toBe(201);
  });

  it('D1: Fintava saying FAILURE is the only way a lost-answer payment fails', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'timeout';
    const paid = body<PaymentView>(await pay(p, payBody(q))).data!;
    wallets.mode = 'live';
    wallets.failures.add(paid.reference);
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect([row.status, row.failureReason, row.openKey]).toEqual([
      'failed',
      PAYMENT_FAILED_REASON,
      null,
    ]);
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(0);
  });

  it('D1: no answer past PAYMENT_REVIEW_AFTER_HOURS goes to review: still pending, out of the sweep, the item still blocked; a late webhook completes it', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'timeout';
    const paid = body<PaymentView>(await pay(p, payBody(q))).data!;
    wallets.mode = 'live';
    wallets.hidden.add(paid.reference);
    await payments.sweep(new Date(Date.now() + 73 * 3_600_000));
    let row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toMatch(/no answer from Fintava after 72 hours/);
    const asked = () =>
      double.seen.filter(
        (r) => r.path === `/transaction/reference/${paid.reference}`,
      ).length;
    const before = asked();
    await payments.sweep(new Date(Date.now() + 80 * 3_600_000));
    expect(asked()).toBe(before);
    expect(
      body(
        await pay(p, payBody(await quoted(p, 'content_unlock', 'piece-1000'))),
      ).reason?.code,
    ).toBe('payment_in_progress');
    // Fintava's word arrives through the ledger (as a webhook would write it).
    await ledger.record({
      wallet: {
        kind: 'user',
        wawuUserId: p.id,
        accountNumber: p.accountNumber,
      },
      direction: 'out',
      status: 'completed',
      category: 'purchase',
      amountKobo: 100_000,
      feeKobo: 2325,
      totalKobo: 102_325,
      references: { customerReference: paid.reference },
      source: 'webhook',
    });
    await until(async () => {
      row = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: paid.id },
      });
      return row.status === 'completed';
    });
    await until(() =>
      Promise.resolve(
        delivered.filter((d) => d.paymentId === paid.id).length === 1,
      ),
    );
  });

  it('D1.4: a second completed payment for one item made while the first was open is flagged on both for MONEY-16 and MONEY-18', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'timeout';
    const paid = body<PaymentView>(await pay(p, payBody(q))).data!;
    wallets.mode = 'live';
    // As if one had slipped through: a completed twin made while it was open.
    const twin = await prisma.walletPayment.create({
      data: {
        payerWawuUserId: p.id,
        kind: 'content_unlock',
        targetId: 'piece-1000',
        title: 'twin',
        priceKobo: 100_000n,
        providerFeeKobo: 2325n,
        wawuFeeKobo: 0n,
        totalKobo: 102_325n,
        payeeShareKobo: 85_000n,
        wawuShareKobo: 15_000n,
        customerReference: `wawu-pay-${randomUUID()}`,
        payerAccountNumber: p.accountNumber,
        merchantAccountNumber: MERCHANT_ACCOUNT,
        status: 'completed',
        completedAt: new Date(),
      },
    });
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    const rows = await prisma.walletPayment.findMany({
      where: { id: { in: [paid.id, twin.id] } },
    });
    for (const r of rows) {
      expect(r.status).toBe('completed');
      expect(r.discrepancy).toMatch(/paid twice for one item.*MONEY-18/);
    }
  });

  it('D2: a paid payment never waits behind 60 payments held for review', async () => {
    const reviewer = await buyer(100_000_000);
    await prisma.walletPayment.createMany({
      data: Array.from({ length: 60 }, (_, i) => ({
        payerWawuUserId: reviewer.id,
        kind: 'content_unlock',
        targetId: `held-${i}`,
        title: 'held',
        priceKobo: 100_000n,
        providerFeeKobo: 2325n,
        wawuFeeKobo: 0n,
        totalKobo: 102_325n,
        payeeShareKobo: 85_000n,
        wawuShareKobo: 15_000n,
        customerReference: `wawu-pay-${randomUUID()}`,
        payerAccountNumber: reviewer.accountNumber,
        merchantAccountNumber: MERCHANT_ACCOUNT,
        status: 'pending',
        sentAt: new Date(Date.now() - 3_600_000),
        nextCheckAt: new Date(Date.now() - 3_600_000),
        reviewSince: new Date(),
        createdAt: new Date(Date.now() - 3_600_000),
      })),
    });
    const p = await buyer(1_000_000);
    const pq = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'timeout';
    const paid = body<PaymentView>(await pay(p, payBody(pq))).data!;
    wallets.mode = 'live';
    // MONEY-08 completes its ledger row: the payment follows at once.
    const out = (await ledgerRows(paid.reference)).find(
      (r) => r.direction === 'out',
    )!;
    await statusChecks.check(out.id, new Date(Date.now() + 5 * 60_000));
    await until(
      async () =>
        (
          await prisma.walletPayment.findUniqueOrThrow({
            where: { id: paid.id },
          })
        ).status === 'completed',
    );
    // And the sweep, asked about due payments only, skips the 60 under review.
    const swept = await payments.sweep(new Date(Date.now() + 2 * 60_000));
    expect(swept.checked).toBeLessThan(60);
    await prisma.walletPayment.deleteMany({
      where: { payerWawuUserId: reviewer.id, title: 'held' },
    });
  });

  it('D2: the sweep pages through every due payment, oldest check first, more than one page', async () => {
    const p = await buyer(1_000_000);
    const base = Date.now() - 3_600_000;
    await prisma.walletPayment.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        payerWawuUserId: p.id,
        kind: 'content_unlock',
        targetId: `due-${i}`,
        title: 'due',
        priceKobo: 100_000n,
        providerFeeKobo: 2325n,
        wawuFeeKobo: 0n,
        totalKobo: 102_325n,
        payeeShareKobo: 85_000n,
        wawuShareKobo: 15_000n,
        customerReference: `wawu-pay-${randomUUID()}`,
        payerAccountNumber: p.accountNumber,
        merchantAccountNumber: MERCHANT_ACCOUNT,
        status: 'pending',
        sentAt: new Date(base),
        nextCheckAt: new Date(base + i),
      })),
    });
    const swept = await payments.sweep(new Date());
    expect(swept.checked).toBeGreaterThanOrEqual(120);
    const left = await prisma.walletPayment.count({
      where: {
        payerWawuUserId: p.id,
        title: 'due',
        nextCheckAt: { lte: new Date() },
      },
    });
    expect(left).toBe(0);
    await prisma.walletPayment.deleteMany({
      where: { payerWawuUserId: p.id, title: 'due' },
    });
  });

  // -------------------------------------------------------------------------
  // Round 2: the rest of the verifier's findings
  // -------------------------------------------------------------------------

  it('D3: Fintava charging more than quoted with the buyer holding exactly the total: "Your balance changed", never a ₦0.00 shortfall', async () => {
    const p = await buyer(102_325);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.feeOverride = 3000;
    const res = await pay(p, payBody(q));
    wallets.feeOverride = null;
    expect(res.status).toBe(402);
    expect(body(res).reason).toEqual({
      code: 'insufficient_funds',
      message: 'Your balance changed. Check it and try again.',
      balanceKobo: 102_325,
      totalKobo: 102_325,
    });
    expect(res.text).not.toMatch(/₦0\.00/);
  });

  it('a buyer holding exactly the total pays and is left with ₦0.00', async () => {
    const p = await buyer(102_325);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const res = await pay(p, payBody(q));
    expect(res.status).toBe(201);
    expect(body<PaymentView>(res).data!.status).toBe('completed');
    expect(wallets.kobo.get(p.accountNumber)).toBe(0);
  });

  it('a quote is bound to its item: a quote for one ₦1,000 piece, or a plain fee quote, does not pay another', async () => {
    const p = await buyer(1_000_000);
    const forB = await quoted(p, 'content_unlock', 'piece-1000b');
    const res = await pay(p, payBody(forB, { targetId: 'piece-1000c' }));
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('quote_changed');
    expect(body(res).reason?.paymentQuote?.targetId).toBe('piece-1000c');
    const fee = await request(app.getHttpServer())
      .get('/api/hub/money/fees/quote?kind=purchase&amountKobo=100000')
      .set('Authorization', p.auth);
    const feeToken = body<{ quoteToken: string }>(fee).data!.quoteToken;
    const res2 = await pay(p, payBody(forB, { quoteToken: feeToken }));
    expect(body(res2).reason?.code).toBe('quote_changed');
    expect(sendsFrom(p)).toHaveLength(0);
  });

  it("the payer's wallet being WAWU's merchant wallet is refused before anything is sent", async () => {
    const p = await buyer(1_000_000);
    await prisma.fintavaWallet.update({
      where: { wawuUserId: p.id },
      data: { accountNumber: MERCHANT_ACCOUNT },
    });
    wallets.byId.set(p.walletId, MERCHANT_ACCOUNT);
    wallets.kobo.set(MERCHANT_ACCOUNT, 1_000_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    const res = await pay(p, payBody(q));
    expect(res.status).toBe(503);
    expect(body(res).reason?.code).toBe('provider_unreachable');
    expect(
      wallets.sends.filter((s) => s.from === MERCHANT_ACCOUNT),
    ).toHaveLength(0);
    await prisma.fintavaWallet.update({
      where: { wawuUserId: p.id },
      data: { accountNumber: p.accountNumber },
    });
  });

  it('Fintava moving another amount than the price: review, still pending, not delivered, the item blocked', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'piece-1000');
    wallets.mode = 'wrongamount';
    const res = await pay(p, payBody(q));
    wallets.mode = 'live';
    const paid = body<PaymentView>(res).data!;
    expect(paid.status).toBe('pending');
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toMatch(/amountKobo/);
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(0);
    expect(
      body(
        await pay(p, payBody(await quoted(p, 'content_unlock', 'piece-1000'))),
      ).reason?.code,
    ).toBe('payment_in_progress');
  });

  it('8 payments at once with the right PIN under 8 keys: all paid, the PIN never locks', async () => {
    const p = await buyer(10_000_000);
    const items = [
      'piece-1000',
      'piece-1000b',
      'piece-1000c',
      'piece-1000d',
      'piece-1000e',
      'piece-1000f',
      'piece-1000g',
      'piece-1000h',
    ];
    const qs = await Promise.all(
      items.map((t) => quoted(p, 'content_unlock', t)),
    );
    const answers = await Promise.all(qs.map((q) => pay(p, payBody(q))));
    expect(answers.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(await pinState(p)).toMatchObject({
      triesLeft: 5,
      lockedUntil: null,
    });
    expect(sendsFrom(p)).toHaveLength(8);
  });

  it("deleting the payer keeps the payment and the payee's unpaid 85%, with the payer side anonymised", async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'tip', creator.wawuUserId, '&amountKobo=200000');
    const paid = body<PaymentView>(
      await pay(p, payBody(q, { amountKobo: 200_000, note: 'For you' })),
    ).data!;
    await new AccountPurgeService(prisma).purge(p.id);
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect({
      payer: row.payerWawuUserId,
      account: row.payerAccountNumber,
      note: row.note,
      payee: row.payeeWawuUserId,
      share: row.payeeShareKobo,
      settled: row.payeeSettledAt,
      status: row.status,
    }).toEqual({
      payer: null,
      account: null,
      note: null,
      payee: creator.wawuUserId,
      share: 170_000n,
      settled: null,
      status: 'completed',
    });
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    await prisma.walletPayment.delete({ where: { id: paid.id } });
  });

  it('the stored answers are scoped to the route that answered them', () => {
    expect(PAY_ROUTE).toBe('POST money/payments');
  });
});
