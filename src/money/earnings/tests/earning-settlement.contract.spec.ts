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
import { FintavaWebhookModule } from '../../../fintava/webhook/fintava-webhook.module';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../../wallet-provider/wallet-provider.interface';
import { FeeQuoteService } from '../../fees/fee-quote.service';
import { WalletHoldService } from '../../holds/wallet-hold.service';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type {
  EarningContentPage,
  EarningsView,
  PaymentQuoteView,
  PaymentView,
} from '../../money-view.type';
import {
  type CompletedPayment,
  PayableRegistry,
} from '../../payments/payable-registry';
import { PaymentSettings } from '../../payments/payment-config';
import { WalletPaymentService } from '../../payments/wallet-payment.service';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { EarningSettlementService } from '../earning-settlement.service';
import { earningReference } from '../earning-rules';

/**
 * A sale's 85% lands in the payee's wallet by itself (task WALLET-16, R-11)
 * on the Fintava adapter: the real MoneyModule, a real database, real RS256
 * tokens checked against the stand-in WAWU ID's JWKS, and the real Fintava
 * client over a socket to FintavaDouble.
 *
 * The double plays Fintava's wallets, WAWU's merchant wallet among them: it
 * holds a balance per wallet, takes a wallet-to-wallet send from any of them
 * and charges the dashboard's balance-transfer rate on top
 * (`docs/fintava/fees.md`). Ordinary kinds (`content_unlock`, `tip`) are
 * registered the way a selling feature will register its own, and so is one
 * held kind (`paid_dm`) to show the two never overlap.
 */

const BASE = '/api/hub/money';
const MONEY_TIMEOUT_MS = 120_000;
const PIN = '6215';

jest.setTimeout(300_000);

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `earn-${sub}@test.wawu.dev`,
      phone: '+2348000009916',
      firstName: 'Earning',
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
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response) => res.body as Envelope<T>;

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

/** The dashboard's balance-transfer charge (`fees.md`), in kobo. */
const liveFee = (amountKobo: number) => (amountKobo < 500_000 ? 2325 : 1575);

/** The payee's 85%, rounded down to the kobo (R-5), worked out here and not by the code under test. */
const shareOf = (priceKobo: number) => Math.floor((priceKobo * 85) / 100);

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
  /** Every send request that reached the double, taken or not. */
  readonly attempts: string[] = [];
  mode: 'live' | 'timeout' | 'error500' | 'refuse' | 'wrongamount' = 'live';
  readonly frozen = new Set<string>();
  readonly hidden = new Set<string>();
  readonly failures = new Set<string>();
  gate: Promise<void> | null = null;
}

