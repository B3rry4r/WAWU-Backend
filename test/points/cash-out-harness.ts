import { createHash, randomUUID } from 'node:crypto';
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
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../src/common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../src/common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../src/common/interceptors/response.interceptor';
import { PrismaModule } from '../../src/common/prisma/prisma.module';
import { PrismaService } from '../../src/common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../src/hub-app-options';
import type { MoneyErrorReason } from '../../src/money/dto/money-error.dto';
import { MoneyModule } from '../../src/money/money.module';
import { PointsConvertModule } from '../../src/points/convert/points-convert.module';
import { PointsCashOutService } from '../../src/points/convert/points-cash-out.service';
import { PLANS_CONFIG, type PlansConfig } from '../../src/plans/plans-config';
import { PointsService } from '../../src/points/points.service';
import { purgePersonPoints } from '../../src/points/points-purge';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../src/wallet-provider/wallet-provider.interface';
import { NuvionSeamStandIn } from '../payments/nuvion-seam-standin';
import {
  FintavaDouble,
  fintavaError,
  MERCHANT_ACCOUNT,
  MERCHANT_BALANCE,
  customerHistory,
  recordByReference,
  type SeenRequest,
} from '../fintava/fintava-double';

/**
 * The points-to-cash specs' common ground (task POINTS-04): the real
 * MoneyModule and PointsConvertModule on a real database, real RS256 tokens
 * checked against the stand-in WAWU ID's JWKS, and a wallet provider behind
 * the seam, either the real Fintava client over a socket to FintavaDouble
 * (`Fintava...`) or Nuvion stood in at the seam (`NuvionSeamStandIn`).
 */

export const BASE = '/api/hub/points/convert';
export const PIN = '4826';

