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
import { WalletProviderError } from '../../../wallet-provider/wallet-provider-error';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import { LIMIT_REACHED_MESSAGES } from '../../limits/limit-reached';
import type { LedgerMovementInput } from '../../ledger/ledger.interface';
import {
  LEDGER_ABSENT_FAILURE,
  LedgerService,
} from '../../ledger/ledger.service';
import { LedgerStatusService } from '../../ledger/ledger-status.service';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type { PaymentQuoteView, PaymentView } from '../../money-view.type';
import { IDEMPOTENT_REPLAYED_HEADER, IdempotencyService } from '../idempotency';
import {
  MerchantWallet,
  PAYMENTS_UNAVAILABLE_MESSAGE,
} from '../merchant-wallet';
import { type CompletedPayment, PayableRegistry } from '../payable-registry';
import { splitPrice } from '../payment-config';
import {
  BALANCE_CHANGED_MESSAGE,
  OTHER_CURRENCY_MESSAGE,
  PAYMENT_FAILED_REASON,
  PAYMENT_NARRATION,
  STILL_CONFIRMING_MESSAGE,
  WalletPaymentService,
} from '../wallet-payment.service';

/**
 * Pay from wallet (MONEY-17) on the wallet provider seam (MONEY-20) with
 * NUVION stood in (rounds 5 and 6, 8 Oct 2026).
 *
 * The real MoneyModule, a real database, real RS256 tokens checked against
 * the stand-in WAWU ID's JWKS, and `WALLET_PROVIDER` given the Nuvion
 * stand-in (`test/payments/nuvion-seam-standin.ts`: Nuvion's documented
 * accounts, book transfers answered `pending` first, fees on top, statuses,
 * error types and no lookup by our reference, mapped onto the seam). The
 * Fintava client is still built (WalletProviderModule mounts it for
 * Fintava's webhook receiver) and points at a local counter: a spec at the
 * end proves nothing reached it. No Nuvion, Fintava or wawuafrica.com host
 * is called.
 *
 * NUV-07: the three NUVION_FEE_* settings are filled with spec values (the
 * owner fills the real ones, NUV-10), and WAWU's daily purchase limit is
 * set so one spec can reach it. The stand-in's `applicable_fee` is set to
 * what the quote says unless a spec says otherwise; no figure is a fact.
 */

const BASE = '/api/hub/money/payments';
const PIN = '5937';
/** Spec values for Nuvion's fee settings: kobo, by band (nuvion-fee-config.ts). */
const NUVION_FEES = '0:1500,500000:2500';
/** WAWU's daily purchase limit in this spec: two ₦1,000 items, not three. */
const DAILY_PURCHASE_LIMIT_KOBO = 250_000;
const PRICE = 100_000;

jest.setTimeout(60_000);

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `nuv-${sub}@test.wawu.dev`,
      phone: '+2348000009917',
      firstName: 'Nuvion',
      lastName: 'Payer',
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

/** Waits on a condition, never on time: polls until it holds (the cap only ends a hang). */
async function until(
  ok: () => Promise<boolean> | boolean,
  what = 'the condition',
  capMs = 30_000,
): Promise<void> {
  const end = Date.now() + capMs;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`until: ${what} never held`);
}

