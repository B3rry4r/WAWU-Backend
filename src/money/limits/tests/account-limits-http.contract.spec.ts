import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
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
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type {
  PaymentQuoteView,
  PaymentView,
  WalletView,
} from '../../money-view.type';
import { PayableRegistry } from '../../payments/payable-registry';
import { lagosNextDayStart } from '../lagos-window';

/**
 * The wallet provider's limit on the account, over HTTP (task WALLET-23): the
 * real app module, a real database, real RS256 tokens, and the real Fintava
 * client talking over a socket to the local double that answers with the
 * bodies the sandbox sent. Fintava reports each wallet's tier on the balance
 * read (`data.tier`); the daily limit that goes with the tier is the setting's
 * (Tier 2, N500,000, unless a test says otherwise).
 *
 * The task's capability check: a debit over the account's limit is refused
 * with the limit shown, and nothing is sent to Fintava. And W35's limits row:
 * `GET /money/wallet` shows the limit once a balance read has kept it, names
 * no tier, and hides the row when Fintava names none.
 */

const PAYMENTS = '/api/hub/money/payments';
const WALLET = '/api/hub/money/wallet';
const PIN = '4826';
const KEY = 'live_test_wallet23_0123456789FAKEKEY';
/** Tier 2 in the policy table: N500,000 a day. */
const TIER_2_DAILY = 50_000_000;

jest.setTimeout(120_000);

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `acct-limit-${sub}@test.wawu.dev`,
      phone: '+2348000009923',
      firstName: 'Limit',
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

/** The dashboard's balance-transfer charge (fees.md), in kobo. */
const liveFee = (amountKobo: number) => (amountKobo < 500_000 ? 2325 : 1575);