export function mintToken(
  sub: string,
  claims: { phone?: string; country?: string } = {},
): string {
  const privateKey = readFileSync(
    join(__dirname, '../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `p04-${sub}@test.wawu.dev`,
      phone: claims.phone ?? '+2348000009904',
      firstName: 'Points',
      lastName: 'Converter',
      country: claims.country ?? 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

export class QuietLogger implements LoggerService {
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

export type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: MoneyErrorReason & Record<string, unknown>;
};
export const body = <T>(res: Response) => res.body as Envelope<T>;

/** Polls until `ok`. The cap only ends a hang; it is not what the test waits for. */
export async function until(
  ok: () => Promise<boolean> | boolean,
): Promise<void> {
  for (let i = 0; i < 2_400; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('until: the condition never held');
}

/** Resolves once `n` callers have arrived, for all of them. */
export function barrier(n: number): () => Promise<void> {
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((r) => (open = r));
  return () => {
    arrived += 1;
    if (arrived >= n) open();
    return all;
  };
}

export type Person = {
  id: string;
  auth: string;
  accountNumber: string;
  walletId: string;
};

/** The dashboard's balance-transfer charge (`fees.md`), in kobo. */
export const liveFee = (amountKobo: number) =>
  amountKobo < 500_000 ? 2325 : 1575;

export const DAY = 86_400_000;

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
export class Wallets {
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
  /** Every wallet-to-wallet request that arrived, moved or not. */
  arrived = 0;
}

/** What both providers' harnesses share: the app, the people, the points, the requests. */
export abstract class CashOutBase {
  app!: INestApplication<App>;
  moduleRef!: TestingModule;
  prisma!: PrismaService;
  points!: PointsService;
  cashOut!: PointsCashOutService;
  provider!: WalletProvider;
  readonly logger = new QuietLogger();
  readonly users: string[] = [];
  protected readonly previous: Record<string, string | undefined> = {};
  protected cheapPinHash = '';
  protected accountSeq = 0;
  /** The sweep's clock: always ahead of the last one, so each is due. */
  private clock = Date.now();
  later = (ms = 2 * 60_000) => {
    this.clock = Math.max(this.clock, Date.now()) + ms;
    return new Date(this.clock);
  };

  /** The settings this provider's harness needs, set before the app is built. */
  protected abstract settings(): Record<string, string>;
  /** Starts what the provider needs (a socket stand-in). */
  protected abstract startProvider(): Promise<void>;
  /** The provider to put behind the seam instead of the real adapter, or null. */
  protected abstract providerOverride(): WalletProvider | null;
  /** Called once the app is up. */
  protected abstract afterBoot(): void;
  protected abstract stopProvider(): Promise<void>;
  /** Opens the person's account at the provider holding `kobo`; returns what the wallet row needs. */
  protected abstract openAccount(kobo: number): {
    accountNumber: string;
    walletId: string;
    customerId: string;
    provider: string;
  };

  async boot(
    env: Record<string, string> = {},
    plans?: PlansConfig,
  ): Promise<void> {
    this.cheapPinHash = await argon2.hash(PIN, {
      type: argon2.argon2id,
      timeCost: 1,
      memoryCost: 1024,
      parallelism: 1,
    });
    await this.startProvider();
    const settings: Record<string, string> = { ...this.settings(), ...env };
    for (const [k, v] of Object.entries(settings)) {
      this.previous[k] = process.env[k];
      process.env[k] = v;
    }
    let builder = Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        PointsConvertModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    });
    // Another plan (its cash-out rate and minimum): the answers follow the
    // config and nothing else.
    if (plans) builder = builder.overrideProvider(PLANS_CONFIG).useValue(plans);
    const over = this.providerOverride();
    if (over)
      builder = builder.overrideProvider(WALLET_PROVIDER).useValue(over);
    this.moduleRef = await builder.setLogger(this.logger).compile();
    this.app = this.moduleRef.createNestApplication({
      ...HUB_APP_OPTIONS,
      logger: this.logger,
    });
    this.app.useLogger(this.logger);
    this.app.setGlobalPrefix('api/hub');
    this.app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    this.app.useGlobalFilters(new AllExceptionsFilter());
    this.app.useGlobalInterceptors(new ResponseInterceptor());
    await this.app.init();
    await this.app.listen(0, '127.0.0.1');
    this.prisma = this.moduleRef.get(PrismaService);
    this.points = this.moduleRef.get(PointsService);
    this.cashOut = this.moduleRef.get(PointsCashOutService);
    this.provider = this.moduleRef.get<WalletProvider>(WALLET_PROVIDER);
    this.afterBoot();
  }

  async close(): Promise<void> {
    if (this.prisma) await this.clean();
    if (this.app) await this.app.close();
    await this.stopProvider();
    for (const [k, v] of Object.entries(this.previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  /** Removes what the spec made. The points ledger is append-only: the purge's own step removes it. */
  private async clean(): Promise<void> {
    const rows = await this.prisma.pointConversion.findMany({
      where: { wawuUserId: { in: this.users } },
      select: { customerReference: true },
    });
    await this.prisma.fintavaLedgerEntry.deleteMany({
      where: {
        customerReference: { in: rows.map((r) => r.customerReference) },
      },
    });
    await this.prisma.pointConversion.deleteMany({
      where: { wawuUserId: { in: this.users } },
    });
    await this.prisma.moneyIdempotencyKey.deleteMany({
      where: { wawuUserId: { in: this.users } },
    });
    await this.prisma.transactionPin.deleteMany({
      where: { wawuUserId: { in: this.users } },
    });
    await this.prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: this.users } },
    });
    await this.prisma.personBilling.deleteMany({
      where: { wawuUserId: { in: this.users } },
    });
    for (const id of this.users) await purgePersonPoints(this.prisma, id);
  }

  /** A person with an open wallet holding `kobo`, the PIN set. */
  async person(
    kobo = 0,
    opts: { pin?: boolean; claims?: { phone?: string; country?: string } } = {},
  ): Promise<Person> {
    const id = randomUUID();
    this.users.push(id);
    const acct = this.openAccount(kobo);
    await this.prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: acct.customerId,
        walletId: acct.walletId,
        accountNumber: acct.accountNumber,
        provider: acct.provider,
      },
    });
    if (opts.pin !== false) {
      await this.prisma.transactionPin.create({
        data: { wawuUserId: id, pinHash: this.cheapPinHash },
      });
    }
    return {
      id,
      auth: `Bearer ${mintToken(id, opts.claims)}`,
      accountNumber: acct.accountNumber,
      walletId: acct.walletId,
    };
  }

  /** A person with no wallet at all. */
  noWallet(): Person {
    const id = randomUUID();
    this.users.push(id);
    return {
      id,
      auth: `Bearer ${mintToken(id)}`,
      accountNumber: '',
      walletId: '',
    };
  }

  /** Lots for a person: `points` ending `days` from now, each granted once. */
  async lots(
    p: Pick<Person, 'id'>,
    list: Array<{ points: number; days: number }>,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const l of list) {
      const out = await this.points.grant({
        wawuUserId: p.id,
        source: 'pack',
        sourceRef: `p04-${randomUUID()}`,
        points: l.points,
        expiresAt: new Date(Date.now() + l.days * DAY),
      });
      ids.push(out.lotId);
    }
    return ids;
  }

  convert(
    p: Pick<Person, 'auth'>,
    points: unknown,
    opts: { key?: string; pin?: string | null } = {},
  ) {
    let req = request(this.app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.pin !== null) req = req.set('X-Transaction-Pin', opts.pin ?? PIN);
    return req.send({ points });
  }

  quote(p: Pick<Person, 'auth'>, query = '') {
    return request(this.app.getHttpServer())
      .get(`${BASE}/quote${query}`)
      .set('Authorization', p.auth);
  }

  read(p: Pick<Person, 'auth'>, id: string) {
    return request(this.app.getHttpServer())
      .get(`${BASE}/${id}`)
      .set('Authorization', p.auth);
  }

  myPoints(p: Pick<Person, 'auth'>) {
    return request(this.app.getHttpServer())
      .get('/api/hub/me/points')
      .set('Authorization', p.auth);
  }

  /** The conversion row and its hold, as the database holds them. */
  async state(conversionId: string) {
    const conversion = await this.prisma.pointConversion.findUniqueOrThrow({
      where: { id: conversionId },
    });
    const hold = await this.prisma.pointHold.findUnique({
      where: {
        purpose_reference: { purpose: 'cash_out', reference: conversionId },
      },
    });
    return { conversion, hold };
  }

  ledgerRows = (reference: string) =>
    this.prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
}

