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
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { LedgerStatusService } from '../../ledger/ledger-status.service';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type {
  HoldPage,
  HoldView,
  PaymentQuoteView,
  PaymentView,
} from '../../money-view.type';
import {
  type CompletedPayment,
  PayableRegistry,
} from '../../payments/payable-registry';
import { WalletPaymentService } from '../../payments/wallet-payment.service';
import { HoldRequestError } from '../hold-rules';
import { WalletHoldService } from '../wallet-hold.service';

/**
 * Hold, release and refund (task MONEY-18, R-19) over HTTP and through the
 * service, on the Fintava adapter: the real MoneyModule, a real database,
 * real RS256 tokens checked against the stand-in WAWU ID's JWKS, and the real
 * Fintava client over a socket to FintavaDouble.
 *
 * The double plays Fintava's wallets, WAWU's merchant wallet among them: it
 * holds a balance per wallet, takes a wallet-to-wallet send from any of them
 * (the merchant wallet included) and charges the dashboard's balance-transfer
 * rate on top (`docs/fintava/fees.md`: ₦23.25 below ₦5,000). Held kinds are
 * registered the way a selling feature will register its own: `paid_dm`
 * (a creator is paid), `event_ticket` (a host is paid) and `bill` (WAWU
 * itself is paid).
 */

const BASE = '/api/hub/money';
const MONEY_TIMEOUT_MS = 120_000;
const PIN = '4826';

jest.setTimeout(300_000);

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `hold-${sub}@test.wawu.dev`,
      phone: '+2348000009918',
      firstName: 'Hold',
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
  mode: 'live' | 'timeout' | 'error500' | 'refuse' | 'wrongamount' = 'live';
  /** Accounts Fintava has frozen: a send into or out of one is refused. */
  readonly frozen = new Set<string>();
  /** References Fintava's lookup does not show yet. */
  readonly hidden = new Set<string>();
  /** References Fintava reports as FAILURE (and moved nothing). */
  readonly failures = new Set<string>();
  /** Held before a transfer is answered, until released. */
  gate: Promise<void> | null = null;
  arrived = 0;
}