describe('Pay from wallet (MONEY-17) on the provider seam, Nuvion stood in', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let merchant: MerchantWallet;
  let statusChecks: LedgerStatusService;
  let keys: IdempotencyService;
  const nuvion = new NuvionSeamStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const owned = new Set<string>();
  const previous: Record<string, string | undefined> = {};
  /** Every movement this task handed the ledger. */
  const movements: LedgerMovementInput[] = [];
  /**
   * Holds every payment's claim (its pending ledger rows are being written,
   * inside the claim's transaction) until the test lets it go: a way to put
   * two payments of one person in the claim together, on a condition and not
   * on time.
   */
  let claimHold: { reached: number; open: Promise<void> } | null = null;
  /** Reads of an item by (payer:target) and the price the feature answers from the third read on. */
  const priceShift = new Map<string, { reads: number; priceKobo: number }>();
  /** Every request that reached the Fintava client's base URL. */
  const fintavaHits: string[] = [];
  let fintavaCounter: Server;
  let accountSeq = 0;
  /** The sweep's clock: always ahead of the last sweep, so each one is due. */
  let clock = Date.now();
  const sweepLater = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return payments.sweep(new Date(clock));
  };

  const creator = {
    wawuUserId: randomUUID(),
    displayName: 'Chimamanda Adichie',
    handle: 'chimamanda',
    avatarUrl: null,
    tick: 'creator' as const,
  };

  type Person = { id: string; auth: string; account: NuvionAccount };

  /**
   * A person with an approved Nuvion entity and NGN account holding `kobo`,
   * PIN set. `held` is the wallet row's provider: `fintava` stands for a
   * wallet opened before a switch to Nuvion.
   */
  async function buyer(
    kobo: number,
    held: 'nuvion' | 'fintava' = 'nuvion',
  ): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `81${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    const account = nuvion.openAccount(BigInt(kobo), accountNumber);
    // The wallet table every provider writes: the gate reads the person's
    // ids from it, and its `provider` (NUV-01) says Nuvion holds this one,
    // so the balance read asks the running provider about it.
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: account.entityId,
        walletId: account.accountId,
        accountNumber,
        provider: held,
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
    const q = body<PaymentQuoteView>(res).data!;
    // Nuvion charges what its settings say, which is what the quote says.
    const fee = BigInt(q.fee.providerFeeKobo);
    nuvion.feeKobo = () => fee;
    return q;
  }

  function send(p: Person, payload: object, key: string = randomUUID()) {
    return request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send(payload);
  }

  function pay(
    p: Person,
    q: PaymentQuoteView,
    key: string = randomUUID(),
    extra: object = {},
  ) {
    return send(
      p,
      {
        kind: q.kind,
        targetId: q.targetId,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
        ...extra,
      },
      key,
    );
  }

  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account.accountId);
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
  const rowOf = (id: string) =>
    prisma.walletPayment.findUniqueOrThrow({ where: { id } });
  const deliveriesOf = (id: string) =>
    delivered.filter((d) => d.paymentId === id).length;
  const askedAbout = (reference: string) =>
    nuvion.calls.filter(
      (c) =>
        c.method === 'reconcileSend' &&
        (c.args as { reference: string }).reference === reference,
    ).length;
  const forgetPlatformAccount = () => {
    // MerchantWallet reads WAWU's account once per process; a test that
    // changes what the provider answers starts it again.
    (merchant as unknown as { accountNumber: string | null }).accountNumber =
      null;
  };

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
      FINTAVA_API_KEY: 'live_test_m17_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'm17-nuvion-fee-quote-key-0123456789abcdef01',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: NUVION_FEES,
      NUVION_FEE_BANK_PAYOUT: NUVION_FEES,
      NUVION_FEE_INFLOW: NUVION_FEES,
      WAWU_LIMIT_PURCHASE_DAILY_KOBO: String(DAILY_PURCHASE_LIMIT_KOBO),
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
    payments = moduleRef.get(WalletPaymentService);
    merchant = moduleRef.get(MerchantWallet);
    statusChecks = moduleRef.get(LedgerStatusService);
    keys = moduleRef.get(IdempotencyService);

    const ledger = moduleRef.get(LedgerService);
    const record = ledger.record.bind(ledger);
    jest
      .spyOn(ledger, 'record')
      .mockImplementation(async (input: LedgerMovementInput, ...rest) => {
        if (input.paymentId) movements.push(input);
        if (
          claimHold &&
          input.status === 'pending' &&
          input.direction === 'out' &&
          rest[0] !== undefined
        ) {
          // Inside the claim's transaction (the second argument is its client).
          claimHold.reached += 1;
          await claimHold.open;
        }
        return record(input, ...rest);
      });

    const registry = moduleRef.get(PayableRegistry);
    registry.register({
      kind: 'content_unlock',
      resolve: async ({ targetId, payerWawuUserId }) => {
        await Promise.resolve();
        if (owned.has(`${payerWawuUserId}:${targetId}`)) {
          throw new MoneyError('target_not_payable', 'You already own this.');
        }
        if (targetId === 'dollar-piece') {
          // A feature pricing an item in dollars (R-43): cents, not kobo.
          return {
            title: 'A piece priced in dollars',
            priceKobo: 300,
            payee: creator,
            currency: 'USD',
          };
        }
        if (!targetId.startsWith('n-')) {
          throw new MoneyError('target_not_found', 'That piece is gone.');
        }
        const shift = priceShift.get(`${payerWawuUserId}:${targetId}`);
        if (shift) {
          // Read 1 is the quote, 2 the payment's first read, 3 the read
          // inside the claim: the price changes between 2 and 3.
          shift.reads += 1;
          if (shift.reads >= 3) {
            return {
              title: `Piece ${targetId}`,
              priceKobo: shift.priceKobo,
              payee: creator,
            };
          }
        }
        return {
          title: `Piece ${targetId}`,
          priceKobo: PRICE,
          payee: creator,
        };
      },
      onCompleted: async (p) => {
        await Promise.resolve();
        owned.add(`${p.payerWawuUserId}:${p.targetId}`);
        delivered.push(p);
      },
    });
    registry.register({
      kind: 'tip',
      resolve: async ({ amountKobo }) => {
        await Promise.resolve();
        return {
          title: 'A tip',
          priceKobo: amountKobo!,
          payee: creator,
        };
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
    claimHold = null;
    nuvion.mode = 'pending';
    nuvion.extraKobo = 0n;
    nuvion.insufficientStatus = 422;
    nuvion.platformOverride = null;
  });

  // -------------------------------------------------------------------------
  // Before anything is cached: what the provider says about WAWU's account
  // -------------------------------------------------------------------------

  it('a Nuvion adapter without book transfers yet (not_supported): 503, nothing stored, nothing sent, the key free', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-unsupported');
    forgetPlatformAccount();
    nuvion.mode = 'not_supported';
    const key = randomUUID();
    const res = await pay(p, q, key);
    expect(res.status).toBe(503);
    expect(body(res).reason).toMatchObject({ code: 'provider_unreachable' });
    expect(body(res).message).toBe(PAYMENTS_UNAVAILABLE_MESSAGE);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);

    // The account is known, the book transfer still is not: the claim is
    // given back as failed, nothing moved, the key is free again.
    nuvion.mode = 'pending';
    await merchant.account();
    nuvion.mode = 'not_supported';
    const second = await pay(p, q, key);
    expect(second.status).toBe(503);
    expect(sendsFrom(p)).toHaveLength(0);
    const rows = await prisma.walletPayment.findMany({
      where: { payerWawuUserId: p.id },
    });
    expect(rows.map((r) => [r.status, r.openKey, r.failureReason])).toEqual([
      ['failed', null, PAYMENT_FAILED_REASON],
    ]);
    nuvion.mode = 'successful';
    const third = await pay(p, q, key);
    expect(third.status).toBe(201);
    expect(body<PaymentView>(third).data!.status).toBe('completed');
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it("R5-1: the payer's wallet is WAWU's own account, however Nuvion names it (its NGN account number, its nuvion_ban, its id): refused before anything is sent (503)", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-self');
    for (const named of [
      p.account.accountNumber!,
      p.account.nuvionBan,
      p.account.accountId,
    ]) {
      forgetPlatformAccount();
      nuvion.platformOverride = {
        accountNumber: named,
        accountName: 'WAWU Operational',
        availableKobo: 0n,
        bookedKobo: 0n,
      };
      const res = await pay(p, q);
      expect(res.status).toBe(503);
      expect(body(res).message).toBe(PAYMENTS_UNAVAILABLE_MESSAGE);
    }
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(p.account.availableKobo).toBe(500_000n);
    // WAWU's real operational account: the same buyer pays as usual.
    forgetPlatformAccount();
    nuvion.platformOverride = null;
    nuvion.mode = 'successful';
    expect(body<PaymentView>(await pay(p, q)).data!.status).toBe('completed');
  });

  it("a payer whose wallet another provider holds (Fintava's, on a server switched to Nuvion): 503 from NUV-01's balance read, Nuvion never asked about that wallet, nothing claimed, nothing sent", async () => {
    const p = await buyer(500_000, 'fintava');
    const q = await quoted(p, 'content_unlock', 'n-foreign-wallet');
    nuvion.mode = 'successful';
    const res = await pay(p, q);
    expect(res.status).toBe(503);
    expect(body(res).reason).toMatchObject({ code: 'provider_unreachable' });
    const askedOf = (method: string) =>
      nuvion.calls.filter(
        (c) =>
          c.method === method &&
          (c.args as { walletId?: string } | null)?.walletId ===
            p.account.accountId,
      ).length;
    expect(askedOf('getBalance')).toBe(0);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(p.account.availableKobo).toBe(500_000n);
  });

  // -------------------------------------------------------------------------
  // The task's capability checks, on Nuvion
  // -------------------------------------------------------------------------

  it("check 3 on Nuvion: Nuvion's documented first answer is pending; one book transfer of the price to WAWU's operational account; the sweep completes it once Nuvion does; 85/15 of the price", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-1000');
    expect(q).toMatchObject({
      priceKobo: PRICE,
      totalKobo: PRICE + q.fee.providerFeeKobo,
      balanceKobo: 500_000,
      shortfallKobo: 0,
      fee: { wawuFeeKobo: 0 },
      withinDailyLimit: true,
      remainingTodayKobo: DAILY_PURCHASE_LIMIT_KOBO,
    });
    expect(q.fee.providerFeeKobo).toBeGreaterThan(0);
    const operationalBefore = nuvion.operational.availableKobo;

    const res = await pay(p, q);
    expect(res.status).toBe(201);
    const paid = body<PaymentView>(res).data!;
    expect(paid).toMatchObject({
      status: 'pending',
      statusMessage: STILL_CONFIRMING_MESSAGE,
      priceKobo: PRICE,
      totalKobo: q.totalKobo,
      fee: q.fee,
      failureReason: null,
    });
    expect(deliveriesOf(paid.id)).toBe(0);

    // Nuvion received one book transfer, as its docs draw it.
    expect(sendsFrom(p).map((t) => t.request)).toEqual([
      {
        entity_id: p.account.entityId,
        account_id: p.account.accountId,
        amount: PRICE,
        currency: 'NGN',
        payment_type: 'book-transfer',
        nuvion_ban: nuvion.operational.nuvionBan,
        unique_reference: `wawu-pay-${paid.id}`,
        narration: PAYMENT_NARRATION,
      },
    ]);
    expect(paid.reference.length).toBeLessThanOrEqual(64);

    nuvion.settle(paid.reference, 'successful');
    await sweepLater();
    const row = await rowOf(paid.id);
    expect(row.status).toBe('completed');
    expect(p.account.availableKobo).toBe(BigInt(500_000 - q.totalKobo));
    expect(nuvion.operational.availableKobo - operationalBefore).toBe(
      BigInt(PRICE),
    );
    const split = splitPrice(PRICE, true);
    expect({
      provider: row.provider,
      merchant: row.merchantAccountNumber,
      payee: row.payeeWawuUserId,
      payeeShareKobo: row.payeeShareKobo,
      wawuShareKobo: row.wawuShareKobo,
      openKey: row.openKey,
      debitReviewSince: row.debitReviewSince,
    }).toEqual({
      provider: 'nuvion',
      merchant: nuvion.operational.nuvionBan,
      payee: creator.wawuUserId,
      payeeShareKobo: 85_000n,
      wawuShareKobo: 15_000n,
      openKey: null,
      debitReviewSince: null,
    });
    expect(split).toEqual({ payeeShareKobo: 85_000, wawuShareKobo: 15_000 });

    // The ledger: the buyer's debit with Nuvion's fee, WAWU's credit, both
    // completed, Nuvion's transfer id (the one the adapter kept) on both.
    const transferId = sendsFrom(p)[0].id;
    expect(nuvion.keptIds.get(paid.reference)).toBe(transferId);
    const rows = await ledgerRows(paid.reference);
    expect(
      rows.map((r) => ({
        wallet: r.walletKind,
        direction: r.direction,
        status: r.status,
        amount: r.amountKobo,
        fee: r.feeKobo,
        total: r.totalKobo,
        account: r.accountNumber,
        transactionId: r.fintavaTransactionId,
      })),
    ).toEqual([
      {
        wallet: 'merchant',
        direction: 'in',
        status: 'completed',
        amount: BigInt(PRICE),
        fee: 0n,
        total: BigInt(PRICE),
        account: nuvion.operational.nuvionBan,
        transactionId: transferId,
      },
      {
        wallet: 'user',
        direction: 'out',
        status: 'completed',
        amount: BigInt(PRICE),
        fee: BigInt(q.fee.providerFeeKobo),
        total: BigInt(q.totalKobo),
        account: p.account.accountNumber,
        transactionId: transferId,
      },
    ]);
    expect(deliveriesOf(paid.id)).toBe(1);
    // The sweep asked; it never sent again.
    expect(
      nuvion.calls.filter(
        (c) =>
          c.method === 'walletToWallet' &&
          (c.args as { reference: string }).reference === paid.reference,
      ),
    ).toHaveLength(1);
    expect(askedAbout(paid.reference)).toBeGreaterThan(0);
  });

  it('a book transfer Nuvion answers successful at once completes in the request and is delivered once', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-instant');
    nuvion.mode = 'successful';
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid).toMatchObject({
      status: 'completed',
      totalKobo: q.totalKobo,
      statusMessage: null,
    });
    expect(deliveriesOf(paid.id)).toBe(1);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it('check 2 on Nuvion: the same request twice, and eight at once under one key, send one book transfer', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'n-twice');
    const key = randomUUID();
    const first = await pay(p, q, key);
    expect(first.status).toBe(201);
    const again = await pay(p, q, key);
    expect(again.status).toBe(201);
    expect(again.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      'true',
    );
    expect(again.text).toBe(first.text);
    expect(sendsFrom(p)).toHaveLength(1);

    const q2 = await quoted(p, 'content_unlock', 'n-burst');
    const burstKey = randomUUID();
    const answers = await Promise.all(
      Array.from({ length: 8 }, () => pay(p, q2, burstKey)),
    );
    expect(answers.filter((a) => a.status === 201).length).toBeGreaterThan(0);
    for (const a of answers) {
      if (a.status !== 201) {
        expect(a.status).toBe(409);
        expect(body(a).reason).toMatchObject({
          code: 'idempotency_in_progress',
        });
      }
    }
    // One book transfer for each of the two payments, never more.
    expect(sendsFrom(p).map((t) => t.request.unique_reference)).toEqual([
      body<PaymentView>(first).data!.reference,
      expect.stringMatching(/^wawu-pay-/),
    ]);
  });

  it('taps with different keys at once for one item send one book transfer; the rest are payment_in_progress', async () => {
    const p = await buyer(2_000_000);
    const q = await quoted(p, 'content_unlock', 'n-taps');
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => pay(p, q)),
    );
    const created = answers.filter((a) => a.status === 201);
    expect(created).toHaveLength(1);
    const paid = body<PaymentView>(created[0]).data!;
    for (const a of answers.filter((x) => x.status !== 201)) {
      expect(a.status).toBe(409);
      expect(body(a).reason).toMatchObject({
        code: 'payment_in_progress',
        paymentId: paid.id,
      });
    }
    expect(sendsFrom(p)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Each of Nuvion's statuses, as the sweep reads them (lead ruling 4)
  // -------------------------------------------------------------------------

  it('processing, then successful: pending until Nuvion finishes, completed and delivered once, never sent again', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-processing');
    nuvion.mode = 'processing';
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('pending');
    await sweepLater();
    expect((await rowOf(paid.id)).status).toBe('pending');
    expect(askedAbout(paid.reference)).toBe(1);
    // Another tap while it is open: refused, nothing sent.
    const tap = await pay(p, q);
    expect(body(tap).reason).toMatchObject({
      code: 'payment_in_progress',
      paymentId: paid.id,
    });
    nuvion.settle(paid.reference, 'successful');
    await sweepLater(10 * 60_000);
    expect((await rowOf(paid.id)).status).toBe('completed');
    expect(deliveriesOf(paid.id)).toBe(1);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it.each(['failed', 'cancelled'])(
    'pending, then %s: failed with "no money left your wallet", the buyer whole, nothing delivered, the item payable again',
    async (status) => {
      const p = await buyer(500_000);
      const q = await quoted(p, 'content_unlock', `n-${status}`);
      const paid = body<PaymentView>(await pay(p, q)).data!;
      expect(paid.status).toBe('pending');
      nuvion.settle(paid.reference, status);
      await sweepLater();
      const row = await rowOf(paid.id);
      expect([row.status, row.failureReason, row.openKey]).toEqual([
        'failed',
        PAYMENT_FAILED_REASON,
        null,
      ]);
      expect(p.account.availableKobo).toBe(500_000n);
      expect(deliveriesOf(paid.id)).toBe(0);
      expect((await ledgerRows(paid.reference)).map((r) => r.status)).toEqual([
        'failed',
        'failed',
      ]);
      nuvion.mode = 'successful';
      expect(body<PaymentView>(await pay(p, q)).data!.status).toBe('completed');
    },
  );

  it('lead ruling 7: Nuvion moved it and then reversed it before the sweep looked: reversed, both ledger sides reversed, the buyer whole, nothing delivered, the item free', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-reversed');
    const paid = body<PaymentView>(await pay(p, q)).data!;
    nuvion.settle(paid.reference, 'successful');
    nuvion.settle(paid.reference, 'reversed');
    await sweepLater();
    const row = await rowOf(paid.id);
    expect([row.status, row.openKey]).toEqual(['reversed', null]);
    expect(p.account.availableKobo).toBe(500_000n);
    expect(deliveriesOf(paid.id)).toBe(0);
    expect((await ledgerRows(paid.reference)).map((r) => r.status)).toEqual([
      'reversed',
      'reversed',
    ]);
    expect(
      body<PaymentView>(await quote(p, 'content_unlock', 'n-reversed'))
        .statusCode,
    ).toBe(200);
  });

  it('a status word Nuvion has that we do not know is never read as failed: still pending, asked again later, the item claimed', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-unknownword');
    const paid = body<PaymentView>(await pay(p, q)).data!;
    nuvion.settle(paid.reference, 'on_hold');
    await sweepLater();
    const row = await rowOf(paid.id);
    expect([row.status, row.failureReason, row.checks]).toEqual([
      'pending',
      null,
      1,
    ]);
    expect(row.openKey).not.toBeNull();
    expect((await ledgerRows(paid.reference)).map((r) => r.status)).toEqual([
      'pending',
      'pending',
    ]);
    expect(deliveriesOf(paid.id)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Lost and unknown answers: pending until Nuvion says, never sent again
  // -------------------------------------------------------------------------

  it("a lost answer after Nuvion took the transfer: no id kept, so the sweep finds it in the payer's transfers by our reference; completed once Nuvion finishes it, one transfer", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-lost');
    nuvion.mode = 'timeout';
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('pending');
    expect(nuvion.keptIds.has(paid.reference)).toBe(false);
    nuvion.settle(paid.reference, 'successful');
    await sweepLater();
    expect((await rowOf(paid.id)).status).toBe('completed');
    expect(sendsFrom(p)).toHaveLength(1);
    expect(deliveriesOf(paid.id)).toBe(1);
  });

  it.each([
    ['error_system_internal_error', 500, true],
    ['error_system_service_unavailable', 503, false],
    ['error_system_dependency_unavailable', 503, true],
    ['error_system_timeout', 504, false],
    ['error_transfer_network_unavailable', 503, false],
  ] as const)(
    'a system error on the create (%s, %d; transfer made: %s) is pending, never failed or sent again',
    async (type, httpStatus, created) => {
      const p = await buyer(500_000);
      const q = await quoted(p, 'content_unlock', `n-${type}`);
      nuvion.mode = 'system_error';
      nuvion.systemError = { type, httpStatus, created };
      const res = await pay(p, q);
      expect(res.status).toBe(201);
      const paid = body<PaymentView>(res).data!;
      expect(paid.status).toBe('pending');
      if (created) nuvion.settle(paid.reference, 'successful');
      nuvion.mode = 'pending';
      await sweepLater();
      const row = await rowOf(paid.id);
      expect(row.status).toBe(created ? 'completed' : 'pending');
      expect(row.failureReason).toBeNull();
      expect(sendsFrom(p)).toHaveLength(created ? 1 : 0);
      expect(
        nuvion.calls.filter(
          (c) =>
            c.method === 'walletToWallet' &&
            (c.args as { reference: string }).reference === paid.reference,
        ),
      ).toHaveLength(1);
    },
  );

  it.each(['already_processing', 'request_processing'] as const)(
    'Nuvion saying the request is still being processed (%s) is pending, never failed',
    async (mode) => {
      const p = await buyer(500_000);
      const q = await quoted(p, 'content_unlock', `n-${mode}`);
      nuvion.mode = mode;
      const paid = body<PaymentView>(await pay(p, q)).data!;
      expect(paid.status).toBe('pending');
      expect((await rowOf(paid.id)).failureReason).toBeNull();
    },
  );

  it('a lost answer and no record at Nuvion: never failed and never sent again; past the review bound it waits for a person, the item still claimed', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-silent');
    nuvion.mode = 'timeout_nothing';
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('pending');
    await sweepLater();
    let row = await rowOf(paid.id);
    expect([row.status, row.reviewSince]).toEqual(['pending', null]);
    await payments.sweep(new Date(Date.now() + 73 * 3_600_000));
    row = await rowOf(paid.id);
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toContain('no answer from Nuvion');
    expect(row.openKey).not.toBeNull();
    expect(sendsFrom(p)).toHaveLength(0);
    expect(p.account.availableKobo).toBe(500_000n);
  });

  // -------------------------------------------------------------------------
  // Money figures, refusals, limits and the currency
  // -------------------------------------------------------------------------

  it('short of money by our read of Nuvion (more than the price, less than price plus fee): 402 with the exact shortfall, nothing sent, nothing stored', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-short');
    const balance = PRICE + Math.floor(q.fee.providerFeeKobo / 2);
    p.account.availableKobo = BigInt(balance);
    const res = await pay(p, q);
    expect(res.status).toBe(402);
    expect(body(res).reason).toMatchObject({
      code: 'insufficient_funds',
      balanceKobo: balance,
      totalKobo: q.totalKobo,
      shortfallKobo: q.totalKobo - balance,
    });
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
  });

  it.each([400, 422] as const)(
    "Nuvion's own insufficient funds (answered %d; read by its type): 402, the payment failed with both ledger sides, the key given back",
    async (httpStatus) => {
      const p = await buyer(500_000);
      const q = await quoted(
        p,
        'content_unlock',
        `n-insufficient-${httpStatus}`,
      );
      nuvion.mode = 'insufficient';
      nuvion.insufficientStatus = httpStatus;
      const res = await pay(p, q);
      expect(res.status).toBe(402);
      expect(body(res).message).toBe(BALANCE_CHANGED_MESSAGE);
      expect(body(res).reason).not.toHaveProperty('shortfallKobo');
      const rows = await prisma.walletPayment.findMany({
        where: { payerWawuUserId: p.id },
      });
      expect(rows.map((r) => r.status)).toEqual(['failed']);
      expect(
        (await ledgerRows(rows[0].customerReference)).map((r) => r.status),
      ).toEqual(['failed', 'failed']);
      expect(sendsFrom(p)).toHaveLength(0);
      expect(
        await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
      ).toBe(0);
    },
  );

  it("Nuvion's own limit (error_transfer_daily_limit_exceeded): 403 limit_reached naming the limit, nothing moved, the key given back", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-nuvionlimit');
    nuvion.mode = 'limit';
    nuvion.limitError = 'error_transfer_daily_limit_exceeded';
    const res = await pay(p, q);
    expect(res.status).toBe(403);
    expect(body(res).reason).toMatchObject({
      code: 'limit_reached',
      limit: 'daily',
    });
    expect(body(res).message).toBe(LIMIT_REACHED_MESSAGES.daily);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    const rows = await prisma.walletPayment.findMany({
      where: { payerWawuUserId: p.id },
    });
    expect(rows.map((r) => [r.status, r.openKey])).toEqual([['failed', null]]);
  });

  it("WAWU's own daily purchase limit: the quote says where it stands, and the payment that would pass it is 403 limit_reached inside its claim, nothing stored or sent", async () => {
    const p = await buyer(2_000_000);
    nuvion.mode = 'successful';
    for (const item of ['n-lim1', 'n-lim2']) {
      const q = await quoted(p, 'content_unlock', item);
      expect(body<PaymentView>(await pay(p, q)).data!.status).toBe('completed');
    }
    const q3 = await quoted(p, 'content_unlock', 'n-lim3');
    expect(q3).toMatchObject({
      withinDailyLimit: false,
      remainingTodayKobo: DAILY_PURCHASE_LIMIT_KOBO - 2 * PRICE,
    });
    const res = await pay(p, q3);
    expect(res.status).toBe(403);
    expect(body(res).reason).toMatchObject({
      code: 'limit_reached',
      limit: 'daily',
    });
    expect(sendsFrom(p)).toHaveLength(2);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(2);
    expect(
      await prisma.moneyIdempotencyKey.count({
        where: { wawuUserId: p.id, state: { not: 'done' } },
      }),
    ).toBe(0);
  });

  it('lead ruling 5: Nuvion debiting more than the quoted total: the real debit is recorded and answered, never the quoted one, and the payment is flagged for review with both figures; a lower fee is recorded and answered too, not flagged', async () => {
    const p = await buyer(1_000_000);
    nuvion.mode = 'successful';
    const q = await quoted(p, 'content_unlock', 'n-feehigh');
    const higher = BigInt(q.fee.providerFeeKobo + 250);
    nuvion.feeKobo = () => higher;
    const paid = body<PaymentView>(await pay(p, q)).data!;
    const realTotal = PRICE + Number(higher);
    expect(paid).toMatchObject({
      status: 'completed',
      totalKobo: realTotal,
      fee: { providerFeeKobo: Number(higher) },
    });
    let row = await rowOf(paid.id);
    expect(row.totalKobo).toBe(BigInt(realTotal));
    expect(row.debitReviewSince).not.toBeNull();
    expect(row.discrepancy).toContain(`took ${realTotal} kobo`);
    expect(row.discrepancy).toContain(`quoted ${q.totalKobo} kobo`);
    expect(deliveriesOf(paid.id)).toBe(1);
    expect(p.account.availableKobo).toBe(BigInt(1_000_000 - realTotal));

    const q2 = await quoted(p, 'content_unlock', 'n-feelow');
    nuvion.feeKobo = () => 0n;
    const low = body<PaymentView>(await pay(p, q2)).data!;
    expect(low).toMatchObject({ status: 'completed', totalKobo: PRICE });
    row = await rowOf(low.id);
    expect(row.debitReviewSince).toBeNull();
    expect(row.discrepancy).toContain('debit differs from the quote');
  });

  it('Nuvion moving another amount than the price: in the first answer, or found by the sweep after a lost answer, it goes to review, nothing delivered, the item claimed', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'n-wrong1');
    nuvion.mode = 'successful';
    nuvion.extraKobo = 100n;
    const first = body<PaymentView>(await pay(p, q)).data!;
    expect(first.status).toBe('pending');
    let row = await rowOf(first.id);
    expect(row.reviewSince).not.toBeNull();
    expect(row.openKey).not.toBeNull();

    const q2 = await quoted(p, 'content_unlock', 'n-wrong2');
    nuvion.mode = 'timeout';
    nuvion.extraKobo = 100n;
    const second = body<PaymentView>(await pay(p, q2)).data!;
    nuvion.settle(second.reference, 'successful');
    await sweepLater();
    row = await rowOf(second.id);
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toContain(`moved ${PRICE + 100} kobo`);
    expect(deliveriesOf(first.id) + deliveriesOf(second.id)).toBe(0);
  });

  it('an item priced in another currency is refused on the quote and the payment: no kobo taken for cents, nothing stored, nothing sent', async () => {
    const p = await buyer(500_000);
    const qr = await quote(p, 'content_unlock', 'dollar-piece');
    expect(qr.status).toBe(409);
    expect(body(qr).reason).toMatchObject({ code: 'target_not_payable' });
    expect(body(qr).message).toBe(OTHER_CURRENCY_MESSAGE);
    const naira = await quoted(p, 'content_unlock', 'n-for-dollar');
    const res = await send(p, {
      kind: 'content_unlock',
      targetId: 'dollar-piece',
      expectedTotalKobo: naira.totalKobo,
      quoteToken: naira.quoteToken,
    });
    expect(res.status).toBe(409);
    expect(body(res).message).toBe(OTHER_CURRENCY_MESSAGE);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
  });

  it('R5-2: a NUL or a broken character in a text field (a tip note, the quote token) is 400 naming the field, before anything is claimed; a blank note is still none', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'tip', 'creator-x', '&amountKobo=10000');
    const key = randomUUID();
    for (const [extra, field] of [
      [{ note: 'thanks\u0000' }, 'note'],
      [{ note: '\ud800 broken' }, 'note'],
      [
        { amountKobo: 10_000, quoteToken: `${q.quoteToken}\u0000` },
        'quoteToken',
      ],
    ] as const) {
      const res = await pay(p, q, key, { amountKobo: 10_000, ...extra });
      expect(res.status).toBe(400);
      expect(JSON.stringify(body(res).message)).toContain(field);
    }
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
    expect(sendsFrom(p)).toHaveLength(0);
    nuvion.mode = 'successful';
    const ok = await pay(p, q, key, { amountKobo: 10_000, note: '   ' });
    expect(ok.status).toBe(201);
    expect((await rowOf(body<PaymentView>(ok).data!.id)).note).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Rollback: one provider never asked about the other's payments
  // -------------------------------------------------------------------------

  it('a pending payment Fintava took, on a server running Nuvion: Nuvion is never asked about it; past the bound it goes to review naming the provider', async () => {
    const p = await buyer(500_000);
    const id = randomUUID();
    const reference = `wawu-pay-${id}`;
    const sentAt = new Date(Date.now() - 5 * 60_000);
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: p.id,
        kind: 'content_unlock',
        targetId: 'n-rollback',
        title: 'Piece n-rollback',
        payeeWawuUserId: creator.wawuUserId,
        priceKobo: BigInt(PRICE),
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: BigInt(PRICE),
        payeeShareKobo: 85_000n,
        wawuShareKobo: 15_000n,
        customerReference: reference,
        payerAccountNumber: p.account.accountNumber,
        merchantAccountNumber: '1234567890',
        provider: 'fintava',
        status: 'pending',
        openKey: `${p.id}:content_unlock:n-rollback`,
        nextCheckAt: sentAt,
        sentAt,
        createdAt: sentAt,
      },
    });
    await sweepLater();
    let row = await rowOf(id);
    expect([row.status, row.checks, row.reviewSince]).toEqual([
      'pending',
      1,
      null,
    ]);
    expect(askedAbout(reference)).toBe(0);

    await payments.sweep(new Date(Date.now() + 73 * 3_600_000));
    row = await rowOf(id);
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toContain('taken by fintava');
    expect(askedAbout(reference)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Round 7 (10 Oct 2026): the provider's own record decides the figures on
  // every path (R6-1), the merchant row never stays pending (R6-2), and the
  // round 6 survivors (R6-3)
  // -------------------------------------------------------------------------

  /** A pending payment of `n-<item>` with Nuvion charging `fee` instead of the quote. */
  async function pendingAt(
    p: Person,
    item: string,
    feeDelta: number,
  ): Promise<{ q: PaymentQuoteView; paid: PaymentView }> {
    const q = await quoted(p, 'content_unlock', item);
    const fee = BigInt(q.fee.providerFeeKobo + feeDelta);
    nuvion.feeKobo = () => fee;
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('pending');
    return { q, paid };
  }

  const bothRows = async (reference: string) => {
    const rows = await ledgerRows(reference);
    return {
      out: rows.find((r) => r.direction === 'out')!,
      inn: rows.find((r) => r.direction === 'in')!,
    };
  };

  it("R6-1 on the sweep (Nuvion's documented path): Nuvion took MORE than the quote after a pending first answer: the payment records the real total, is flagged with both figures, is delivered once; the buyer's row is held with its note, the merchant row completes", async () => {
    const p = await buyer(1_000_000);
    const { q, paid } = await pendingAt(p, 'n-sweep-above', 700);
    nuvion.settle(paid.reference, 'successful');
    await sweepLater();
    const real = q.totalKobo + 700;
    const row = await rowOf(paid.id);
    expect(row.status).toBe('completed');
    expect([row.totalKobo, row.providerFeeKobo]).toEqual([
      BigInt(real),
      BigInt(q.fee.providerFeeKobo + 700),
    ]);
    expect(row.debitReviewSince).not.toBeNull();
    expect(row.discrepancy).toContain(`took ${real} kobo`);
    expect(row.discrepancy).toContain(`quoted ${q.totalKobo} kobo`);
    // The ledger's own note about the two charges is on the payment too.
    expect(row.discrepancy).toContain(
      `feeKobo ${q.fee.providerFeeKobo} vs ${q.fee.providerFeeKobo + 700}`,
    );
    expect(deliveriesOf(paid.id)).toBe(1);
    expect(p.account.availableKobo).toBe(BigInt(1_000_000 - real));
    const { out, inn } = await bothRows(paid.reference);
    expect(inn.status).toBe('completed');
    expect(out.status).toBe('pending');
    expect(out.discrepancy).toContain(`feeKobo ${q.fee.providerFeeKobo} vs`);
    // The answer a repeat of the request gets is the real total too.
    const again = await payments.settle(paid.id);
    expect(again).toBe('completed');
  });

  it('R6-1 on the sweep: Nuvion took LESS than the quote after a pending first answer: both ledger rows complete at the real figures, the payment records them and the difference, no flag, delivered once', async () => {
    const p = await buyer(1_000_000);
    const { q, paid } = await pendingAt(p, 'n-sweep-below', -500);
    nuvion.settle(paid.reference, 'successful');
    await sweepLater();
    const real = q.totalKobo - 500;
    const row = await rowOf(paid.id);
    expect(row.status).toBe('completed');
    expect(row.totalKobo).toBe(BigInt(real));
    expect(row.providerFeeKobo).toBe(BigInt(q.fee.providerFeeKobo - 500));
    expect(row.debitReviewSince).toBeNull();
    expect(row.discrepancy).toContain('debit differs from the quote');
    expect(row.discrepancy).toContain(`took ${real} kobo`);
    expect(deliveriesOf(paid.id)).toBe(1);
    expect(p.account.availableKobo).toBe(BigInt(1_000_000 - real));
    const { out, inn } = await bothRows(paid.reference);
    expect([
      out.status,
      out.totalKobo,
      out.feeKobo,
      out.providerFeeKobo,
    ]).toEqual([
      'completed',
      BigInt(real),
      BigInt(q.fee.providerFeeKobo - 500),
      BigInt(q.fee.providerFeeKobo - 500),
    ]);
    expect([inn.status, inn.totalKobo]).toEqual(['completed', BigInt(PRICE)]);
    expect(out.completedAt).not.toBeNull();
  });

  it("R6-1 on the receipt (Nuvion answers successful at once): LESS than the quote completes the buyer's row at the real figures too (round 6 left it pending); MORE keeps it held and flagged", async () => {
    const p = await buyer(2_000_000);
    nuvion.mode = 'successful';
    const below = await quoted(p, 'content_unlock', 'n-receipt-below');
    nuvion.feeKobo = () => BigInt(below.fee.providerFeeKobo - 500);
    const low = body<PaymentView>(await pay(p, below)).data!;
    expect(low).toMatchObject({
      status: 'completed',
      totalKobo: below.totalKobo - 500,
    });
    let rows = await bothRows(low.reference);
    expect([rows.out.status, rows.out.totalKobo]).toEqual([
      'completed',
      BigInt(below.totalKobo - 500),
    ]);
    expect(rows.inn.status).toBe('completed');
    expect((await rowOf(low.id)).debitReviewSince).toBeNull();

    const above = await quoted(p, 'content_unlock', 'n-receipt-above');
    nuvion.feeKobo = () => BigInt(above.fee.providerFeeKobo + 700);
    const high = body<PaymentView>(await pay(p, above)).data!;
    expect(high).toMatchObject({
      status: 'completed',
      totalKobo: above.totalKobo + 700,
    });
    rows = await bothRows(high.reference);
    expect(rows.out.status).toBe('pending');
    expect(rows.inn.status).toBe('completed');
    const highRow = await rowOf(high.id);
    expect(highRow.debitReviewSince).not.toBeNull();
    expect(highRow.discrepancy).toContain(
      `feeKobo ${above.fee.providerFeeKobo} vs ${above.fee.providerFeeKobo + 700}`,
    );
  });

  it("R6-1 when the ledger status check looks first: a charge other than the quote is held on the buyer's row (never completed at the quote), and the payment sweep then completes the payment at the provider's figures, flagged when above, with the buyer's row completed when below", async () => {
    const p = await buyer(2_000_000);
    const { q: qa, paid: pa } = await pendingAt(p, 'n-check-above', 700);
    const { q: qb, paid: pb } = await pendingAt(p, 'n-check-below', -500);
    nuvion.settle(pa.reference, 'successful');
    nuvion.settle(pb.reference, 'successful');
    for (const paid of [pa, pb]) {
      const { out } = await bothRows(paid.reference);
      const r = await statusChecks.check(
        out.id,
        new Date(Date.now() + 10 * 60_000),
      );
      // A disagreement about the charge: the row waits, the payment is not
      // completed at the quote by the row.
      expect(r.status).toBe('pending');
      expect((await rowOf(paid.id)).status).toBe('pending');
    }
    await sweepLater();

    const above = await rowOf(pa.id);
    expect(above.status).toBe('completed');
    expect(above.totalKobo).toBe(BigInt(qa.totalKobo + 700));
    expect(above.debitReviewSince).not.toBeNull();
    // The status check's note, already copied onto the payment, is kept once.
    expect(above.discrepancy).toContain(
      `feeKobo ${qa.fee.providerFeeKobo} vs ${qa.fee.providerFeeKobo + 700}`,
    );
    const aboveRows = await bothRows(pa.reference);
    expect(aboveRows.out.status).toBe('pending');
    // The note the status check wrote and the payment's own are not doubled.
    const notes = (aboveRows.out.discrepancy ?? '').split('; ');
    expect(new Set(notes).size).toBe(notes.length);

    const below = await rowOf(pb.id);
    expect(below.status).toBe('completed');
    expect(below.totalKobo).toBe(BigInt(qb.totalKobo - 500));
    expect(below.debitReviewSince).toBeNull();
    const belowRows = await bothRows(pb.reference);
    expect([belowRows.out.status, belowRows.out.totalKobo]).toEqual([
      'completed',
      BigInt(qb.totalKobo - 500),
    ]);
    expect(belowRows.inn.status).toBe('completed');
    expect(deliveriesOf(pa.id)).toBe(1);
    expect(deliveriesOf(pb.id)).toBe(1);
  });

  it("R6-1, a buyer's row MONEY-08 failed as absent, and Nuvion then shows the transfer below the quote: the row is revived and completed at the real figures", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-absent-below');
    nuvion.feeKobo = () => BigInt(q.fee.providerFeeKobo - 500);
    nuvion.mode = 'timeout';
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('pending');
    const { out } = await bothRows(paid.reference);
    await prisma.fintavaLedgerEntry.update({
      where: { id: out.id },
      data: { status: 'failed', failureReason: LEDGER_ABSENT_FAILURE },
    });
    nuvion.settle(paid.reference, 'successful');
    await sweepLater();
    const row = await rowOf(paid.id);
    expect(row.status).toBe('completed');
    expect(row.totalKobo).toBe(BigInt(q.totalKobo - 500));
    const rows = await bothRows(paid.reference);
    expect([
      rows.out.status,
      rows.out.totalKobo,
      rows.out.failureReason,
    ]).toEqual(['completed', BigInt(q.totalKobo - 500), null]);
    expect(rows.out.revivedAt).not.toBeNull();
    expect(rows.inn.status).toBe('completed');
    expect(deliveriesOf(paid.id)).toBe(1);
  });

  it("R6-1, a buyer's row that no longer holds the figures the payment was quoted at is left alone: the payment completes at the real figures, the row is not overwritten", async () => {
    const p = await buyer(500_000);
    const { q, paid } = await pendingAt(p, 'n-row-moved', -500);
    const { out } = await bothRows(paid.reference);
    await prisma.fintavaLedgerEntry.update({
      where: { id: out.id },
      data: {
        feeKobo: out.feeKobo + 7n,
        totalKobo: out.totalKobo + 7n,
      },
    });
    nuvion.settle(paid.reference, 'successful');
    await sweepLater();
    expect((await rowOf(paid.id)).totalKobo).toBe(BigInt(q.totalKobo - 500));
    const rows = await bothRows(paid.reference);
    expect([rows.out.status, rows.out.totalKobo]).toEqual([
      'pending',
      BigInt(q.totalKobo + 7),
    ]);
    expect(rows.inn.status).toBe('completed');
  });

  it("R6-1, a stop about the AMOUNT on the buyer's row is never overridden by a lower charge: the payment completes at the real figures, the row stays held for a person", async () => {
    const p = await buyer(500_000);
    const { q, paid } = await pendingAt(p, 'n-amount-stop', -500);
    const { out } = await bothRows(paid.reference);
    await prisma.fintavaLedgerEntry.update({
      where: { id: out.id },
      data: { discrepancy: 'status check: amountKobo 100000 vs 100100' },
    });
    nuvion.settle(paid.reference, 'successful');
    await sweepLater();
    const row = await rowOf(paid.id);
    expect(row.status).toBe('completed');
    expect(row.totalKobo).toBe(BigInt(q.totalKobo - 500));
    const rows = await bothRows(paid.reference);
    expect(rows.out.status).toBe('pending');
    expect(rows.out.totalKobo).toBe(BigInt(q.totalKobo));
    expect(rows.inn.status).toBe('completed');
  });

  it("the ledger status check compares Nuvion's charge only once Nuvion says the transfer is completed: while it is still pending, a charge other than the quote is no disagreement yet", async () => {
    const p = await buyer(500_000);
    const { paid } = await pendingAt(p, 'n-check-pending', 700);
    const { out } = await bothRows(paid.reference);
    const checked = await statusChecks.check(
      out.id,
      new Date(Date.now() + 10 * 60_000),
    );
    expect(checked.status).toBe('pending');
    const after = await bothRows(paid.reference);
    expect([after.out.status, after.out.discrepancy]).toEqual([
      'pending',
      null,
    ]);
    expect((await rowOf(paid.id)).status).toBe('pending');
  });

  it('R6-2, the net under every path: a completed payment whose merchant row is somehow still pending (a ledger write that failed once) has it completed by the next sweep', async () => {
    const p = await buyer(500_000);
    nuvion.mode = 'successful';
    const q = await quoted(p, 'content_unlock', 'n-merchant-net');
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('completed');
    await prisma.fintavaLedgerEntry.updateMany({
      where: { customerReference: paid.reference, direction: 'in' },
      data: { status: 'pending', completedAt: null },
    });
    expect((await bothRows(paid.reference)).inn.status).toBe('pending');
    await sweepLater();
    const rows = await bothRows(paid.reference);
    expect([rows.out.status, rows.inn.status]).toEqual([
      'completed',
      'completed',
    ]);
    expect(rows.inn.totalKobo).toBe(BigInt(PRICE));
    expect(deliveriesOf(paid.id)).toBe(1);
  });

  it("R6-2, before the payment sweep's first check: the sweep wins and both ledger rows complete, delivered once", async () => {
    const p = await buyer(500_000);
    const { paid } = await pendingAt(p, 'n-race-before', 0);
    nuvion.settle(paid.reference, 'successful');
    await sweepLater();
    const { out, inn } = await bothRows(paid.reference);
    expect([(await rowOf(paid.id)).status, out.status, inn.status]).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(deliveriesOf(paid.id)).toBe(1);
  });

  it("R6-2, between: the ledger status check wins before the payment sweep has looked at all: the payment completes from the buyer's row and the merchant row completes with it, delivered once", async () => {
    const p = await buyer(500_000);
    const { paid } = await pendingAt(p, 'n-race-between', 0);
    nuvion.settle(paid.reference, 'successful');
    const { out } = await bothRows(paid.reference);
    const checked = await statusChecks.check(
      out.id,
      new Date(Date.now() + 10 * 60_000),
    );
    expect(checked.status).toBe('completed');
    await until(
      async () => (await rowOf(paid.id)).fulfilledAt !== null,
      'the delivery',
    );
    const rows = await bothRows(paid.reference);
    expect([rows.out.status, rows.inn.status]).toEqual([
      'completed',
      'completed',
    ]);
    expect((await rowOf(paid.id)).checks).toBe(0);
    await sweepLater();
    expect(deliveriesOf(paid.id)).toBe(1);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it("R6-2, after the payment sweep's first check (Nuvion still pending then): the ledger status check wins later, and both ledger rows complete, delivered once", async () => {
    const p = await buyer(500_000);
    const { paid } = await pendingAt(p, 'n-race-after', 0);
    await sweepLater();
    expect((await rowOf(paid.id)).checks).toBe(1);
    nuvion.settle(paid.reference, 'successful');
    const { out } = await bothRows(paid.reference);
    const checked = await statusChecks.check(
      out.id,
      new Date(Date.now() + 10 * 60_000),
    );
    expect(checked.status).toBe('completed');
    await until(
      async () => (await rowOf(paid.id)).fulfilledAt !== null,
      'the delivery',
    );
    const rows = await bothRows(paid.reference);
    expect([rows.out.status, rows.inn.status]).toEqual([
      'completed',
      'completed',
    ]);
    await sweepLater();
    expect(deliveriesOf(paid.id)).toBe(1);
  });

  it('V4: a transfer Nuvion moved at another amount and then reversed goes to review (still pending, the item claimed), never to reversed', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-rev-other');
    nuvion.extraKobo = 100n;
    const paid = body<PaymentView>(await pay(p, q)).data!;
    nuvion.settle(paid.reference, 'successful');
    nuvion.settle(paid.reference, 'reversed');
    await sweepLater();
    const row = await rowOf(paid.id);
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.openKey).not.toBeNull();
    expect(row.discrepancy).toContain(`reversed ${PRICE + 100} kobo`);
    expect(deliveriesOf(paid.id)).toBe(0);
  });

  it('V6: a reversal that reaches the payment through its ledger row frees the item at once: reversed, nothing delivered, payable again', async () => {
    const p = await buyer(500_000);
    const { paid } = await pendingAt(p, 'n-rev-ledger', 0);
    nuvion.settle(paid.reference, 'successful');
    nuvion.settle(paid.reference, 'reversed');
    const { out } = await bothRows(paid.reference);
    await statusChecks.check(out.id, new Date(Date.now() + 10 * 60_000));
    await until(
      async () => (await rowOf(paid.id)).status === 'reversed',
      'the payment follows its reversed ledger row',
    );
    const row = await rowOf(paid.id);
    expect(row.openKey).toBeNull();
    expect(deliveriesOf(paid.id)).toBe(0);
    expect(
      body<PaymentView>(await quote(p, 'content_unlock', 'n-rev-ledger'))
        .statusCode,
    ).toBe(200);
  });

  it("V8: when Nuvion cannot say whether the payer is WAWU's own account, nothing is sent: 503, nothing stored, the key free, and the same key pays once Nuvion answers", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-cannot-say');
    const key = randomUUID();
    const original = nuvion.isSameAccount.bind(nuvion);
    nuvion.isSameAccount = () =>
      Promise.reject(
        new WalletProviderError({
          kind: 'unavailable',
          provider: 'nuvion',
          operation: 'is same account',
          recordMayExist: false,
          retryAfterSeconds: 30,
        }),
      );
    try {
      const res = await pay(p, q, key);
      expect(res.status).toBe(503);
      expect(sendsFrom(p)).toHaveLength(0);
      expect(
        await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
      ).toBe(0);
      expect(
        await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
      ).toBe(0);
    } finally {
      nuvion.isSameAccount = original;
    }
    nuvion.mode = 'successful';
    expect(body<PaymentView>(await pay(p, q, key)).data!.status).toBe(
      'completed',
    );
  });

  it("V9: a provider with no way to compare accounts (Fintava names an account by one number) is still refused when WAWU's account is the payer's wallet id: the text guard alone", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-text-guard');
    const original = Object.getOwnPropertyDescriptor(
      NuvionSeamStandIn.prototype,
      'isSameAccount',
    );
    forgetPlatformAccount();
    nuvion.platformOverride = {
      accountNumber: p.account.accountId,
      accountName: 'WAWU Operational',
      availableKobo: 0n,
      bookedKobo: 0n,
    };
    Object.defineProperty(nuvion, 'isSameAccount', {
      value: undefined,
      configurable: true,
    });
    try {
      const res = await pay(p, q);
      expect(res.status).toBe(503);
      expect(body(res).message).toBe(PAYMENTS_UNAVAILABLE_MESSAGE);
      expect(sendsFrom(p)).toHaveLength(0);
      expect(
        await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
      ).toBe(0);
    } finally {
      delete (nuvion as unknown as Record<string, unknown>).isSameAccount;
      expect(original).toBeDefined();
      forgetPlatformAccount();
      nuvion.platformOverride = null;
    }
  });

  it('V11: a blank quote token is a 400 naming the field, like any other text WAWU cannot store, before anything is claimed', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-blank-token');
    const res = await pay(p, q, randomUUID(), { quoteToken: '   ' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(body(res).message)).toContain('quoteToken');
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(sendsFrom(p)).toHaveLength(0);
  });

  it('V13: two payments by one person at the limit are checked one after the other: the second waits for the first in the claim, then sees it and is refused (deterministic: it waits on the lock, not on time)', async () => {
    const p = await buyer(2_000_000);
    nuvion.mode = 'successful';
    const first = await quoted(p, 'content_unlock', 'n-lim-first');
    expect(body<PaymentView>(await pay(p, first)).data!.status).toBe(
      'completed',
    );
    // 100,000 of today's 250,000 is used: room for one more ₦1,000, not two.
    const qa = await quoted(p, 'content_unlock', 'n-lim-a');
    const qb = await quoted(p, 'content_unlock', 'n-lim-b');
    let release!: () => void;
    claimHold = {
      reached: 0,
      open: new Promise<void>((r) => {
        release = r;
      }),
    };
    const hold = claimHold;
    const advisoryWaiters = async () =>
      (
        await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_locks
           WHERE locktype = 'advisory' AND NOT granted
             AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
      )[0].n;
    try {
      const a = pay(p, qa).then((r) => r);
      await until(() => hold.reached >= 1, 'the first claim to be held');
      const b = pay(p, qb).then((r) => r);
      // The second is either waiting on the person's lock (checked in order)
      // or, if nothing makes it wait, in its own claim beside the first.
      await until(
        async () => hold.reached >= 2 || (await advisoryWaiters()) >= 1,
        'the second payment to wait or to reach its claim',
      );
      release();
      const [ra, rb] = await Promise.all([a, b]);
      expect([ra.status, rb.status]).toEqual([201, 403]);
      expect(body(rb).reason).toMatchObject({
        code: 'limit_reached',
        limit: 'daily',
      });
    } finally {
      release();
      claimHold = null;
    }
    expect(sendsFrom(p)).toHaveLength(2);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(2);
  });

  it("V14: the daily limit counts the price, not the price plus the provider's charge: a tip of exactly the limit passes and one kobo more is refused", async () => {
    nuvion.mode = 'successful';
    const exact = await buyer(2_000_000);
    const qe = await quoted(
      exact,
      'tip',
      'creator-x',
      `&amountKobo=${DAILY_PURCHASE_LIMIT_KOBO}`,
    );
    expect(qe.fee.providerFeeKobo).toBeGreaterThan(0);
    const ok = await pay(exact, qe, randomUUID(), {
      amountKobo: DAILY_PURCHASE_LIMIT_KOBO,
    });
    expect(ok.status).toBe(201);
    expect(body<PaymentView>(ok).data!.status).toBe('completed');
    const over = await buyer(2_000_000);
    const qo = await quoted(
      over,
      'tip',
      'creator-x',
      `&amountKobo=${DAILY_PURCHASE_LIMIT_KOBO + 1}`,
    );
    const no = await pay(over, qo, randomUUID(), {
      amountKobo: DAILY_PURCHASE_LIMIT_KOBO + 1,
    });
    expect(no.status).toBe(403);
    expect(body(no).reason).toMatchObject({
      code: 'limit_reached',
      limit: 'daily',
    });
    expect(sendsFrom(over)).toHaveLength(0);
  });

  it('V16: a request that fails AFTER its payment is attached (the money may have moved) keeps its key: a retry under it is still "in progress", never a second payment', async () => {
    const p = await buyer(500_000);
    nuvion.mode = 'successful';
    const q = await quoted(p, 'content_unlock', 'n-key-kept');
    const key = randomUUID();
    const finish = jest
      .spyOn(keys, 'finish')
      .mockRejectedValueOnce(new Error('the answer could not be stored'));
    try {
      const res = await pay(p, q, key);
      expect(res.status).toBe(500);
    } finally {
      finish.mockRestore();
    }
    const stored = await prisma.moneyIdempotencyKey.findMany({
      where: { wawuUserId: p.id },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].resourceId).not.toBeNull();
    expect(sendsFrom(p)).toHaveLength(1);
    const retry = await pay(p, q, key);
    expect(retry.status).toBe(409);
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it("M11: the item's price changing between the payment's first read and its read inside the claim gives the claim back: 409 quote_changed, nothing sent, the key free", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-price-shift');
    priceShift.set(`${p.id}:n-price-shift`, { reads: 1, priceKobo: 150_000 });
    nuvion.mode = 'successful';
    const key = randomUUID();
    const res = await pay(p, q, key);
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('quote_changed');
    expect(sendsFrom(p)).toHaveLength(0);
    const rows = await prisma.walletPayment.findMany({
      where: { payerWawuUserId: p.id },
    });
    expect(rows.map((r) => [r.status, r.openKey])).toEqual([['failed', null]]);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);
  });

  it("lead ruling 6: every ledger row this task wrote names its payment's provider; nothing reached the Fintava client; every payment of this file names Nuvion", async () => {
    expect(movements.length).toBeGreaterThan(0);
    const ids = [...new Set(movements.map((m) => m.paymentId!))];
    const providers = await prisma.walletPayment.findMany({
      where: { id: { in: ids } },
      select: { id: true, provider: true },
    });
    const byId = new Map(providers.map((r) => [r.id, r.provider]));
    // The rows as stored: NUV-01's LedgerService stamps the running
    // provider, which for every row here is the payment's own (the sweep
    // acts only on the running provider's payments).
    const entries = await prisma.fintavaLedgerEntry.findMany({
      where: { paymentId: { in: ids } },
      select: { paymentId: true, provider: true },
    });
    expect(entries.length).toBeGreaterThanOrEqual(ids.length);
    for (const e of entries) {
      expect(e.provider).toBe(byId.get(e.paymentId!));
      expect(e.provider).toBe('nuvion');
    }
    expect(fintavaHits).toEqual([]);
    const rows = await prisma.walletPayment.findMany({
      where: {
        payerWawuUserId: { in: users },
        NOT: { targetId: 'n-rollback' },
      },
      select: { provider: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((r) => r.provider))).toEqual(new Set(['nuvion']));
  });
});