/** Everything a Fintava-backed points-to-cash spec needs. */
export class FintavaCashOut extends CashOutBase {
  readonly double = new FintavaDouble();
  readonly wallets = new Wallets();

  protected settings(): Record<string, string> {
    return {
      FINTAVA_BASE_URL: this.double.baseUrl,
      FINTAVA_API_KEY: 'live_test_p04_cashout_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: '120000',
      FINTAVA_MONEY_TIMEOUT_MS: '120000',
      FINTAVA_CHECK_TIMEOUT_MS: '120000',
      FEE_QUOTE_KEY: 'p04-test-fee-quote-key-0123456789abcdef0123',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      FINTAVA_WEBHOOK_SECRET: 'whsec_local_p04_cashout_Qv7Lp3Xc9Ty2Hb5Jn',
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
  }

  protected async startProvider(): Promise<void> {
    await this.double.start();
    this.install();
  }

  protected providerOverride(): WalletProvider | null {
    return null;
  }

  protected afterBoot(): void {
    // WAWU's own money, so a move out of its account can pay the amount and
    // Fintava's charge on top.
    this.wallets.kobo.set(MERCHANT_ACCOUNT, 50_000_000);
  }

  protected async stopProvider(): Promise<void> {
    await this.double.stop();
  }

  protected openAccount(kobo: number) {
    this.accountSeq += 1;
    const accountNumber = `19${String(Date.now()).slice(-6)}${String(this.accountSeq).padStart(2, '0')}`;
    const walletId = randomUUID();
    this.wallets.kobo.set(accountNumber, kobo);
    this.wallets.byId.set(walletId, accountNumber);
    return {
      accountNumber,
      walletId,
      customerId: randomUUID(),
      provider: 'fintava',
    };
  }

  balanceOf = (p: Pick<Person, 'accountNumber'>) =>
    this.wallets.kobo.get(p.accountNumber) ?? 0;
  merchantBalance = () => this.wallets.kobo.get(MERCHANT_ACCOUNT) ?? 0;
  sendsOf = (reference: string) =>
    this.wallets.sends.filter((s) => s.reference === reference);

  private install(): void {
    const { double, wallets } = this;
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
        return { status: 200, body: recordFor(ref, 'FAILURE', '0.00') };
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
              source_customer_accname: 'Points Converter',
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
}

export { MERCHANT_ACCOUNT };

/**
 * Nuvion stood in at the wallet provider seam (`NuvionSeamStandIn`: Nuvion's
 * documented accounts, book transfers answered `pending` first, the fee on
 * top, statuses, no lookup by our reference). WAWU's own account is Nuvion's
 * operational account. A small server on the Fintava host counts any call to
 * it: none must come.
 */
export class NuvionCashOut extends CashOutBase {
  static readonly FEES = '0:1500,500000:2500';
  readonly nuvion = new NuvionSeamStandIn();
  readonly fintavaHits: string[] = [];
  private fintavaCounter!: Server;
  private fintavaUrl = '';

  protected settings(): Record<string, string> {
    return {
      FINTAVA_BASE_URL: this.fintavaUrl,
      FINTAVA_API_KEY: 'live_test_p04_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'p04-nuvion-fee-quote-key-0123456789abcdef01',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: NuvionCashOut.FEES,
      NUVION_FEE_BANK_PAYOUT: NuvionCashOut.FEES,
      NUVION_FEE_INFLOW: NuvionCashOut.FEES,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
  }

  protected async startProvider(): Promise<void> {
    this.fintavaCounter = createServer((req, res) => {
      this.fintavaHits.push(`${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('{}');
    });
    await new Promise<void>((r) =>
      this.fintavaCounter.listen(0, '127.0.0.1', () => r()),
    );
    this.fintavaUrl = `http://127.0.0.1:${(this.fintavaCounter.address() as AddressInfo).port}`;
  }

  protected providerOverride(): WalletProvider | null {
    return this.nuvion;
  }

  protected afterBoot(): void {
    // WAWU's own money beyond the cash it pays out.
    this.nuvion.operational.availableKobo = 50_000_000n;
    this.nuvion.feeKobo = () => 1500n;
    this.nuvion.mode = 'successful';
  }

  protected async stopProvider(): Promise<void> {
    await new Promise<void>((r) => this.fintavaCounter.close(() => r()));
  }

  protected openAccount(kobo: number) {
    this.accountSeq += 1;
    const accountNumber = `83${String(Date.now()).slice(-6)}${String(this.accountSeq).padStart(2, '0')}`;
    const account = this.nuvion.openAccount(BigInt(kobo), accountNumber);
    return {
      accountNumber,
      walletId: account.accountId,
      customerId: account.entityId,
      provider: 'nuvion',
    };
  }

  /** What the person can spend at Nuvion. */
  balanceOf = (p: Pick<Person, 'walletId'>) =>
    Number(this.nuvion.accounts.get(p.walletId)!.availableKobo);
  merchantBalance = () => Number(this.nuvion.operational.availableKobo);
  sendsOf = (reference: string) =>
    this.nuvion.transfers.filter(
      (t) => t.request.unique_reference === reference,
    );
}