/** Polls until `ok`. The cap only ends a hang; it is not what the test waits for. */
async function until(ok: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 2_400; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('until: the condition never held');
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

describe('Hold, release and refund (MONEY-18) on Fintava', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let holds: WalletHoldService;
  let statusChecks: LedgerStatusService;
  let cheapPinHash: string;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const wallets = new Wallets();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const previous: Record<string, string | undefined> = {};
  let accountSeq = 0;
  /** What each held target costs and who is owed it. */
  const targets = new Map<
    string,
    { priceKobo: number; payee: string | null }
  >();
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
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `18${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
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
    if (withPin) {
      await prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: cheapPinHash },
      });
    }
    return { id, auth: `Bearer ${mintToken(id)}`, walletId, accountNumber };
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

  /** A held item for sale: its target id. */
  function listing(
    payee: Person | null,
    priceKobo = 100_000,
    prefix = 'dm',
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
  /** Requests Fintava has seen that name this hold's reference (a lookup or a send). */
  const asked = (holdId: string) =>
    double.seen.filter(
      (r) =>
        r.path.includes(holdId) ||
        JSON.stringify(r.body ?? {}).includes(holdId),
    ).length;

  async function quoted(
    p: Person,
    kind: string,
    targetId: string,
  ): Promise<PaymentQuoteView> {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/payments/quote?kind=${kind}&targetId=${targetId}`)
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    return body<PaymentQuoteView>(res).data!;
  }

  function pay(p: Person, q: PaymentQuoteView, key: string = randomUUID()) {
    return request(app.getHttpServer())
      .post(`${BASE}/payments`)
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

  /** Pays for a held item and returns the payment (it must complete at once). */
  async function paid(
    p: Person,
    kind: 'paid_dm' | 'event_ticket' | 'bill',
    targetId: string,
  ): Promise<PaymentView> {
    const q = await quoted(p, kind, targetId);
    const res = await pay(p, q);
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    return view;
  }

  const holdOfPayment = (paymentId: string) =>
    prisma.walletHold.findUniqueOrThrow({ where: { paymentId } });
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });

  function listHolds(p: Person, query: string) {
    return request(app.getHttpServer())
      .get(`${BASE}/holds?${query}`)
      .set('Authorization', p.auth);
  }
  function getHold(p: Person, id: string) {
    return request(app.getHttpServer())
      .get(`${BASE}/holds/${id}`)
      .set('Authorization', p.auth);
  }

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
        wallets.arrived += 1;
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
              source_customer_accname: 'Hold Tester',
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
      FINTAVA_API_KEY: 'live_test_m18_hold_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_MONEY_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FINTAVA_CHECK_TIMEOUT_MS: String(MONEY_TIMEOUT_MS),
      FEE_QUOTE_KEY: 'm18-test-fee-quote-key-0123456789abcdef0123',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      FINTAVA_WEBHOOK_SECRET: 'whsec_local_m18_hold_Qv7Lp3Xc9Ty2Hb5Jn',
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
    statusChecks = moduleRef.get(LedgerStatusService);

    // WAWU's own money (its 15% shares and fees), so a move out of the
    // merchant wallet can pay Fintava's charge as well as the amount.
    wallets.kobo.set(MERCHANT_ACCOUNT, 5_000_000);

    const registry = moduleRef.get(PayableRegistry);
    for (const kind of ['paid_dm', 'event_ticket', 'bill'] as const) {
      registry.register({
        kind,
        resolve: async ({ targetId }) => {
          await Promise.resolve();
          const t = targets.get(targetId);
          if (!t) throw new MoneyError('target_not_found', 'That is gone.');
          return {
            title: `A ${kind} ${targetId.slice(-4)}`,
            priceKobo: t.priceKobo,
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
    wallets.arrived = 0;
  });

  // -------------------------------------------------------------------------
  // The task's two capability checks
  // -------------------------------------------------------------------------

  it('check 1: a held payment is not spendable by the payer and not yet paid to the payee', async () => {
    const creator = await person(0, false);
    const buyer = await person(250_000);
    const target = listing(creator);
    const q = await quoted(buyer, 'paid_dm', target);
    expect(q.willBeHeld).toBe(true);
    expect(q.totalKobo).toBe(102_325);

    const res = await pay(buyer, q);
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');

    // The price left the buyer's wallet (plus Fintava's charge, R-10) and
    // sits in WAWU's merchant wallet; the creator has been paid nothing.
    expect(balanceOf(buyer)).toBe(250_000 - 102_325);
    expect(balanceOf(creator)).toBe(0);
    const fromBuyer = () =>
      wallets.sends.filter((x) => x.from === buyer.accountNumber);
    expect(fromBuyer()).toHaveLength(1);
    expect(fromBuyer()[0]).toMatchObject({
      to: MERCHANT_ACCOUNT,
      amountKobo: 100_000,
    });

    // The hold: held, the price, what releases it, both people.
    expect(view.hold).toMatchObject({
      paymentId: view.id,
      kind: 'paid_dm',
      status: 'held',
      amountKobo: 100_000,
      releaseCondition: 'dm_answered',
      settledAt: null,
      refundedKobo: null,
    });
    expect(view.hold!.payer.wawuUserId).toBe(buyer.id);
    expect(view.hold!.payee!.wawuUserId).toBe(creator.id);
    // The feature that sold it is told which hold its payment sits in.
    const told = delivered.find((d) => d.paymentId === view.id)!;
    expect(told.holdId).toBe(view.hold!.id);

    // Not spendable by the buyer: the wallet is Fintava's, already short of
    // the price. A second purchase the rest cannot cover is refused with the
    // real shortfall.
    const second = listing(creator, 100_000);
    const q2 = await quoted(buyer, 'paid_dm', second);
    const again = await pay(buyer, q2);
    expect(again.status).toBe(201);
    const third = listing(creator, 100_000);
    const q3 = await quoted(buyer, 'paid_dm', third);
    const refused = await pay(buyer, q3);
    expect(refused.status).toBe(402);
    expect(body<unknown>(refused).reason?.code).toBe('insufficient_funds');
    expect(fromBuyer()).toHaveLength(2);

    // Not yet paid to the payee: no move toward the creator exists.
    expect(wallets.sends.filter((s) => s.to === creator.accountNumber)).toEqual(
      [],
    );
    const row = await holdOfPayment(view.id);
    expect(row.status).toBe('held');
    expect(row.action).toBeNull();
  });

  it('check 2: a refund returns the price (not the charge) to the payer once, even when asked twice', async () => {
    const creator = await person(0, false);
    const buyer = await person(200_000);
    const target = listing(creator);
    const payment = await paid(buyer, 'paid_dm', target);
    const merchantBefore = merchantBalance();
    expect(balanceOf(buyer)).toBe(97_675);

    const first = await holds.refund({ paymentId: payment.id }, 'no answer');
    const second = await holds.refund({ paymentId: payment.id }, 'no answer');
    expect(first).toMatchObject({ state: 'settled', status: 'refunded' });
    expect(second).toMatchObject({ state: 'settled', status: 'refunded' });

    // Exactly one move back, of the price: ₦1,000.00, not ₦1,023.25.
    const back = wallets.sends.filter((s) => s.to === buyer.accountNumber);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({
      from: MERCHANT_ACCOUNT,
      amountKobo: 100_000,
    });
    expect(balanceOf(buyer)).toBe(97_675 + 100_000);
    // Fintava's charge on the original payment is not returned (R-10), and
    // its charge on the refund move is WAWU's, taken from WAWU's account (R-31).
    expect(200_000 - balanceOf(buyer)).toBe(2_325);
    expect(merchantBefore - merchantBalance()).toBe(100_000 + 2_325);

    const row = await holdOfPayment(payment.id);
    expect(row).toMatchObject({
      status: 'refunded',
      action: 'refund',
      refundedKobo: 100_000n,
      providerFeeKobo: 2_325n,
    });
    expect(row.settledAt).not.toBeNull();
    expect(row.customerReference).toBe(`wawu-ref-${row.id}`);

    // Asked again, from anywhere, nothing more moves.
    await holds.refund({ holdId: row.id });
    await holds.sweep(later());
    expect(
      wallets.sends.filter((s) => s.to === buyer.accountNumber),
    ).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Release
  // -------------------------------------------------------------------------

  it('a release pays the payee 85% in full, WAWU keeps 15% and pays Fintava for the move', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const target = listing(creator, 100_000, 'ticket');
    const payment = await paid(buyer, 'event_ticket', target);
    const hold = await holdOfPayment(payment.id);
    expect(hold).toMatchObject({
      payeeShareKobo: 85_000n,
      wawuShareKobo: 15_000n,
      releaseCondition: 'event_took_place',
    });
    const merchantBefore = merchantBalance();

    const s = await holds.release({ paymentId: payment.id }, 'it took place');
    expect(s).toMatchObject({
      state: 'settled',
      status: 'released',
      action: 'release',
    });

    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([
      expect.objectContaining({
        from: MERCHANT_ACCOUNT,
        to: creator.accountNumber,
        amountKobo: 85_000,
      }),
    ]);
    // The creator gets the whole ₦850.00; WAWU's account pays the charge.
    expect(balanceOf(creator)).toBe(85_000);
    expect(merchantBefore - merchantBalance()).toBe(85_000 + 2_325);

    const row = await holdOfPayment(payment.id);
    expect(row).toMatchObject({
      status: 'released',
      action: 'release',
      refundedKobo: null,
      providerFeeKobo: 2_325n,
      destinationAccountNumber: creator.accountNumber,
    });
    // The payment's payee share is paid, so WALLET-16 never lands it again.
    const p = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: payment.id },
    });
    expect(p.payeeSettledAt).not.toBeNull();

    // Both sides in the ledger: WAWU's account out, the creator's wallet in.
    const rows = await ledgerRows(`wawu-rel-${hold.id}`);
    expect(
      rows.map((r) => ({
        wallet: r.walletKind,
        direction: r.direction,
        status: r.status,
        category: r.category,
        amount: String(r.amountKobo),
        fee: String(r.feeKobo),
        link: r.linkKind,
      })),
    ).toEqual([
      {
        wallet: 'user',
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amount: '85000',
        fee: '0',
        link: 'event_ticket',
      },
      {
        wallet: 'merchant',
        direction: 'out',
        status: 'completed',
        category: 'earning',
        amount: '85000',
        fee: '2325',
        link: 'event_ticket',
      },
    ]);
    const earning = rows.find((r) => r.direction === 'in')!;
    expect(earning.wawuUserId).toBe(creator.id);
    expect(earning.counterpartyWawuUserId).toBe(buyer.id);
    expect(earning.counterpartyAccountNumber).toBeNull();
  });

  it('asked twice, or by eight callers that all reached the lease together, a release moves the money once', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);

    // Every caller is past its checks and at the lease at the same moment
    // (a condition, not a time), and Fintava holds the answer of the one
    // that sends, so a second send would show.
    const inner = holds as unknown as {
      destination: (h: unknown) => Promise<unknown>;
    };
    const real = inner.destination.bind(holds);
    const together = barrier(8);
    const spy = jest
      .spyOn(inner, 'destination')
      .mockImplementation(async (h: unknown) => {
        const found = await real(h);
        await together();
        return found;
      });
    wallets.arrived = 0;
    let open!: () => void;
    wallets.gate = new Promise<void>((r) => (open = r));
    let answers: Awaited<ReturnType<WalletHoldService['release']>>[] = [];
    try {
      const calls = Array.from({ length: 8 }, () =>
        holds.release({ paymentId: payment.id }),
      );
      await until(() => wallets.arrived >= 1);
      open();
      answers = await Promise.all(calls);
    } finally {
      spy.mockRestore();
    }
    expect(wallets.arrived).toBe(1);
    // One caller sent; the others were told it is with the provider or done.
    for (const a of answers) {
      expect(['settled', 'pending']).toContain(a.state);
    }
    await holds.sweep(later());
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect(balanceOf(creator)).toBe(85_000);
    expect((await holdOfPayment(payment.id)).status).toBe('released');

    // And once more after it is over.
    const again = await holds.release({ paymentId: payment.id });
    expect(again.state).toBe('settled');
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
  });

  it('a release and a refund asked at the same moment: one wins, the other is refused with a plain answer, one move', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    // Both have read the hold, with no action chosen, before either claims it.
    const inner = holds as unknown as {
      find: (ref: unknown) => Promise<unknown>;
    };
    const real = inner.find.bind(holds);
    const together = barrier(2);
    const spy = jest
      .spyOn(inner, 'find')
      .mockImplementation(async (ref: unknown) => {
        const found = await real(ref);
        await together();
        return found;
      });
    let results: PromiseSettledResult<unknown>[] = [];
    try {
      results = await Promise.allSettled([
        holds.release({ paymentId: payment.id }),
        holds.refund({ paymentId: payment.id }),
      ]);
    } finally {
      spy.mockRestore();
    }
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toMatchObject({ code: 'other_action_chosen' });
    const row = await holdOfPayment(payment.id);
    expect(row.status).not.toBe('held');
    const moves = wallets.sends.filter(
      (x) =>
        x.reference === `wawu-rel-${hold.id}` ||
        x.reference === `wawu-ref-${hold.id}`,
    );
    expect(moves).toHaveLength(1);
    // Never both: exactly the chosen action's reference moved money.
    expect(moves[0].reference).toBe(
      row.action === 'release' ? `wawu-rel-${hold.id}` : `wawu-ref-${hold.id}`,
    );
  });

  it('a hold is settled one way: the other request is refused, before and after', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const released = await paid(buyer, 'paid_dm', listing(creator));
    await holds.release({ paymentId: released.id });
    await expect(
      holds.refund({ paymentId: released.id }),
    ).rejects.toMatchObject({ code: 'other_action_chosen' });
    expect(wallets.sends.filter((s) => s.to === buyer.accountNumber)).toEqual(
      [],
    );

    const refunded = await paid(buyer, 'paid_dm', listing(creator));
    await holds.refund({ paymentId: refunded.id });
    await expect(
      holds.release({ paymentId: refunded.id }),
    ).rejects.toBeInstanceOf(HoldRequestError);
    expect(balanceOf(creator)).toBe(85_000);

    // A payment that has no hold (not held, or not found) is a plain refusal.
    await expect(
      holds.release({ paymentId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'no_such_hold' });
  });

  it('the database refuses what the code must never do: a settled hold changing, an action changing', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    await holds.release({ paymentId: payment.id });

    await expect(
      prisma.walletHold.update({
        where: { id: hold.id },
        data: {
          status: 'refunded',
          action: 'refund',
          refundedKobo: hold.amountKobo,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.walletHold.update({
        where: { id: hold.id },
        data: { status: 'held', settledAt: null },
      }),
    ).rejects.toThrow();
    const other = await paid(buyer, 'paid_dm', listing(creator));
    const open = await holdOfPayment(other.id);
    await holds.refund({ paymentId: other.id });
    await expect(
      prisma.walletHold.update({
        where: { id: open.id },
        data: { action: 'release' },
      }),
    ).rejects.toThrow();
    const row = await holdOfPayment(payment.id);
    expect(row.status).toBe('released');
  });

  it("a bill has no payee: releasing it moves nothing and the whole price is WAWU's", async () => {
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'bill', listing(null, 100_000, 'bill'));
    const hold = await holdOfPayment(payment.id);
    expect(hold).toMatchObject({
      payeeShareKobo: 0n,
      wawuShareKobo: 100_000n,
      releaseCondition: 'bill_delivered',
    });
    const sends = wallets.sends.length;
    const s = await holds.release({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'settled', status: 'released' });
    expect(wallets.sends).toHaveLength(sends);
    expect((await holdOfPayment(payment.id)).customerReference).toBeNull();
    // A refund of a bill (the biller failed) does move the price back.
    const failed = await paid(buyer, 'bill', listing(null, 100_000, 'bill'));
    await holds.refund({ paymentId: failed.id }, 'the biller failed');
    expect(
      wallets.sends.filter((s2) => s2.to === buyer.accountNumber),
    ).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Waiting is not failing
  // -------------------------------------------------------------------------

  it('a creator with no wallet keeps earning: the money waits and lands the minute a wallet opens, once (R-11)', async () => {
    const creator = noWallet();
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);

    const s = await holds.release({ paymentId: payment.id });
    expect(s).toMatchObject({
      state: 'waiting',
      waiting: 'payee_wallet',
      status: 'held',
    });
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);
    // Still held: the money is in WAWU's account, and it is counted as held.
    const totals = await holds.openTotals();
    expect(totals.count).toBeGreaterThanOrEqual(1);
    await holds.sweep(later());
    await holds.sweep(later());
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);

    // The creator opens a wallet; the next sweep lands the money.
    accountSeq += 1;
    const accountNumber = `19${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: creator.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber,
      },
    });
    wallets.kobo.set(accountNumber, 0);
    const swept = await holds.sweep(later());
    expect(swept.settled).toBeGreaterThanOrEqual(1);
    expect(wallets.kobo.get(accountNumber)).toBe(85_000);
    await holds.sweep(later());
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect((await holdOfPayment(payment.id)).status).toBe('released');
    await prisma.fintavaWallet.delete({ where: { wawuUserId: creator.id } });
  });

  it('a frozen wallet waits: paid on unfreeze, nothing refunded instead (G-10)', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    wallets.frozen.add(creator.accountNumber);

    const s = await holds.release({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'waiting', waiting: 'recipient_frozen' });
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);
    // Not due again before its rest; a sweep then does not hammer Fintava.
    const seen = asked(hold.id);
    expect(seen).toBe(1);
    await holds.sweep(new Date());
    expect(asked(hold.id)).toBe(seen);

    wallets.frozen.clear();
    await holds.sweep(later(3 * 60_000));
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect(balanceOf(creator)).toBe(85_000);
    expect((await holdOfPayment(payment.id)).status).toBe('released');
  });

  it("WAWU's own account short of money keeps the hold held, logs the error, and pays when it is topped up", async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    const keep = wallets.kobo.get(MERCHANT_ACCOUNT)!;
    wallets.kobo.set(MERCHANT_ACCOUNT, 50_000);
    logger.lines.length = 0;

    const s = await holds.release({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'waiting', waiting: 'funds' });
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);
    expect(
      logger.lines.some(
        (l) => l.includes(hold.id) && l.includes('cannot cover'),
      ),
    ).toBe(true);

    wallets.kobo.set(MERCHANT_ACCOUNT, keep);
    await holds.sweep(later(5 * 60_000));
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect((await holdOfPayment(payment.id)).status).toBe('released');
  });

  it('a refusal that moved nothing is tried again under the same reference and then goes through once', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    wallets.mode = 'refuse';
    const s = await holds.release({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'waiting', waiting: 'refused' });
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);

    wallets.mode = 'live';
    await holds.sweep(later(5 * 60_000));
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect((await holdOfPayment(payment.id)).attempt).toBe(1);
    expect((await holdOfPayment(payment.id)).status).toBe('released');
  });

  it('F3 a refused release goes on being tried under the same reference and, past the review bound, goes to a person; a frozen wallet waits on', async () => {
    const creator = await person(0, false);
    const frozenCreator = await person(0, false);
    const buyer = await person(600_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    wallets.mode = 'refuse';
    const first = await holds.release({ paymentId: payment.id });
    expect(first).toMatchObject({ state: 'waiting', waiting: 'refused' });

    // Inside the bound it keeps trying, on the one reference.
    await holds.sweep(later(2 * 60 * 60_000));
    await holds.sweep(later(28 * 60 * 60_000));
    const trying = await holdOfPayment(payment.id);
    expect(trying.waiting).toBe('refused');
    expect(trying.reviewSince).toBeNull();
    expect(asked(hold.id)).toBeGreaterThanOrEqual(3);
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);

    // At the bound (counted from when the release was asked for) a person looks.
    const bound = 72 * 3_600_000;
    const s = await holds.drive(
      hold.id,
      new Date(trying.actionAt!.getTime() + bound),
    );
    expect(s.state).toBe('review');
    const review = await holdOfPayment(payment.id);
    expect(review.reviewSince).not.toBeNull();
    expect(review.status).toBe('held');
    expect(review.sentAt).toBeNull();
    expect(review.discrepancy).toContain('refused for 72 hours');
    expect(balanceOf(creator)).toBe(0);

    // Out of the sweep from here, even when the provider would now take it.
    wallets.mode = 'live';
    const seen = asked(hold.id);
    await holds.sweep(later(2 * 60 * 60_000));
    await holds.release({ paymentId: payment.id });
    expect(asked(hold.id)).toBe(seen);
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);
    expect(balanceOf(creator)).toBe(0);

    // The bound is for a refusal only: a frozen wallet waits past it (G-10).
    const second = await paid(buyer, 'paid_dm', listing(frozenCreator));
    wallets.frozen.add(frozenCreator.accountNumber);
    expect(await holds.release({ paymentId: second.id })).toMatchObject({
      state: 'waiting',
      waiting: 'recipient_frozen',
    });
    const frozenHold = await holdOfPayment(second.id);
    const late = await holds.drive(
      frozenHold.id,
      new Date(frozenHold.actionAt!.getTime() + bound + 24 * 3_600_000),
    );
    expect(late).toMatchObject({
      state: 'waiting',
      waiting: 'recipient_frozen',
    });
    expect((await holdOfPayment(second.id)).reviewSince).toBeNull();
    // And it is paid the moment the wallet is unfrozen, however late.
    wallets.frozen.clear();
    await holds.sweep(
      new Date(frozenHold.actionAt!.getTime() + bound + 48 * 3_600_000),
    );
    expect((await holdOfPayment(second.id)).status).toBe('released');
    expect(balanceOf(frozenCreator)).toBe(85_000);
  });

  // -------------------------------------------------------------------------
  // The provider's record is the truth
  // -------------------------------------------------------------------------

  it('a lost answer after the money moved is pending, found by our reference, never sent again', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    wallets.mode = 'timeout';

    const s = await holds.refund({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'pending', status: 'held' });
    wallets.mode = 'live';
    expect(sendsOf(`wawu-ref-${hold.id}`)).toHaveLength(1);
    const row = await holdOfPayment(payment.id);
    expect(row.sentAt).not.toBeNull();

    // Asked again at once: not due, so Fintava is not even asked.
    const seen = asked(hold.id);
    const repeat = await holds.refund({ paymentId: payment.id });
    expect(repeat.state).toBe('pending');
    expect(asked(hold.id)).toBe(seen);

    // The sweep asks Fintava for our reference, finds it, settles it.
    const swept = await holds.sweep(later());
    expect(swept.settled).toBe(1);
    expect(sendsOf(`wawu-ref-${hold.id}`)).toHaveLength(1);
    const done = await holdOfPayment(payment.id);
    expect(done).toMatchObject({ status: 'refunded', refundedKobo: 100_000n });
    expect(balanceOf(buyer)).toBe(300_000 - 2_325);
    // A lookup carries no charge: the ledger row stands at the schedule's.
    const out = (await ledgerRows(`wawu-ref-${hold.id}`)).find(
      (r) => r.direction === 'out',
    )!;
    expect(out.status).toBe('completed');
    expect(String(out.feeKobo)).toBe('2325');
  });

  it("a 5xx is an unknown outcome too: pending until Fintava's record says, one send", async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    wallets.mode = 'error500';
    wallets.arrived = 0;
    const s = await holds.release({ paymentId: payment.id });
    expect(s.state).toBe('pending');
    wallets.mode = 'live';
    // Fintava never took it: no record. It is asked again, never re-sent
    // while "no record yet" is all it says.
    await holds.sweep(later());
    await holds.sweep(later(10 * 60_000));
    expect(wallets.arrived).toBe(1);
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);
    expect((await holdOfPayment(payment.id)).status).toBe('held');
  });

  it('no record at the provider past the review bound goes to a person, with the money where it is', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    wallets.mode = 'timeout';
    await holds.release({ paymentId: payment.id });
    wallets.mode = 'live';
    wallets.hidden.add(`wawu-rel-${hold.id}`);

    const later73h = new Date(Date.now() + 73 * 3_600_000);
    const s = await holds.drive(hold.id, later73h);
    expect(s.state).toBe('review');
    const row = await holdOfPayment(payment.id);
    expect(row.reviewSince).not.toBeNull();
    expect(row.status).toBe('held');
    expect(row.discrepancy).toContain('may have moved');
    // Out of the sweep.
    const seen = asked(hold.id);
    await holds.sweep(new Date(later73h.getTime() + 3_600_000));
    expect(asked(hold.id)).toBe(seen);
    // And a request again still sends nothing.
    await holds.release({ paymentId: payment.id });
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
  });

  it("Fintava's own record that the move failed starts a new try under a new reference, once", async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    wallets.mode = 'timeout';
    await holds.release({ paymentId: payment.id });
    wallets.mode = 'live';
    // Fintava reports the first try FAILURE (and the double already moved
    // the money for it; the test undoes that as Fintava's failure would).
    const first = `wawu-rel-${hold.id}`;
    wallets.failures.add(first);
    const undo = wallets.sends.find((x) => x.reference === first)!;
    wallets.kobo.set(
      undo.to,
      (wallets.kobo.get(undo.to) ?? 0) - undo.amountKobo,
    );
    wallets.kobo.set(
      undo.from,
      (wallets.kobo.get(undo.from) ?? 0) + undo.amountKobo + undo.feeKobo,
    );

    await holds.sweep(later());
    const retried = await holdOfPayment(payment.id);
    expect(retried.attempt).toBe(2);
    expect(retried.customerReference).toBe(`wawu-rel-${hold.id}-2`);
    expect(retried.sentAt).toBeNull();

    await holds.sweep(later(10 * 60_000));
    const done = await holdOfPayment(payment.id);
    expect(done.status).toBe('released');
    expect(sendsOf(`wawu-rel-${hold.id}-2`)).toHaveLength(1);
    expect(balanceOf(creator)).toBe(85_000);
  });

  it('another amount than asked is a stop: reviewed, the hold stays held', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    wallets.mode = 'wrongamount';
    const s = await holds.release({ paymentId: payment.id });
    expect(s.state).toBe('review');
    const row = await holdOfPayment(payment.id);
    expect(row.status).toBe('held');
    expect(row.discrepancy).toContain('85100');
  });

  it("another provider's hold is never moved by this one", async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    await prisma.walletHold.update({
      where: { paymentId: payment.id },
      data: { provider: 'nuvion' },
    });
    const s = await holds.release({ paymentId: payment.id });
    expect(s).toMatchObject({ state: 'waiting', waiting: 'provider' });
    await holds.sweep(later(2 * 3_600_000));
    expect(wallets.sends.filter((x) => x.to === creator.accountNumber)).toEqual(
      [],
    );
    await prisma.walletHold.update({
      where: { paymentId: payment.id },
      data: { provider: 'fintava' },
    });
  });

  // -------------------------------------------------------------------------
  // The routes
  // -------------------------------------------------------------------------

  it('lists the holds a person paid and the holds they are owed, newest first, in pages; strangers see nothing', async () => {
    const creator = await person(0, false);
    const other = await person(0, false);
    const buyer = await person(2_000_000);
    const made: PaymentView[] = [];
    for (let i = 0; i < 5; i += 1) {
      made.push(await paid(buyer, 'paid_dm', listing(creator)));
    }
    const mine = body<HoldPage>(await listHolds(buyer, 'role=payer&limit=2'));
    expect(mine.data!.items).toHaveLength(2);
    expect(mine.data!.nextCursor).not.toBeNull();
    // Newest first.
    expect(mine.data!.items.map((h) => h.paymentId)).toEqual([
      made[4].id,
      made[3].id,
    ]);
    const seen = [...mine.data!.items];
    let cursor = mine.data!.nextCursor;
    while (cursor) {
      const page = body<HoldPage>(
        await listHolds(
          buyer,
          `role=payer&limit=2&cursor=${encodeURIComponent(cursor)}`,
        ),
      );
      seen.push(...page.data!.items);
      cursor = page.data!.nextCursor;
    }
    expect(seen.map((h) => h.paymentId)).toEqual(
      made.map((m) => m.id).reverse(),
    );
    expect(new Set(seen.map((h) => h.id)).size).toBe(5);

    // The creator is owed them; the buyer has paid, owes, and is owed none.
    const owed = body<HoldPage>(
      await listHolds(creator, 'role=payee&limit=100'),
    );
    expect(owed.data!.items.map((h) => h.paymentId).sort()).toEqual(
      made.map((m) => m.id).sort(),
    );
    const none = body<HoldPage>(await listHolds(buyer, 'role=payee'));
    expect(none.data!.items).toEqual([]);
    expect(none.data!.nextCursor).toBeNull();
    const nothing = body<HoldPage>(await listHolds(other, 'role=payer'));
    expect(nothing.data!.items).toEqual([]);

    // One hold: its payer and payee read it; a stranger gets a plain not_found.
    const id = made[0].hold!.id;
    const asPayer = await getHold(buyer, id);
    const asPayee = await getHold(creator, id);
    expect(asPayer.status).toBe(200);
    expect(asPayee.status).toBe(200);
    expect(body<HoldView>(asPayer).data).toEqual(body<HoldView>(asPayee).data);
    const stranger = await getHold(other, id);
    expect(stranger.status).toBe(404);
    expect(body<unknown>(stranger).reason?.code).toBe('not_found');
    expect((await getHold(buyer, randomUUID())).status).toBe(404);
    expect((await getHold(buyer, 'not-a-uuid')).status).toBe(400);
    expect(asPayer.headers['cache-control']).toBe('no-store');

    // A settled hold says so: released, with the time it settled.
    await holds.release({ paymentId: made[0].id });
    const settled = body<HoldView>(await getHold(buyer, id)).data!;
    expect(settled.status).toBe('released');
    expect(settled.settledAt).not.toBeNull();
    expect(settled.refundedKobo).toBeNull();
    await holds.refund({ paymentId: made[1].id });
    const refunded = body<HoldView>(
      await getHold(buyer, made[1].hold!.id),
    ).data!;
    expect(refunded).toMatchObject({
      status: 'refunded',
      refundedKobo: 100_000,
    });
  });

  it('the routes ask for a wallet and a good query, as the contract says', async () => {
    const buyer = await person(0);
    const none = noWallet();
    const res = await listHolds(none, 'role=payer');
    expect(res.status).toBe(409);
    expect(body<unknown>(res).reason?.code).toBe('wallet_not_open');
    expect((await getHold(none, randomUUID())).status).toBe(409);
    expect((await listHolds(buyer, '')).status).toBe(400);
    expect((await listHolds(buyer, 'role=banker')).status).toBe(400);
    expect((await listHolds(buyer, 'role=payer&limit=0')).status).toBe(400);
    expect((await listHolds(buyer, 'role=payer&limit=101')).status).toBe(400);
    const bad = await listHolds(buyer, 'role=payer&cursor=nonsense');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain(
      'cursor is not one this list gave',
    );
    // Unauthenticated: no.
    const anon = await request(app.getHttpServer()).get(
      `${BASE}/holds?role=payer`,
    );
    expect(anon.status).toBe(401);
  });

  it("a held kind's quote says it will be held, and a kind that is not held says it will not", async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const q = await quoted(buyer, 'bill', listing(null, 100_000, 'bill'));
    expect(q.willBeHeld).toBe(true);
    const q2 = await quoted(
      buyer,
      'event_ticket',
      listing(creator, 100_000, 'ticket'),
    );
    expect(q2.willBeHeld).toBe(true);
  });

  // -------------------------------------------------------------------------
  // How the hold comes to be
  // -------------------------------------------------------------------------

  it('a held payment settled by the sweep (the answer was lost) makes its hold once, and the feature is told its id', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const target = listing(creator);
    const q = await quoted(buyer, 'paid_dm', target);
    wallets.mode = 'timeout';
    const res = await pay(buyer, q);
    wallets.mode = 'live';
    const pending = body<PaymentView>(res).data!;
    expect(pending.status).toBe('pending');
    expect(pending.hold).toBeNull();
    expect(
      await prisma.walletHold.count({ where: { paymentId: pending.id } }),
    ).toBe(0);

    await payments.sweep(later());
    await until(
      async () =>
        (
          await prisma.walletPayment.findUniqueOrThrow({
            where: { id: pending.id },
          })
        ).fulfilledAt !== null,
    );
    await payments.sweep(later());
    expect(
      await prisma.walletHold.count({ where: { paymentId: pending.id } }),
    ).toBe(1);
    const hold = await holdOfPayment(pending.id);
    expect(hold.status).toBe('held');
    expect(
      delivered.filter((d) => d.paymentId === pending.id).map((d) => d.holdId),
    ).toEqual([hold.id]);
    // The same payment, read again, now carries its hold.
    const view = await payments.holdOf(
      await prisma.walletPayment.findUniqueOrThrow({
        where: { id: pending.id },
      }),
    );
    expect(view).toMatchObject({ id: hold.id, status: 'held' });
    await statusChecks.sweep(later());
    expect(
      await prisma.walletHold.count({ where: { paymentId: pending.id } }),
    ).toBe(1);
  });

  it('open holds are counted for the nightly check, held money only', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const before = await holds.openTotals();
    const a = await paid(buyer, 'paid_dm', listing(creator));
    const b = await paid(buyer, 'paid_dm', listing(creator));
    const mid = await holds.openTotals();
    expect(mid.count - before.count).toBe(2);
    expect(mid.amountKobo - before.amountKobo).toBe(200_000n);
    await holds.release({ paymentId: a.id });
    await holds.refund({ paymentId: b.id });
    const after = await holds.openTotals();
    expect(after.count).toBe(before.count);
    expect(after.amountKobo).toBe(before.amountKobo);
  });
  // -------------------------------------------------------------------------
  // MONEY-18 round 2
  // -------------------------------------------------------------------------

  it("F2 a refund is recorded as a refund: both ledger rows, linked to the item, WAWU as the other side of the payer's, and the payer's history says Refund", async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const target = listing(creator, 100_000, 'refund-ledger');
    const payment = await paid(buyer, 'paid_dm', target);
    const hold = await holdOfPayment(payment.id);
    await holds.refund({ paymentId: payment.id }, 'no answer');

    const rows = await ledgerRows(`wawu-ref-${hold.id}`);
    expect(rows).toHaveLength(2);
    const back = rows.find((r) => r.direction === 'in')!;
    const out = rows.find((r) => r.direction === 'out')!;
    for (const r of rows) {
      expect(r.category).toBe('refund');
      expect(r.status).toBe('completed');
      expect(r.amountKobo).toBe(100_000n);
      expect(r.linkKind).toBe('paid_dm');
      expect(r.linkTargetId).toBe(target);
      expect(r.customerReference).toBe(`wawu-ref-${hold.id}`);
    }
    // The payer's wallet gets the whole price, no fee on it.
    expect(back).toMatchObject({
      walletKind: 'user',
      wawuUserId: buyer.id,
      accountNumber: buyer.accountNumber,
      feeKobo: 0n,
      totalKobo: 100_000n,
      counterpartyKind: 'wawu',
      counterpartyWawuUserId: null,
      counterpartyAccountNumber: null,
    });
    // WAWU's account pays the price and the provider's charge (R-31).
    expect(out).toMatchObject({
      walletKind: 'merchant',
      feeKobo: 2_325n,
      totalKobo: 102_325n,
    });
    // It is not an earning for anyone: the creator has no ledger row at all.
    expect(
      await prisma.fintavaLedgerEntry.count({
        where: { wawuUserId: creator.id, category: 'earning' },
      }),
    ).toBe(0);

    const res = await request(app.getHttpServer())
      .get(`${BASE}/transactions?limit=50`)
      .set('Authorization', buyer.auth);
    expect(res.status).toBe(200);
    const items = body<{
      items: Array<{
        category: string;
        description: string;
        reference: string;
        direction: string;
      }>;
    }>(res).data!.items;
    const refund = items.find((i) => i.reference === `wawu-ref-${hold.id}`)!;
    expect(refund).toMatchObject({ category: 'refund', direction: 'in' });
    expect(refund.description).toMatch(/^Refund/);
  });

  it('F3 the database refuses a settled hold that names no action, and a refund that names no amount', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const open = await holdOfPayment(
      (await paid(buyer, 'paid_dm', listing(creator))).id,
    );
    // No action chosen yet: the old CHECK passed these on NULL.
    expect(open.action).toBeNull();
    await expect(
      prisma.$executeRaw`UPDATE "WalletHold" SET "status" = 'released', "settledAt" = now() WHERE "id" = ${open.id}`,
    ).rejects.toThrow(/WalletHold_outcome_check/);
    await expect(
      prisma.$executeRaw`UPDATE "WalletHold" SET "status" = 'refunded', "settledAt" = now(), "refundedKobo" = "amountKobo" WHERE "id" = ${open.id}`,
    ).rejects.toThrow(/WalletHold_outcome_check/);
    // A refund that names its action and no amount passed on NULL too.
    await expect(
      prisma.$executeRaw`UPDATE "WalletHold" SET "action" = 'refund', "status" = 'refunded', "settledAt" = now(), "refundedKobo" = NULL WHERE "id" = ${open.id}`,
    ).rejects.toThrow(/WalletHold_outcome_check/);
    // A release carrying a refund amount, and a refund of another amount.
    await expect(
      prisma.$executeRaw`UPDATE "WalletHold" SET "action" = 'release', "status" = 'released', "settledAt" = now(), "refundedKobo" = "amountKobo" WHERE "id" = ${open.id}`,
    ).rejects.toThrow(/WalletHold_outcome_check/);
    await expect(
      prisma.$executeRaw`UPDATE "WalletHold" SET "action" = 'refund', "status" = 'refunded', "settledAt" = now(), "refundedKobo" = "amountKobo" - 1 WHERE "id" = ${open.id}`,
    ).rejects.toThrow(/WalletHold_outcome_check/);
    // Nothing changed, and the legitimate ways to settle it still work.
    expect(await holdOfPayment(open.paymentId)).toMatchObject({
      status: 'held',
      action: null,
      settledAt: null,
    });
    await holds.refund({ holdId: open.id });
    expect(await holdOfPayment(open.paymentId)).toMatchObject({
      status: 'refunded',
      action: 'refund',
      refundedKobo: open.amountKobo,
    });
    // A hold with nothing to move (a bill) settles with its action in one update.
    const bill = await holdOfPayment(
      (await paid(buyer, 'bill', listing(null))).id,
    );
    const s = await holds.release({ holdId: bill.id });
    expect(s).toMatchObject({ state: 'settled', status: 'released' });
    expect(await holdOfPayment(bill.paymentId)).toMatchObject({
      action: 'release',
      status: 'released',
    });
  });

  /**
   * `count` holds that wait for a payee's wallet, cloned from a real one with
   * action times before `before`: as the first round's code left them (no
   * rest, due on every pass) when `legacy`, else as it leaves them now.
   */
  async function cloneWaiters(
    template: string,
    count: number,
    before: Date,
    legacy: boolean,
  ): Promise<void> {
    await prisma.$executeRawUnsafe(`
      DO $$
      DECLARE i int; pid text; hid text;
      BEGIN
        CREATE TEMP TABLE tp AS SELECT * FROM "WalletPayment" WHERE id = '${template}';
        CREATE TEMP TABLE th AS SELECT * FROM "WalletHold" WHERE "paymentId" = '${template}';
        FOR i IN 1..${count} LOOP
          pid := gen_random_uuid()::text; hid := gen_random_uuid()::text;
          UPDATE tp SET id = pid, "customerReference" = 'wawu-pay-' || pid, "openKey" = NULL;
          UPDATE th SET id = hid, "paymentId" = pid, "customerReference" = NULL,
                 "actionAt" = '${before.toISOString()}'::timestamp - (${count} - i || ' seconds')::interval
                 ${legacy ? `, "nextAttemptAt" = NULL` : ''};
          INSERT INTO "WalletPayment" SELECT * FROM tp;
          INSERT INTO "WalletHold" SELECT * FROM th;
        END LOOP;
        DROP TABLE tp; DROP TABLE th;
      END $$;
    `);
  }

  /** The cloned waiters are removed so they never sit in front of another test's holds. */
  const clonedFor: string[] = [];
  const dropWaiters = (payer: string) =>
    prisma.walletHold.deleteMany({
      where: { payerWawuUserId: payer, waiting: 'payee_wallet' },
    });
  afterEach(async () => {
    const payers = clonedFor.splice(0);
    for (const payer of payers) await dropWaiters(payer);
    // A pass that ran out of time left its place in the service; one that
    // reads to the end gives it up, so the next test starts from the front.
    if (payers.length > 0) await holds.sweep(later());
  });

  it('F4 a hold behind more than a thousand that wait for a wallet is reached by the first pass, and the waiters rest instead of being due on every pass', async () => {
    const buyer = await person(10_000_000);
    clonedFor.push(buyer.id);
    const creator = await person(0, false);
    // The hold that needs the sweep: WAWU's own account was short when the
    // release was asked, and has been topped up since.
    const ready = await paid(buyer, 'paid_dm', listing(creator, 200_000));
    const readyHold = await holdOfPayment(ready.id);
    const kept = merchantBalance();
    wallets.kobo.set(MERCHANT_ACCOUNT, 100);
    expect((await holds.release({ paymentId: ready.id })).waiting).toBe(
      'funds',
    );
    wallets.kobo.set(MERCHANT_ACCOUNT, kept);
    // 1,002 holds waiting for the wallet of someone who never opens one, all
    // asked before the ready one and due on every pass (no rest written).
    const lonely = noWallet();
    const t = await paid(buyer, 'paid_dm', listing(lonely, 111_111));
    expect(await holds.release({ paymentId: t.id })).toMatchObject({
      state: 'waiting',
      waiting: 'payee_wallet',
    });
    const template = await holdOfPayment(t.id);
    // A wait now has a rest (F4): the first look comes a minute after.
    expect(template.nextAttemptAt).not.toBeNull();
    const rest = template.nextAttemptAt!.getTime() - Date.now();
    expect(rest).toBeGreaterThan(50_000);
    expect(rest).toBeLessThanOrEqual(61_000);
    await cloneWaiters(
      t.id,
      1_002,
      new Date((readyHold.actionAt ?? new Date()).getTime() - 60_000),
      true,
    );
    const waiting = await prisma.walletHold.count({
      where: { waiting: 'payee_wallet', nextAttemptAt: null },
    });
    expect(waiting).toBeGreaterThanOrEqual(1_002);

    // Within two passes (the first reads every due hold unless the machine
    // is so slow that its time runs out, and then the second starts where it
    // stopped).
    const passes: number[] = [];
    let row = readyHold;
    for (let pass = 0; pass < 2 && row.status === 'held'; pass += 1) {
      passes.push((await holds.sweep(later(10 * 60_000))).checked);
      row = await holdOfPayment(ready.id);
    }
    expect(row.status).toBe('released');
    expect(sendsOf(`wawu-rel-${readyHold.id}`)).toHaveLength(1);
    // Not stopped at a thousand: every due hold was looked at.
    expect(passes.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(1_004);

    // The waiters now rest: none is due on every pass, and a pass at once
    // finds nothing of theirs to look at.
    expect(
      await prisma.walletHold.count({
        where: { waiting: 'payee_wallet', nextAttemptAt: null },
      }),
    ).toBe(0);
    const again = await holds.sweep(later(1_000));
    expect(again.checked).toBeLessThan(10);
    // Nothing was sent for any of them.
    expect(wallets.sends.filter((x) => x.amountKobo === 94_444).length).toBe(0);
  });

  it('F4 a pass that runs out of time hands its place to the next, which reaches the holds behind even when the ones in front stay due; the pass after a full read starts from the front again', async () => {
    const buyer = await person(10_000_000);
    clonedFor.push(buyer.id);
    const creator = await person(0, false);
    const ready = await paid(buyer, 'paid_dm', listing(creator, 200_000));
    const readyHold = await holdOfPayment(ready.id);
    const kept = merchantBalance();
    wallets.kobo.set(MERCHANT_ACCOUNT, 100);
    await holds.release({ paymentId: ready.id });
    wallets.kobo.set(MERCHANT_ACCOUNT, kept);
    const lonely = noWallet();
    const t = await paid(buyer, 'paid_dm', listing(lonely, 111_111));
    await holds.release({ paymentId: t.id });
    await cloneWaiters(
      t.id,
      120,
      new Date((readyHold.actionAt ?? new Date()).getTime() - 60_000),
      true,
    );
    // Holds in front that cannot be driven (their row keeps failing) stay due
    // on every pass: only the cursor carries a pass past them.
    const troubled = new Set(
      (
        await prisma.walletHold.findMany({
          where: { payerWawuUserId: buyer.id, waiting: 'payee_wallet' },
          select: { id: true },
        })
      ).map((h) => h.id),
    );
    troubled.delete((await holdOfPayment(t.id)).id);
    const real = holds.drive.bind(holds);
    const drive = jest
      .spyOn(holds, 'drive')
      .mockImplementation((id: string, now?: Date) => {
        if (troubled.has(id)) return Promise.reject(new Error('trouble'));
        return real(id, now);
      });
    const calls = () => drive.mock.calls.map((c) => c[0]);
    try {
      // A budget of nothing: each pass drives one hold and stops, and the
      // next pass starts after it.
      for (let pass = 1; pass <= 3; pass += 1) {
        expect(
          (await holds.sweep(later(10 * 60_000), { budgetMs: 0 })).checked,
        ).toBe(1);
      }
      expect(new Set(calls()).size).toBe(3);
      // Pass after pass it walks on to the hold behind all of them: there
      // are 120 in front, so it is the 121st.
      let passes = 3;
      while (
        (await holdOfPayment(ready.id)).status === 'held' &&
        passes < 200
      ) {
        await holds.sweep(later(10 * 60_000), { budgetMs: 0 });
        passes += 1;
      }
      expect((await holdOfPayment(ready.id)).status).toBe('released');
      expect(passes).toBeGreaterThanOrEqual(121);
      expect(passes).toBeLessThanOrEqual(130);
      // Read to the end (nothing left behind it): the pass after starts from
      // the front again.
      let empty = false;
      for (let i = 0; i < 10 && !empty; i += 1) {
        empty =
          (await holds.sweep(later(10 * 60_000), { budgetMs: 0 })).checked ===
          0;
      }
      expect(empty).toBe(true);
      const mark = calls().length;
      await holds.sweep(later(10 * 60_000), { budgetMs: 0 });
      expect(calls()[mark]).toBe(calls()[0]);
    } finally {
      drive.mockRestore();
    }
  });

  it('F4 more than a thousand holds in front that stay due (their rows keep failing) do not keep one pass from the hold behind them', async () => {
    const buyer = await person(10_000_000);
    clonedFor.push(buyer.id);
    const creator = await person(0, false);
    const ready = await paid(buyer, 'paid_dm', listing(creator, 200_000));
    const readyHold = await holdOfPayment(ready.id);
    const kept = merchantBalance();
    wallets.kobo.set(MERCHANT_ACCOUNT, 100);
    await holds.release({ paymentId: ready.id });
    wallets.kobo.set(MERCHANT_ACCOUNT, kept);
    const lonely = noWallet();
    const t = await paid(buyer, 'paid_dm', listing(lonely, 111_111));
    await holds.release({ paymentId: t.id });
    await cloneWaiters(
      t.id,
      1_002,
      new Date((readyHold.actionAt ?? new Date()).getTime() - 60_000),
      true,
    );
    const templateId = (await holdOfPayment(t.id)).id;
    const troubled = new Set(
      (
        await prisma.walletHold.findMany({
          where: { payerWawuUserId: buyer.id, waiting: 'payee_wallet' },
          select: { id: true },
        })
      ).map((h) => h.id),
    );
    troubled.delete(templateId);
    expect(troubled.size).toBe(1_002);
    const real = holds.drive.bind(holds);
    const drive = jest
      .spyOn(holds, 'drive')
      .mockImplementation((id: string, now?: Date) =>
        troubled.has(id) ? Promise.reject(new Error('trouble')) : real(id, now),
      );
    try {
      // One pass, at the default budget: it reads past a thousand of them.
      const pass = await holds.sweep(later(10 * 60_000));
      expect(pass.checked).toBeGreaterThanOrEqual(1_004);
    } finally {
      drive.mockRestore();
    }
    expect((await holdOfPayment(ready.id)).status).toBe('released');
    expect(sendsOf(`wawu-rel-${readyHold.id}`)).toHaveLength(1);
  });

  it('F4 a hold waiting for a wallet is woken by the first sweep after the wallet exists, however long it had rested', async () => {
    const creator = noWallet();
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    await holds.release({ paymentId: payment.id });
    // Looked at every few hours for days: the rest is an hour by then.
    const days = new Date(Date.now() + 3 * 24 * 3_600_000);
    await holds.sweep(days);
    const rested = await holdOfPayment(payment.id);
    expect(rested.waiting).toBe('payee_wallet');
    expect(rested.nextAttemptAt!.getTime() - days.getTime()).toBe(3_600_000);
    // Not looked at again before its rest ends.
    const before = asked(hold.id);
    await holds.sweep(new Date(days.getTime() + 60_000));
    expect(asked(hold.id)).toBe(before);

    // The wallet opens. The next sweep, a minute later, lands the money.
    accountSeq += 1;
    const accountNumber = `17${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: creator.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber,
      },
    });
    wallets.kobo.set(accountNumber, 0);
    const swept = await holds.sweep(new Date(days.getTime() + 120_000));
    expect(swept.settled).toBeGreaterThanOrEqual(1);
    expect(wallets.kobo.get(accountNumber)).toBe(85_000);
    expect((await holdOfPayment(payment.id)).status).toBe('released');
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    await prisma.fintavaWallet.delete({ where: { wawuUserId: creator.id } });
  });

  it('O1 a release whose request never reached Fintava (the connection is refused) is tried again by the sweep under the same reference, and moves once', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    await double.pause();
    const s = await holds
      .release({ paymentId: payment.id })
      .finally(() => double.resume());
    // Not "pending": Fintava was never asked to move anything, and the hold
    // says so (it waits for the provider and is not under a question).
    expect(s).toMatchObject({
      state: 'waiting',
      waiting: 'provider',
      status: 'held',
    });
    const waiting = await holdOfPayment(payment.id);
    expect(waiting.sentAt).toBeNull();
    expect(waiting.reviewSince).toBeNull();
    expect(sendsOf(`wawu-rel-${hold.id}`)).toEqual([]);
    const requests = double.seen.filter((r) => r.path.includes(hold.id));
    expect(requests).toEqual([]);

    // Fintava is back: the minute sweep sends it, under the same reference.
    await holds.sweep(later(5 * 60_000));
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect((await holdOfPayment(payment.id)).customerReference).toBe(
      `wawu-rel-${hold.id}`,
    );
    expect((await holdOfPayment(payment.id)).attempt).toBe(1);
    expect(balanceOf(creator)).toBe(85_000);
    expect((await holdOfPayment(payment.id)).status).toBe('released');
    // And once: nothing more moves.
    await holds.sweep(later(5 * 60_000));
    await holds.release({ paymentId: payment.id });
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
  });

  it('O1 a refund whose request never reached Fintava is tried again the same way', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    await double.pause();
    const s = await holds
      .refund({ paymentId: payment.id })
      .finally(() => double.resume());
    expect(s).toMatchObject({ state: 'waiting', waiting: 'provider' });
    await holds.sweep(later(5 * 60_000));
    expect(sendsOf(`wawu-ref-${hold.id}`)).toHaveLength(1);
    expect((await holdOfPayment(payment.id)).status).toBe('refunded');
  });

  it('O1 a request that MAY have reached Fintava is still asked about and never sent again: an answer lost after the send, and a reset after it was read', async () => {
    const creator = await person(0, false);
    const buyer = await person(300_000);
    const payment = await paid(buyer, 'paid_dm', listing(creator));
    const hold = await holdOfPayment(payment.id);
    // The send reaches Fintava, which moves the money and drops the line.
    wallets.mode = 'timeout';
    const s = await holds.release({ paymentId: payment.id });
    wallets.mode = 'live';
    expect(s).toMatchObject({ state: 'pending', status: 'held' });
    expect((await holdOfPayment(payment.id)).sentAt).not.toBeNull();
    await holds.sweep(later(5 * 60_000));
    expect(sendsOf(`wawu-rel-${hold.id}`)).toHaveLength(1);
    expect((await holdOfPayment(payment.id)).status).toBe('released');
  });
});