describe('Earnings land in the wallet by themselves (WALLET-16) on Fintava', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let earnings: EarningSettlementService;
  let holds: WalletHoldService;
  let payments: WalletPaymentService;
  let provider: WalletProvider;
  let ledger: LedgerService;
  let fees: FeeQuoteService;
  let settings: PaymentSettings;
  let cheapPinHash: string;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const previous: Record<string, string | undefined> = {};
  const startedAt = new Date();
  let accountSeq = 0;
  /** What each target costs and who is owed it. */
  const targets = new Map<
    string,
    { priceKobo: number; payee: string | null }
  >();
  /** A target whose delivery fails while it is listed here. */
  const failingDelivery = new Set<string>();
  /** The sweep's clock: always ahead of the last one, so each is due. */
  let clock = Date.now();
  const later = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  type Person = {
    id: string;
    auth: string;
    walletId: string;
    accountNumber: string;
  };

  /** A person with an open wallet holding `kobo`, the PIN set. */
  async function person(kobo: number, withPin = true): Promise<Person> {
    const p = noWallet();
    if (withPin) {
      await prisma.transactionPin.create({
        data: { wawuUserId: p.id, pinHash: cheapPinHash },
      });
    }
    return openWallet(p, kobo);
  }

  /** A person with no wallet at all (a creator who has not opened one). */
  function noWallet(): Person {
    const id = randomUUID();
    users.push(id);
    return {
      id,
      auth: `Bearer ${mintToken(id)}`,
      walletId: '',
      accountNumber: '',
    };
  }

  /** The person opens their wallet now (its row is the whole of "open"). */
  async function openWallet(p: Person, kobo = 0): Promise<Person> {
    accountSeq += 1;
    p.accountNumber = `16${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    p.walletId = randomUUID();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: p.id,
        customerId: randomUUID(),
        walletId: p.walletId,
        accountNumber: p.accountNumber,
      },
    });
    wallets.kobo.set(p.accountNumber, kobo);
    wallets.byId.set(p.walletId, p.accountNumber);
    return p;
  }

  /** Something for sale: its target id. */
  function listing(
    payee: Person | null,
    priceKobo = 200_000,
    prefix = 'unlock',
  ): string {
    const id = `${prefix}-${randomUUID()}`;
    targets.set(id, { priceKobo, payee: payee ? payee.id : null });
    return id;
  }

  const balanceOf = (p: Pick<Person, 'accountNumber'>) =>
    wallets.kobo.get(p.accountNumber) ?? 0;
  const merchantBalance = () => wallets.kobo.get(MERCHANT_ACCOUNT) ?? 0;
  const sendsOf = (reference: string) =>
    wallets.sends.filter((s) => s.reference === reference);
  const attemptsOf = (reference: string) =>
    wallets.attempts.filter((r) => r === reference).length;

  async function quoted(
    p: Person,
    kind: string,
    targetId: string,
    amountKobo?: number,
  ): Promise<PaymentQuoteView> {
    const res = await request(app.getHttpServer())
      .get(
        `${BASE}/payments/quote?kind=${kind}&targetId=${targetId}${amountKobo ? `&amountKobo=${amountKobo}` : ''}`,
      )
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    return body<PaymentQuoteView>(res).data!;
  }

  /** Pays for something and returns the payment (it must complete at once). */
  async function sale(
    p: Person,
    kind: 'content_unlock' | 'tip' | 'paid_dm',
    targetId: string,
    amountKobo?: number,
  ): Promise<PaymentView> {
    const q = await quoted(p, kind, targetId, amountKobo);
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
    return view;
  }

  const settlementOf = (paymentId: string) =>
    prisma.earningSettlement.findUnique({ where: { paymentId } });
  const settlementOrThrow = (paymentId: string) =>
    prisma.earningSettlement.findUniqueOrThrow({ where: { paymentId } });
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
  /** One pass of the sweep, on a clock that is always ahead. */
  const pass = (ms?: number) => earnings.sweep(later(ms));

  function getEarnings(p: Person, query = '') {
    return request(app.getHttpServer())
      .get(`${BASE}/earnings${query}`)
      .set('Authorization', p.auth);
  }
  function getContent(p: Person, query = '') {
    return request(app.getHttpServer())
      .get(`${BASE}/earnings/content${query}`)
      .set('Authorization', p.auth);
  }

  /**
   * A finished sale written straight into the tables (a view test needs
   * exact times and amounts, not a payment through the double): the payment
   * and its earning, as the sweep would have made them.
   */
  async function seedSale(o: {
    payee: Person;
    kind?: string;
    targetId: string;
    title: string;
    priceKobo: number;
    completedAt: Date;
    landed?: boolean;
  }): Promise<string> {
    const id = randomUUID();
    const share = shareOf(o.priceKobo);
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: null,
        kind: o.kind ?? 'content_unlock',
        targetId: o.targetId,
        title: o.title,
        payeeWawuUserId: o.payee.id,
        priceKobo: BigInt(o.priceKobo),
        providerFeeKobo: 2325n,
        wawuFeeKobo: 0n,
        totalKobo: BigInt(o.priceKobo + 2325),
        payeeShareKobo: BigInt(share),
        wawuShareKobo: BigInt(o.priceKobo - share),
        customerReference: `wawu-pay-${id}`,
        merchantAccountNumber: MERCHANT_ACCOUNT,
        provider: 'fintava',
        status: 'completed',
        completedAt: o.completedAt,
      },
    });
    seeded.push(id);
    await prisma.earningSettlement.create({
      data: {
        paymentId: id,
        payeeWawuUserId: o.payee.id,
        kind: o.kind ?? 'content_unlock',
        targetId: o.targetId,
        title: o.title,
        earnedAt: o.completedAt,
        amountKobo: BigInt(share),
        merchantAccountNumber: MERCHANT_ACCOUNT,
        provider: 'fintava',
        customerReference: earningReference(id, 1),
        ...(o.landed
          ? {
              status: 'landed',
              settledAt: o.completedAt,
              sentAt: o.completedAt,
              destinationAccountNumber: o.payee.accountNumber || '0000000000',
            }
          : {}),
      },
    });
    return id;
  }
  const seeded: string[] = [];

  function installFintava() {
    double.reset();
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
    });
    double.on('GET', /^\/customer\/wallet\/balance\//, (req: SeenRequest) => {
      const id = req.path.split('/').pop()!;
      const account = wallets.byId.get(id);
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
      if (wallets.failures.has(ref)) {
        return {
          status: 200,
          body: recordFor(ref, 'FAILURE', '0.00'),
        };
      }
      if (!send || wallets.hidden.has(ref)) {
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
    double.on(
      'POST',
      '/transaction/wallet-to-wallet',
      async (req: SeenRequest) => {
        const b = req.body as {
          senderAccount: string;
          receiverAccount: string;
          amount: number;
          CustomerReference: string;
        };
        wallets.attempts.push(b.CustomerReference);
        if (wallets.gate) await wallets.gate;
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
        if (
          wallets.frozen.has(b.senderAccount) ||
          wallets.frozen.has(b.receiverAccount)
        ) {
          return {
            status: 400,
            body: fintavaError(
              400,
              'Kindly confirm both customer accounts are active',
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
          hangUp: mode === 'timeout',
          body: {
            data: {
              amount: amountKobo / 100,
              reference: `tagapay${randomUUID().replace(/-/g, '')}`,
              customerReference: randomUUID(),
              total: (amountKobo + feeKobo) / 100,
              transaction_fee: feeKobo / 100,
              source_customer_id: randomUUID(),
              source_customer_accname: 'Earning Tester',
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
    cheapPinHash = await argon2.hash(PIN, {
      type: argon2.argon2id,
      timeCost: 1,
      memoryCost: 1024,
      parallelism: 1,
    });
    await double.start();
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_w16_earn_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FEE_QUOTE_KEY: 'w16-test-fee-quote-key-0123456789abcdef0123',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      FINTAVA_WEBHOOK_SECRET: 'whsec_local_w16_earn_Qv7Lp3Xc9Ty2Hb5Jn',
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
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
    holds = moduleRef.get(WalletHoldService);
    earnings = moduleRef.get(EarningSettlementService);
    provider = moduleRef.get<WalletProvider>(WALLET_PROVIDER);
    ledger = moduleRef.get(LedgerService);
    fees = moduleRef.get(FeeQuoteService);
    settings = moduleRef.get(PaymentSettings);

    // WAWU's own money (its 15% shares and fees), so a move out of the
    // merchant wallet can pay Fintava's charge as well as the amount.
    wallets.kobo.set(MERCHANT_ACCOUNT, 5_000_000);

    const registry = moduleRef.get(PayableRegistry);
    for (const kind of ['content_unlock', 'tip', 'paid_dm'] as const) {
      registry.register({
        kind,
        resolve: async ({ targetId, amountKobo }) => {
          await Promise.resolve();
          const t = targets.get(targetId);
          if (!t) throw new MoneyError('target_not_found', 'That is gone.');
          return {
            title: `A ${kind} ${targetId.slice(-4)}`,
            priceKobo:
              kind === 'tip' ? (amountKobo ?? t.priceKobo) : t.priceKobo,
            payee: t.payee
              ? {
                  wawuUserId: t.payee,
                  displayName: 'Ada Lovelace',
                  handle: 'ada',
                  avatarUrl: null,
                  tick: 'creator' as const,
                }
              : null,
          };
        },
        onCompleted: async (p) => {
          await Promise.resolve();
          if (failingDelivery.has(p.targetId)) {
            throw new Error('the feature could not deliver yet');
          }
          delivered.push(p);
        },
      });
    }
  });

  afterAll(async () => {
    if (prisma) {
      // Every earning this run made (it also takes any finished sale a
      // neighbouring suite left behind), then the payments, holds and rows
      // of the people made here.
      await prisma.earningSettlement.deleteMany({
        where: { createdAt: { gte: startedAt } },
      });
      const rows = await prisma.walletPayment.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { payeeWawuUserId: { in: users } },
            { id: { in: seeded } },
          ],
        },
        select: { id: true, customerReference: true },
      });
      const ids = rows.map((r) => r.id);
      const holdRows = await prisma.walletHold.findMany({
        where: { paymentId: { in: ids } },
        select: { customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            {
              customerReference: {
                in: [
                  ...rows.map((r) => r.customerReference),
                  ...holdRows
                    .map((h) => h.customerReference)
                    .filter((r): r is string => !!r),
                ],
              },
            },
            { customerReference: { startsWith: 'wawu-earn-' } },
          ],
        },
      });
      await prisma.earningSettlement.deleteMany({
        where: { paymentId: { in: ids } },
      });
      await prisma.walletHold.deleteMany({ where: { paymentId: { in: ids } } });
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
    await double.stop();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    wallets.mode = 'live';
    wallets.gate = null;
    wallets.frozen.clear();
    failingDelivery.clear();
  });

  // -------------------------------------------------------------------------
  // The task's two capability checks
  // -------------------------------------------------------------------------

  it('check 1: what a creator is shown as earned is the sum of their sales after the 85/15 split, to the kobo, and it is what reached their wallet', async () => {
    const creator = await person(0, false);
    const buyers = [
      await person(2_000_000),
      await person(2_000_000),
      await person(2_000_000),
    ];
    // Prices with a kobo that does not divide: the share rounds down, WAWU
    // keeps the rest (R-5). One unlock, one more unlock, two tips.
    const unlockA = listing(creator, 200_001);
    const unlockB = listing(creator, 99_999);
    const tipTarget = listing(creator, 1);
    const pays: PaymentView[] = [
      await sale(buyers[0], 'content_unlock', unlockA),
      await sale(buyers[1], 'content_unlock', unlockB),
      await sale(buyers[0], 'content_unlock', unlockB),
      await sale(buyers[2], 'tip', tipTarget, 12_345),
      await sale(buyers[1], 'tip', tipTarget, 7),
    ];
    const prices = [200_001, 99_999, 99_999, 12_345, 7];
    const expected = prices.reduce((sum, p) => sum + shareOf(p), 0);
    expect(expected).toBe(170_000 + 84_999 + 84_999 + 10_493 + 5);

    // Before the sweep nothing has moved: the creator's wallet is empty and
    // the sales sit in WAWU's account.
    expect(balanceOf(creator)).toBe(0);
    const merchantBefore = merchantBalance();

    const result = await pass();
    expect(result.adopted).toBeGreaterThanOrEqual(pays.length);

    // The provider's balance is the truth: the creator got exactly the shares.
    expect(balanceOf(creator)).toBe(expected);
    // WAWU's account paid out the shares and Fintava's charge on each move (R-31).
    const moves = pays.map((p) => sendsOf(earningReference(p.id, 1)));
    for (const m of moves) expect(m).toHaveLength(1);
    const charges = moves.reduce((sum, m) => sum + m[0].feeKobo, 0);
    expect(merchantBefore - merchantBalance()).toBe(expected + charges);

    // What the creator is shown.
    const res = await getEarnings(creator);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const view = body<EarningsView>(res).data!;
    expect(view.allTime.earnedKobo).toBe(expected);
    expect(view.allTime.sales).toBe(pays.length);
    expect(view.allTime.streams).toEqual([
      {
        kind: 'content_unlock',
        earnedKobo: 170_000 + 84_999 + 84_999,
        sales: 3,
      },
      { kind: 'tip', earnedKobo: 10_493 + 5, sales: 2 },
    ]);
    expect(view.allTime.streams.reduce((sum, s) => sum + s.earnedKobo, 0)).toBe(
      expected,
    );
    expect(view.thisMonth.earnedKobo).toBe(expected);
    expect(view.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(view.held).toEqual({ count: 0, amountKobo: 0 });
    expect(view.walletOpen).toBe(true);

    // Piece by piece: every page together is the month's total.
    const seen: Array<{ targetId: string; earnedKobo: number; sales: number }> =
      [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: Response = await getContent(
        creator,
        `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
      expect(page.status).toBe(200);
      const data = body<EarningContentPage>(page).data!;
      expect(data.items.length).toBeLessThanOrEqual(1);
      seen.push(...data.items);
      cursor = data.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen.map((s) => s.targetId)).toEqual([unlockA, unlockB, tipTarget]);
    expect(seen.map((s) => s.earnedKobo)).toEqual([
      170_000,
      84_999 + 84_999,
      10_493 + 5,
    ]);
    expect(seen.reduce((sum, s) => sum + s.earnedKobo, 0)).toBe(expected);
    expect(seen.reduce((sum, s) => sum + s.sales, 0)).toBe(pays.length);

    // The wallet's own history shows each earning once, linked to the sale.
    for (const p of pays) {
      const rows = await ledgerRows(earningReference(p.id, 1));
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.direction).sort()).toEqual(['in', 'out']);
      for (const r of rows) {
        expect(r.status).toBe('completed');
        expect(r.category).toBe('earning');
        expect(r.paymentId).toBeNull();
        expect(r.linkKind).toBe(p.kind);
      }
      const done = await settlementOrThrow(p.id);
      expect(done.status).toBe('landed');
      expect(done.destinationAccountNumber).toBe(creator.accountNumber);
      const paid = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: p.id },
      });
      expect(paid.payeeSettledAt).not.toBeNull();
    }
    // The money never shows as a balance: the earnings read has no such field.
    expect(Object.keys(view).sort()).toEqual([
      'allTime',
      'held',
      'month',
      'thisMonth',
      'waiting',
      'walletOpen',
    ]);
  });

  it('check 2: a creator with no wallet keeps earning, sees the money waiting, opens a wallet and it lands once', async () => {
    const creator = noWallet();
    const buyer = await person(1_000_000);
    const target = listing(creator, 250_000);
    const paid = await sale(buyer, 'content_unlock', target);
    const reference = earningReference(paid.id, 1);
    const merchantBefore = merchantBalance();

    await pass();
    const waiting = await settlementOrThrow(paid.id);
    expect(waiting.status).toBe('owed');
    expect(waiting.waiting).toBe('payee_wallet');
    expect(attemptsOf(reference)).toBe(0);
    expect(merchantBalance()).toBe(merchantBefore);

    // She sees what she earned and that it is waiting, not a balance.
    const before = body<EarningsView>(await getEarnings(creator)).data!;
    expect(before.walletOpen).toBe(false);
    expect(before.allTime.earnedKobo).toBe(shareOf(250_000));
    expect(before.thisMonth.earnedKobo).toBe(shareOf(250_000));
    expect(before.waiting).toEqual({
      count: 1,
      amountKobo: shareOf(250_000),
    });
    // The routes work without a wallet: no 409 wallet_not_open.
    expect((await getContent(creator)).status).toBe(200);

    // More passes while she has no wallet: nothing is sent, nothing is lost.
    for (let i = 0; i < 4; i += 1) await pass(30 * 60_000);
    expect(attemptsOf(reference)).toBe(0);
    expect((await settlementOrThrow(paid.id)).status).toBe('owed');

    // She opens her wallet. The very next pass lands it, whatever it had rested.
    await openWallet(creator, 0);
    const woke = await settlementOrThrow(paid.id);
    expect(woke.nextAttemptAt).not.toBeNull();
    await earnings.sweep(new Date(Date.now() + 1_000));
    expect(balanceOf(creator)).toBe(shareOf(250_000));
    expect(sendsOf(reference)).toHaveLength(1);
    const landed = await settlementOrThrow(paid.id);
    expect(landed.status).toBe('landed');
    expect(landed.destinationAccountNumber).toBe(creator.accountNumber);

    // Once: more passes, and the same earning asked for again, move nothing.
    for (let i = 0; i < 3; i += 1) await pass();
    await earnings.drive(landed.id, later());
    expect(sendsOf(reference)).toHaveLength(1);
    expect(balanceOf(creator)).toBe(shareOf(250_000));

    const after = body<EarningsView>(await getEarnings(creator)).data!;
    expect(after.walletOpen).toBe(true);
    expect(after.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(after.allTime.earnedKobo).toBe(shareOf(250_000));
    expect(await ledgerRows(reference)).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Exactly once
  // -------------------------------------------------------------------------

  it('lands once under a replay: the sweep run many times, and the earning driven again and again, send one move', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    const reference = earningReference(paid.id, 1);

    for (let i = 0; i < 6; i += 1) await pass();
    const row = await settlementOrThrow(paid.id);
    for (let i = 0; i < 4; i += 1) await earnings.drive(row.id, later());
    expect(sendsOf(reference)).toHaveLength(1);
    expect(attemptsOf(reference)).toBe(1);
    expect(balanceOf(creator)).toBe(85_000);
    expect(await ledgerRows(reference)).toHaveLength(2);
    expect(
      await prisma.earningSettlement.count({ where: { paymentId: paid.id } }),
    ).toBe(1);
  });

  it('lands once between two Hub processes: two services on one database, both sweeping and driving at the same moment', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 120_000));
    const reference = earningReference(paid.id, 1);
    // A second process: its own service, the same database and provider.
    const other = new EarningSettlementService(
      prisma,
      provider,
      ledger,
      fees,
      settings,
    );

    // The provider holds the first move open until every caller has had its
    // chance to start one, so two sends could only happen by a lost lease.
    let release!: () => void;
    wallets.gate = new Promise<void>((r) => (release = r));
    const now = later();
    const runs = Promise.all([
      earnings.sweep(now),
      other.sweep(now),
      other.sweep(now),
    ]);
    // Wait until the winner has reached the provider, give the others time,
    // then let it answer.
    for (let i = 0; i < 400 && attemptsOf(reference) < 1; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 300));
    release();
    await runs;
    const row = await settlementOrThrow(paid.id);
    await Promise.all([
      earnings.drive(row.id, later()),
      other.drive(row.id, later()),
    ]);
    expect(attemptsOf(reference)).toBe(1);
    expect(sendsOf(reference)).toHaveLength(1);
    expect(balanceOf(creator)).toBe(102_000);
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    expect(await ledgerRows(reference)).toHaveLength(2);
  });

  it('a crash between the provider moving the money and our write: found again by its reference, never sent again', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    const reference = earningReference(paid.id, 1);
    // The process dies after the provider answered and before anything was
    // written here: this one earning's landing throws, as a killed process
    // would, and every other earning lands as usual.
    const real = (
      earnings as unknown as {
        land: (
          s: { paymentId: string },
          ...rest: unknown[]
        ) => Promise<unknown>;
      }
    ).land.bind(earnings);
    const spy = jest
      .spyOn(earnings as unknown as { land: typeof real }, 'land')
      .mockImplementation((s, ...rest) =>
        s.paymentId === paid.id
          ? Promise.reject(new Error('killed after the provider answered'))
          : real(s, ...rest),
      );
    await pass();
    spy.mockRestore();
    // The money moved at the provider; nothing was written here.
    expect(sendsOf(reference)).toHaveLength(1);
    expect(balanceOf(creator)).toBe(85_000);
    const midway = await settlementOrThrow(paid.id);
    expect(midway.status).toBe('owed');
    expect(midway.sentAt).not.toBeNull();
    expect(await ledgerRows(reference)).toHaveLength(0);
    const payment = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(payment.payeeSettledAt).toBeNull();

    // A restarted Hub finds it by its reference once the lease has ended
    // (the money timeout and the provider's resend safety, 12 minutes here).
    expect(midway.nextAttemptAt!.getTime() - midway.sentAt!.getTime()).toBe(
      MONEY_TIMEOUT_MS + provider.timings.resendSafetyMs,
    );
    await earnings.drive(midway.id, later(30 * 60_000));
    const done = await settlementOrThrow(paid.id);
    expect(done.status).toBe('landed');
    expect(attemptsOf(reference)).toBe(1);
    expect(sendsOf(reference)).toHaveLength(1);
    expect(balanceOf(creator)).toBe(85_000);
    expect(await ledgerRows(reference)).toHaveLength(2);
    expect(
      (
        await prisma.walletPayment.findUniqueOrThrow({
          where: { id: paid.id },
        })
      ).payeeSettledAt,
    ).not.toBeNull();
  });

  it('a lost answer (the provider took it, the line dropped) is asked about, found, and never sent under a new reference', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 300_000));
    const reference = earningReference(paid.id, 1);
    wallets.mode = 'timeout';
    await pass();
    const lost = await settlementOrThrow(paid.id);
    expect(lost.status).toBe('owed');
    expect(lost.sentAt).not.toBeNull();
    expect(sendsOf(reference)).toHaveLength(1);

    wallets.mode = 'live';
    await pass(10 * 60_000);
    const done = await settlementOrThrow(paid.id);
    expect(done.status).toBe('landed');
    expect(done.customerReference).toBe(reference);
    expect(attemptsOf(reference)).toBe(1);
    expect(balanceOf(creator)).toBe(255_000);
    expect(
      wallets.attempts.filter((r) => r.startsWith(`wawu-earn-${paid.id}`)),
    ).toHaveLength(1);
  });

  it('silence is never proof that no money moved: an unknown outcome is asked about, not resent, and goes to a person at the bound', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    const reference = earningReference(paid.id, 1);
    wallets.mode = 'error500';
    await pass();
    const unknown = await settlementOrThrow(paid.id);
    expect(unknown.sentAt).not.toBeNull();
    expect(unknown.waiting).toBeNull();
    // The provider now answers, but has no record of it (absent).
    wallets.mode = 'live';
    for (let i = 0; i < 5; i += 1) await pass(2 * 60 * 60_000);
    expect(attemptsOf(reference)).toBe(1);
    expect((await settlementOrThrow(paid.id)).status).toBe('owed');
    expect(balanceOf(creator)).toBe(0);
    // Past the review bound a person looks; the earning is not sent again.
    await earnings.drive(
      unknown.id,
      new Date(
        unknown.sentAt!.getTime() + (settings.reviewAfterHours + 1) * 3_600_000,
      ),
    );
    const review = await settlementOrThrow(paid.id);
    expect(review.reviewSince).not.toBeNull();
    expect(review.discrepancy).toContain('may have moved');
    await pass();
    expect(attemptsOf(reference)).toBe(1);
  });

  it("only the provider's own record that a move failed starts a new try, under a new reference", async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    const first = earningReference(paid.id, 1);
    wallets.mode = 'error500';
    await pass();
    wallets.mode = 'live';
    wallets.failures.add(first); // the provider's record: the move failed
    await pass(10 * 60_000);
    const retry = await settlementOrThrow(paid.id);
    expect(retry.attempt).toBe(2);
    expect(retry.customerReference).toBe(earningReference(paid.id, 2));
    expect(retry.sentAt).toBeNull();
    expect(balanceOf(creator)).toBe(0);
    await pass(2 * 60 * 60_000);
    const done = await settlementOrThrow(paid.id);
    expect(done.status).toBe('landed');
    expect(sendsOf(earningReference(paid.id, 2))).toHaveLength(1);
    expect(sendsOf(first)).toHaveLength(0);
    expect(balanceOf(creator)).toBe(85_000);
  });

  it('a wallet that the provider has frozen waits and is paid on unfreeze; the money stays in WAWU’s account meanwhile', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    wallets.frozen.add(creator.accountNumber);
    await pass();
    const frozen = await settlementOrThrow(paid.id);
    expect(frozen.status).toBe('owed');
    expect(frozen.waiting).toBe('recipient_frozen');
    expect(frozen.sentAt).toBeNull();
    expect(balanceOf(creator)).toBe(0);
    wallets.frozen.clear();
    await pass(2 * 60 * 60_000);
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    expect(balanceOf(creator)).toBe(85_000);
  });

  it('another amount than the share is a stop for a person, with the ledger untouched', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    wallets.mode = 'wrongamount';
    await pass();
    const row = await settlementOrThrow(paid.id);
    expect(row.status).toBe('owed');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toContain(
      'moved 85100 kobo for an earning of 85000',
    );
    expect(await ledgerRows(earningReference(paid.id, 1))).toHaveLength(0);
    const payment = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(payment.payeeSettledAt).toBeNull();
  });

  // -------------------------------------------------------------------------
  // What is an earning, and what is not
  // -------------------------------------------------------------------------

  it('a held kind never makes an earning here: its share lands by the hold release, once, and counts once', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const dm = listing(creator, 100_000, 'dm');
    const paid = await sale(buyer, 'paid_dm', dm);
    const hold = await prisma.walletHold.findUniqueOrThrow({
      where: { paymentId: paid.id },
    });
    await pass();
    expect(await settlementOf(paid.id)).toBeNull();

    // Held: paid for, not earned yet.
    const held = body<EarningsView>(await getEarnings(creator)).data!;
    expect(held.allTime.earnedKobo).toBe(0);
    expect(held.held).toEqual({ count: 1, amountKobo: 85_000 });

    // The creator answers: the owning feature releases it.
    const released = await holds.release({ paymentId: paid.id });
    expect(released.state).toBe('settled');
    expect(balanceOf(creator)).toBe(85_000);
    await pass();
    expect(await settlementOf(paid.id)).toBeNull();
    const after = body<EarningsView>(await getEarnings(creator)).data!;
    expect(after.allTime.earnedKobo).toBe(85_000);
    expect(after.allTime.streams).toEqual([
      { kind: 'paid_dm', earnedKobo: 85_000, sales: 1 },
    ]);
    expect(after.held).toEqual({ count: 0, amountKobo: 0 });
    expect(after.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect(sendsOf(earningReference(paid.id, 1))).toHaveLength(0);
    expect(balanceOf(creator)).toBe(85_000);
  });

  it('a released hold waiting for the payee’s wallet is earned and waiting, and counted once beside ordinary sales', async () => {
    const creator = noWallet();
    const buyer = await person(2_000_000);
    const paidDm = await sale(
      buyer,
      'paid_dm',
      listing(creator, 100_000, 'dm'),
    );
    const paidUnlock = await sale(
      buyer,
      'content_unlock',
      listing(creator, 200_000),
    );
    await holds.release({ paymentId: paidDm.id });
    await pass();
    const view = body<EarningsView>(await getEarnings(creator)).data!;
    expect(view.allTime.earnedKobo).toBe(85_000 + 170_000);
    expect(view.waiting).toEqual({ count: 2, amountKobo: 85_000 + 170_000 });
    expect(view.walletOpen).toBe(false);
    expect(view.allTime.streams.map((s) => s.kind).sort()).toEqual([
      'content_unlock',
      'paid_dm',
    ]);
    // She opens a wallet: both land, once each.
    await openWallet(creator, 0);
    await earnings.sweep(new Date(Date.now() + 1_000));
    await holds.sweep(new Date(Date.now() + 1_000));
    expect(balanceOf(creator)).toBe(255_000);
    expect(sendsOf(earningReference(paidUnlock.id, 1))).toHaveLength(1);
    const after = body<EarningsView>(await getEarnings(creator)).data!;
    expect(after.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(after.allTime.earnedKobo).toBe(255_000);
  });

  it('a payment not yet delivered, or under review, is not an earning until it is finished', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const target = listing(creator, 100_000);
    failingDelivery.add(target);
    const paid = await sale(buyer, 'content_unlock', target);
    expect(paid.status).toBe('completed');
    await pass();
    // Paid, but what was paid for has not reached the buyer: nothing is landed.
    expect(await settlementOf(paid.id)).toBeNull();
    expect(balanceOf(creator)).toBe(0);
    // The feature delivers (the sweep delivers again): the earning follows.
    failingDelivery.clear();
    await payments.sweep(new Date(Date.now() + 60 * 60_000));
    await pass();
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    expect(balanceOf(creator)).toBe(85_000);

    // A sale a person holds in review is not landed until they clear it.
    const target2 = listing(creator, 100_000);
    const paid2 = await sale(buyer, 'content_unlock', target2);
    await prisma.walletPayment.update({
      where: { id: paid2.id },
      data: { reviewSince: new Date(), discrepancy: 'a person is looking' },
    });
    await pass();
    expect(await settlementOf(paid2.id)).toBeNull();
    await prisma.walletPayment.update({
      where: { id: paid2.id },
      data: { reviewSince: null },
    });
    await pass();
    expect((await settlementOrThrow(paid2.id)).status).toBe('landed');
    expect(balanceOf(creator)).toBe(170_000);
  });

  it('a sale put under review after its earning was made stops the move before anything is sent', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    // A sale whose charge is in question is not made an earning at all.
    const flagged = await sale(
      buyer,
      'content_unlock',
      listing(creator, 100_000),
    );
    await prisma.walletPayment.update({
      where: { id: flagged.id },
      data: { chargeReviewSince: new Date() },
    });
    await pass();
    expect(await settlementOf(flagged.id)).toBeNull();

    // An earning that exists, and then its sale is flagged: no send, a person looks.
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    const payment = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    const row = await prisma.earningSettlement.create({
      data: {
        paymentId: paid.id,
        payeeWawuUserId: creator.id,
        kind: payment.kind,
        targetId: payment.targetId,
        title: payment.title,
        earnedAt: payment.completedAt!,
        amountKobo: payment.payeeShareKobo,
        merchantAccountNumber: payment.merchantAccountNumber,
        provider: 'fintava',
        customerReference: earningReference(paid.id, 1),
      },
    });
    await prisma.walletPayment.update({
      where: { id: paid.id },
      data: { reviewSince: new Date() },
    });
    const result = await earnings.drive(row.id, later());
    expect(result.state).toBe('review');
    const after = await settlementOrThrow(paid.id);
    expect(after.reviewSince).not.toBeNull();
    expect(after.sentAt).toBeNull();
    expect(attemptsOf(earningReference(paid.id, 1))).toBe(0);
    expect(balanceOf(creator)).toBe(0);
  });

  it('a share under a kobo is no earning: nothing is owed and nothing moves', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'tip', listing(creator, 1, 'tip'), 1);
    await pass();
    expect(shareOf(1)).toBe(0);
    expect(await settlementOf(paid.id)).toBeNull();
    const view = body<EarningsView>(await getEarnings(creator)).data!;
    expect(view.allTime.earnedKobo).toBe(0);
    expect(view.allTime.sales).toBe(0);
    expect(balanceOf(creator)).toBe(0);
  });

  it('a payment of WAWU itself (no payee) makes no earning', async () => {
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(null, 100_000));
    await pass();
    expect(await settlementOf(paid.id)).toBeNull();
  });

  it('another provider’s sale is left alone by this server, and so is a payee’s wallet of the other provider', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    await prisma.walletPayment.update({
      where: { id: paid.id },
      data: { provider: 'nuvion' },
    });
    await pass();
    expect(await settlementOf(paid.id)).toBeNull();
    await prisma.walletPayment.update({
      where: { id: paid.id },
      data: { provider: 'fintava' },
    });
    // The creator's only wallet is the other provider's: not a place to send to.
    await prisma.fintavaWallet.update({
      where: { wawuUserId: creator.id },
      data: { provider: 'nuvion' },
    });
    await pass();
    const waiting = await settlementOrThrow(paid.id);
    expect(waiting.waiting).toBe('payee_wallet');
    expect(attemptsOf(earningReference(paid.id, 1))).toBe(0);
    await prisma.fintavaWallet.update({
      where: { wawuUserId: creator.id },
      data: { provider: 'fintava' },
    });
    await earnings.sweep(new Date(Date.now() + 1_000));
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
  });

  // -------------------------------------------------------------------------
  // The database holds the same rules
  // -------------------------------------------------------------------------

  it('the database refuses a second earning for a sale, an earning for a held payment, and a changed or landed earning', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, 'content_unlock', listing(creator, 100_000));
    await pass();
    const row = await settlementOrThrow(paid.id);
    const data = {
      paymentId: paid.id,
      payeeWawuUserId: creator.id,
      kind: row.kind,
      targetId: row.targetId,
      title: row.title,
      earnedAt: row.earnedAt,
      amountKobo: row.amountKobo,
      merchantAccountNumber: row.merchantAccountNumber,
      provider: 'fintava',
      customerReference: `${row.customerReference}-copy`,
    };
    // One earning per sale.
    await expect(prisma.earningSettlement.create({ data })).rejects.toThrow();
    // Not another share, another payee, or a reference of another sale.
    const second = await sale(
      buyer,
      'content_unlock',
      listing(creator, 100_000),
    );
    await expect(
      prisma.earningSettlement.create({
        data: {
          ...data,
          paymentId: second.id,
          amountKobo: 90_000n,
          customerReference: earningReference(second.id, 1),
        },
      }),
    ).rejects.toThrow(/another person, share, account or provider/);
    await expect(
      prisma.earningSettlement.create({
        data: {
          ...data,
          paymentId: second.id,
          customerReference: earningReference(paid.id, 1),
        },
      }),
    ).rejects.toThrow();
    // A held payment has a hold: no earning beside it.
    const dm = await sale(buyer, 'paid_dm', listing(creator, 100_000, 'dm'));
    await expect(
      prisma.earningSettlement.create({
        data: {
          ...data,
          paymentId: dm.id,
          customerReference: earningReference(dm.id, 1),
        },
      }),
    ).rejects.toThrow(/has a hold/);
    // And the other way round: a hold for a payment that has an earning.
    await expect(
      prisma.walletHold.create({
        data: {
          paymentId: paid.id,
          payerWawuUserId: null,
          payeeWawuUserId: creator.id,
          kind: 'content_unlock',
          targetId: row.targetId,
          title: 'x',
          releaseCondition: 'dm_answered',
          amountKobo: 100_000n,
          payeeShareKobo: 85_000n,
          wawuShareKobo: 15_000n,
          merchantAccountNumber: MERCHANT_ACCOUNT,
          heldAt: new Date(),
        },
      }),
    ).rejects.toThrow(/already has an earning settlement/);
    // What is owed, and to whom, never changes; a landed earning never changes.
    await expect(
      prisma.earningSettlement.update({
        where: { id: row.id },
        data: { amountKobo: 1n },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.earningSettlement.update({
        where: { id: row.id },
        data: { status: 'owed', settledAt: null },
      }),
    ).rejects.toThrow();
    // A landed row that loses its destination is refused.
    await expect(
      prisma.$executeRaw`UPDATE "EarningSettlement" SET "destinationAccountNumber" = NULL WHERE "id" = ${row.id}`,
    ).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // What a creator is shown
  // -------------------------------------------------------------------------

  it('the month and the streams: Lagos midnight decides the month, and every cut adds up to the same sales', async () => {
    const creator = noWallet();
    // 30 Sep 23:30 UTC is 1 Oct 00:30 in Lagos: October. 30 Sep 22:59 UTC is 23:59 on the 30th: September.
    await seedSale({
      payee: creator,
      targetId: 'edge-oct',
      title: 'October edge',
      priceKobo: 100_000,
      completedAt: new Date('2026-09-30T23:30:00.000Z'),
    });
    await seedSale({
      payee: creator,
      targetId: 'edge-sep',
      title: 'September edge',
      priceKobo: 200_000,
      completedAt: new Date('2026-09-30T22:59:59.999Z'),
      landed: true,
    });
    await seedSale({
      payee: creator,
      kind: 'tip',
      targetId: 'tip-oct',
      title: 'A tip',
      priceKobo: 50_001,
      completedAt: new Date('2026-10-05T10:00:00.000Z'),
    });
    await seedSale({
      payee: creator,
      targetId: 'edge-oct',
      title: 'October edge, renamed',
      priceKobo: 100_000,
      completedAt: new Date('2026-10-06T10:00:00.000Z'),
    });

    const oct = body<EarningsView>(
      await getEarnings(creator, '?month=2026-10'),
    ).data!;
    expect(oct.month).toBe('2026-10');
    expect(oct.thisMonth.earnedKobo).toBe(85_000 + 42_500 + 85_000);
    expect(oct.thisMonth.sales).toBe(3);
    expect(oct.thisMonth.streams).toEqual([
      { kind: 'content_unlock', earnedKobo: 170_000, sales: 2 },
      { kind: 'tip', earnedKobo: 42_500, sales: 1 },
    ]);
    const sep = body<EarningsView>(
      await getEarnings(creator, '?month=2026-09'),
    ).data!;
    expect(sep.thisMonth.earnedKobo).toBe(170_000);
    expect(sep.thisMonth.streams).toEqual([
      { kind: 'content_unlock', earnedKobo: 170_000, sales: 1 },
    ]);
    // All time is every month; the waiting figure is the part not landed.
    expect(oct.allTime.earnedKobo).toBe(85_000 + 170_000 + 42_500 + 85_000);
    expect(sep.allTime.earnedKobo).toBe(oct.allTime.earnedKobo);
    expect(oct.waiting).toEqual({
      count: 3,
      amountKobo: 85_000 + 42_500 + 85_000,
    });
    // A month with nothing is zero, not an error.
    const none = body<EarningsView>(
      await getEarnings(creator, '?month=2024-01'),
    ).data!;
    expect(none.thisMonth).toEqual({ earnedKobo: 0, sales: 0, streams: [] });

    // Per piece: the same sales, the latest title, largest first.
    const pieces = body<EarningContentPage>(
      await getContent(creator, '?month=2026-10'),
    ).data!;
    expect(pieces.month).toBe('2026-10');
    expect(
      pieces.items.map((i) => [i.targetId, i.earnedKobo, i.sales, i.title]),
    ).toEqual([
      ['edge-oct', 170_000, 2, 'October edge, renamed'],
      ['tip-oct', 42_500, 1, 'A tip'],
    ]);
    expect(pieces.items[0].lastAt).toBe('2026-10-06T10:00:00.000Z');
    expect(pieces.nextCursor).toBeNull();
    expect(pieces.items.reduce((sum, i) => sum + i.earnedKobo, 0)).toBe(
      oct.thisMonth.earnedKobo,
    );
  });

  it('a person reads only their own earnings, the routes need a sign-in, and a bad month or cursor is a plain 400', async () => {
    const mine = noWallet();
    const stranger = noWallet();
    await seedSale({
      payee: mine,
      targetId: 'mine-1',
      title: 'Mine',
      priceKobo: 100_000,
      completedAt: new Date(),
    });
    const theirs = body<EarningsView>(await getEarnings(stranger)).data!;
    expect(theirs.allTime).toEqual({ earnedKobo: 0, sales: 0, streams: [] });
    expect(theirs.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(
      body<EarningContentPage>(await getContent(stranger)).data!.items,
    ).toEqual([]);

    expect(
      (await request(app.getHttpServer()).get(`${BASE}/earnings`)).status,
    ).toBe(401);
    expect(
      (await request(app.getHttpServer()).get(`${BASE}/earnings/content`))
        .status,
    ).toBe(401);
    for (const q of [
      '?month=2026-13',
      '?month=2026-9',
      '?month=0000-01',
      '?month=nope',
    ]) {
      const res = await getEarnings(mine, q);
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
      expect(body(res).reason).toBeUndefined();
    }
    for (const q of [
      '?cursor=nope',
      '?cursor=e1.AAAA',
      '?limit=0',
      '?limit=101',
    ]) {
      const res = await getContent(mine, q);
      expect({ q, status: res.status }).toEqual({ q, status: 400 });
    }
    // A cursor belongs to the month it was given for.
    await seedSale({
      payee: mine,
      targetId: 'mine-2',
      title: 'Mine 2',
      priceKobo: 50_000,
      completedAt: new Date(),
    });
    const first = body<EarningContentPage>(
      await getContent(mine, '?limit=1'),
    ).data!;
    expect(first.nextCursor).not.toBeNull();
    const other = await getContent(
      mine,
      `?month=2020-01&cursor=${encodeURIComponent(first.nextCursor!)}`,
    );
    expect(other.status).toBe(400);
  });
});