describe('WALLET-23: the account limit over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let cheapPinHash: string;
  const double = new FintavaDouble();
  const logger = new QuietLogger();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  let accountSeq = 0;

  /** accountNumber to kobo, walletId to accountNumber and to the tier Fintava reports. */
  const kobo = new Map<string, number>();
  const byId = new Map<string, string>();
  const tierOf = new Map<string, string | null>();
  const sends: Array<{ from: string; amountKobo: number }> = [];

  const creator = {
    wawuUserId: randomUUID(),
    displayName: 'Ada Lovelace',
    handle: 'ada',
    avatarUrl: null,
    tick: 'creator' as const,
  };

  type Person = { id: string; auth: string; walletId: string; account: string };

  async function person(
    balanceKobo: number,
    tier: string | null = 'TIER_2',
  ): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const account = `23${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    const walletId = randomUUID();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: randomUUID(),
        walletId,
        accountNumber: account,
      },
    });
    kobo.set(account, balanceKobo);
    byId.set(walletId, account);
    tierOf.set(walletId, tier);
    await prisma.transactionPin.create({
      data: { wawuUserId: id, pinHash: cheapPinHash },
    });
    return { id, auth: `Bearer ${mintToken(id)}`, walletId, account };
  }

  const get = (p: Person, path: string) =>
    request(app.getHttpServer()).get(path).set('Authorization', p.auth);

  const wallet = async (p: Person) =>
    body<WalletView>(await get(p, WALLET)).data!;

  async function quoted(
    p: Person,
    targetId: string,
  ): Promise<PaymentQuoteView> {
    const res = await get(
      p,
      `${PAYMENTS}/quote?kind=content_unlock&targetId=${targetId}`,
    );
    expect(res.status).toBe(200);
    return body<PaymentQuoteView>(res).data!;
  }

  function pay(p: Person, q: PaymentQuoteView) {
    return request(app.getHttpServer())
      .post(PAYMENTS)
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

  const sentBy = (p: Person) => sends.filter((s) => s.from === p.account);

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
      FINTAVA_API_KEY: KEY,
      FINTAVA_TIMEOUT_MS: '60000',
      FINTAVA_MONEY_TIMEOUT_MS: '60000',
      FINTAVA_CHECK_TIMEOUT_MS: '60000',
      FEE_QUOTE_KEY: 'w23-test-fee-quote-key-0123456789abcdef0123',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      FINTAVA_TIER_DAILY_LIMITS_KOBO: '',
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    double.reset();
    double.on('GET', '/merchant/balance', {
      status: 200,
      body: MERCHANT_BALANCE,
    });
    double.on('GET', /^\/customer\/wallet\/balance\//, (req: SeenRequest) => {
      const id = req.path.split('/').pop()!;
      const account = byId.get(id);
      if (!account) {
        return { status: 400, body: fintavaError(400, 'Wallet not found') };
      }
      const naira = (kobo.get(account) ?? 0) / 100;
      return {
        status: 200,
        body: {
          data: {
            balance: { bookedBalance: naira, availableBalance: naira },
            ...(tierOf.get(id) === null ? {} : { tier: tierOf.get(id) }),
          },
          status: 200,
          message: 'Wallet details fetched',
        },
      };
    });
    double.on('POST', '/transaction/wallet-to-wallet', (req: SeenRequest) => {
      const b = req.body as {
        senderAccount: string;
        receiverAccount: string;
        amount: number;
        CustomerReference: string;
      };
      const amountKobo = Math.round(b.amount * 100);
      const fee = liveFee(amountKobo);
      const have = kobo.get(b.senderAccount) ?? 0;
      if (have < amountKobo + fee) {
        return {
          status: 400,
          body: fintavaError(400, 'Insufficient balance on source wallet.'),
        };
      }
      kobo.set(b.senderAccount, have - amountKobo - fee);
      sends.push({ from: b.senderAccount, amountKobo });
      return {
        status: 200,
        body: {
          data: {
            amount: amountKobo / 100,
            reference: `tagapay${randomUUID().replace(/-/g, '')}`,
            customerReference: randomUUID(),
            total: (amountKobo + fee) / 100,
            transaction_fee: fee / 100,
            source_customer_id: randomUUID(),
            source_customer_accname: 'Limit Tester',
            source_customer_accno: b.senderAccount,
            source_customer_wallet: b.senderAccount,
            source_availableBalance: (have - amountKobo - fee) / 100,
            source_bookedBalance: (have - amountKobo - fee) / 100,
            description: 'Fund transfer between customers',
          },
          status: 200,
          message: 'successful',
        },
      };
    });
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
    moduleRef.get(PayableRegistry).register({
      kind: 'content_unlock',
      resolve: async ({ targetId }) => {
        await Promise.resolve();
        // The item's price in kobo is in its id: `piece-<kobo>`.
        const m = /^piece-(\d+)$/.exec(targetId);
        if (!m) throw new MoneyError('target_not_found', 'That piece is gone.');
        return {
          title: `Piece ${targetId}`,
          priceKobo: Number(m[1]),
          payee: creator,
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
          OR: [
            {
              customerReference: {
                in: payments.map((p) => p.customerReference),
              },
            },
            { wawuUserId: { in: users } },
          ],
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

  it('W35: the limits row is hidden until a balance read has kept the limit, then shows it with no tier', async () => {
    const p = await person(900_000_000);
    expect((await wallet(p)).limits).toBeNull();

    const bal = await get(p, `${WALLET}/balance`);
    expect(bal.status).toBe(200);

    const kept = await wallet(p);
    expect(kept.limits).toEqual({
      tier: null,
      dailyLimitKobo: TIER_2_DAILY,
      usedTodayKobo: 0,
      remainingTodayKobo: TIER_2_DAILY,
      resetsAt: lagosNextDayStart(new Date()).toISOString(),
    });
    // Fintava's tier name is kept for ops and never sent to the app.
    const row = await prisma.fintavaWallet.findUnique({
      where: { wawuUserId: p.id },
    });
    expect(row).toMatchObject({
      accountTier: 'TIER_2',
      dailyLimitKobo: BigInt(TIER_2_DAILY),
    });
    expect(JSON.stringify(kept)).not.toContain('TIER_2');
  });

  it('W35: a tier Fintava reports that the table does not know, or none at all, leaves the row hidden', async () => {
    const unknown = await person(900_000_000, 'TIER_9');
    await get(unknown, `${WALLET}/balance`);
    expect((await wallet(unknown)).limits).toBeNull();
    const none = await person(900_000_000, null);
    await get(none, `${WALLET}/balance`);
    expect((await wallet(none)).limits).toBeNull();
  });

  it('check: a debit over the account limit is refused with the limit shown, and nothing is sent to Fintava', async () => {
    const p = await person(900_000_000);
    // N499,000 of N500,000 today.
    const big = await quoted(p, 'piece-49900000');
    expect(big).toMatchObject({
      withinDailyLimit: true,
      remainingTodayKobo: TIER_2_DAILY,
    });
    const paid = await pay(p, big);
    expect(paid.status).toBe(201);
    expect(body<PaymentView>(paid).data).toMatchObject({
      status: 'completed',
      priceKobo: 49_900_000,
    });
    expect(sentBy(p)).toHaveLength(1);
    const balanceBefore = kobo.get(p.account);

    // The next quote says where the day stands before the PIN.
    const over = await quoted(p, 'piece-200000');
    expect(over).toMatchObject({
      withinDailyLimit: false,
      remainingTodayKobo: 100_000,
    });

    // N2,000 is over the N1,000 that is left: refused, limit shown.
    const refused = await pay(p, over);
    expect(refused.status).toBe(403);
    const env = body<null>(refused);
    expect(env.reason).toMatchObject({
      code: 'limit_reached',
      limit: 'daily',
      limitKobo: TIER_2_DAILY,
      remainingTodayKobo: 100_000,
    });
    expect(env.reason?.message).toBe(
      'This would pass your daily limit of ₦500,000.00. You can still move ₦1,000.00 today.',
    );
    expect(env.message).toBe(env.reason?.message);
    // Nothing moved: no send, the same balance, no payment row for it.
    expect(sentBy(p)).toHaveLength(1);
    expect(kobo.get(p.account)).toBe(balanceBefore);
    expect(
      await prisma.walletPayment.count({
        where: { payerWawuUserId: p.id, targetId: 'piece-200000' },
      }),
    ).toBe(0);

    // What is left is still spendable: exactly N1,000 goes through, and then
    // the day is spent.
    const exact = await quoted(p, 'piece-100000');
    expect(exact.withinDailyLimit).toBe(true);
    expect((await pay(p, exact)).status).toBe(201);
    const row = (await wallet(p)).limits;
    expect(row).toMatchObject({
      dailyLimitKobo: TIER_2_DAILY,
      usedTodayKobo: TIER_2_DAILY,
      remainingTodayKobo: 0,
    });
    const spent = await quoted(p, 'piece-100');
    expect(spent).toMatchObject({
      withinDailyLimit: false,
      remainingTodayKobo: 0,
    });
    const last = await pay(p, spent);
    expect(last.status).toBe(403);
    expect(body<null>(last).reason?.message).toBe(
      'This would pass your daily limit of ₦500,000.00. Try again tomorrow.',
    );
    expect(sentBy(p)).toHaveLength(2);
  });

  it('a wallet Fintava gives no known limit is held to nothing of ours', async () => {
    const p = await person(900_000_000, 'TIER_9');
    const q = await quoted(p, 'piece-49900000');
    expect(q).toMatchObject({
      withinDailyLimit: true,
      remainingTodayKobo: null,
    });
    expect((await pay(p, q)).status).toBe(201);
    const again = await quoted(p, 'piece-49900000');
    expect((await pay(p, again)).status).toBe(201);
  });
});
