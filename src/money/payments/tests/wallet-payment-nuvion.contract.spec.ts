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
import { IDEMPOTENT_REPLAYED_HEADER } from '../idempotency';
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
import { type NuvionAccount, NuvionSeamStandIn } from './nuvion-seam-standin';

/**
 * Pay from wallet (MONEY-17) on the wallet provider seam (MONEY-20) with
 * NUVION stood in (lead's brief, 8 Oct 2026; PAYMENTS-PLAN: "MONEY-17 ... is
 * on the critical path of every purchase").
 *
 * The real MoneyModule, a real database, real RS256 tokens checked against
 * the stand-in WAWU ID's JWKS, and `WALLET_PROVIDER` given the Nuvion
 * stand-in (`nuvion-seam-standin.ts`: Nuvion's documented accounts, book
 * transfers, fees on top, asynchronous statuses and error types, mapped
 * onto the seam). The Fintava client is still built (WalletProviderModule
 * mounts it for Fintava's webhook receiver) and points at a local counter:
 * a spec at the end proves nothing reached it. No Nuvion, Fintava or
 * wawuafrica.com host is called.
 *
 * Fees: the stand-in's `applicable_fee` is set to what the fee quote says
 * (NUV-07 makes the provider part of a quote come from the running
 * provider's settings); no figure is written here.
 */

const BASE = '/api/hub/money/payments';
const PIN = '5937';

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
  message: string;
  data: T | null;
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response) => res.body as Envelope<T>;

describe('Pay from wallet (MONEY-17) on the provider seam, Nuvion stood in', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let merchant: MerchantWallet;
  const nuvion = new NuvionSeamStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  const owned = new Set<string>();
  const previous: Record<string, string | undefined> = {};
  /** Every request that reached the Fintava client's base URL. */
  const fintavaHits: string[] = [];
  let fintavaCounter: Server;
  let accountSeq = 0;

  const creator = {
    wawuUserId: randomUUID(),
    displayName: 'Chimamanda Adichie',
    handle: 'chimamanda',
    avatarUrl: null,
    tick: 'creator' as const,
  };

  type Person = { id: string; auth: string; account: NuvionAccount };

  /** A person with an approved Nuvion entity and NGN account holding `kobo`, PIN set. */
  async function buyer(kobo: number): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `81${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    const account = nuvion.openAccount(BigInt(kobo), accountNumber);
    // The wallet table every provider writes (NUV-01 adds its `provider`
    // column): the gate reads the person's ids from it.
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: account.entityId,
        walletId: account.accountId,
        accountNumber,
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

  function quote(p: Person, kind: string, targetId: string) {
    return request(app.getHttpServer())
      .get(`${BASE}/quote?kind=${kind}&targetId=${targetId}`)
      .set('Authorization', p.auth);
  }

  async function quoted(
    p: Person,
    kind: string,
    targetId: string,
  ): Promise<PaymentQuoteView> {
    const res = await quote(p, kind, targetId);
    expect(res.status).toBe(200);
    const q = body<PaymentQuoteView>(res).data!;
    // Nuvion's fee settings say what the quote says (NUV-07).
    const fee = BigInt(q.fee.providerFeeKobo);
    nuvion.feeKobo = () => fee;
    return q;
  }

  function pay(
    p: Person,
    q: PaymentQuoteView,
    key: string = randomUUID(),
    pin: string = PIN,
  ) {
    return request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', pin)
      .send({
        kind: q.kind,
        targetId: q.targetId,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      });
  }

  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account.accountId);
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
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
        return {
          title: `Piece ${targetId}`,
          priceKobo: 100_000,
          payee: creator,
        };
      },
      onCompleted: async (p) => {
        await Promise.resolve();
        owned.add(`${p.payerWawuUserId}:${p.targetId}`);
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
    nuvion.mode = 'instant';
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
    nuvion.mode = 'instant';
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
    nuvion.mode = 'instant';
    const third = await pay(p, q, key);
    expect(third.status).toBe(201);
    expect(body<PaymentView>(third).data!.status).toBe('completed');
    expect(sendsFrom(p)).toHaveLength(1);
  });

  it("the payer's wallet is WAWU's own account: refused before anything is sent (503)", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-self');
    forgetPlatformAccount();
    nuvion.platformOverride = {
      accountNumber: p.account.accountNumber!,
      accountName: 'WAWU Operational',
      availableKobo: 0n,
      bookedKobo: 0n,
    };
    const res = await pay(p, q);
    expect(res.status).toBe(503);
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    forgetPlatformAccount();
  });

  // -------------------------------------------------------------------------
  // The task's two capability checks, on Nuvion
  // -------------------------------------------------------------------------

  it('check 1 on Nuvion: one book transfer of the price to WAWU operational account; the buyer pays the price plus the quoted fee; the split is 85/15 of the price', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-1000');
    expect(q).toMatchObject({
      priceKobo: 100_000,
      totalKobo: 100_000 + q.fee.providerFeeKobo,
      balanceKobo: 500_000,
      shortfallKobo: 0,
      fee: { wawuFeeKobo: 0 },
    });
    const operationalBefore = nuvion.operational.availableKobo;

    const res = await pay(p, q);
    expect(res.status).toBe(201);
    const paid = body<PaymentView>(res).data!;
    expect(paid).toMatchObject({
      status: 'completed',
      priceKobo: 100_000,
      totalKobo: q.totalKobo,
      fee: q.fee,
      failureReason: null,
      statusMessage: null,
    });

    // Nuvion received one book transfer: from the payer's entity and
    // account, to the operational account's nuvion_ban, of the price, in
    // naira, under our reference (within Nuvion's 64 characters).
    expect(sendsFrom(p).map((t) => t.request)).toEqual([
      {
        entity_id: p.account.entityId,
        account_id: p.account.accountId,
        amount: 100_000,
        currency: 'NGN',
        payment_type: 'book-transfer',
        nuvion_ban: nuvion.operational.nuvionBan,
        unique_reference: `wawu-pay-${paid.id}`,
        narration: PAYMENT_NARRATION,
      },
    ]);
    expect(paid.reference.length).toBeLessThanOrEqual(64);
    // The buyer fell by the price plus Nuvion's fee; WAWU got the price.
    expect(p.account.availableKobo).toBe(BigInt(500_000 - q.totalKobo));
    expect(nuvion.operational.availableKobo - operationalBefore).toBe(100_000n);

    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    const split = splitPrice(100_000, true);
    expect({
      provider: row.provider,
      merchant: row.merchantAccountNumber,
      payee: row.payeeWawuUserId,
      payeeShareKobo: row.payeeShareKobo,
      wawuShareKobo: row.wawuShareKobo,
      discrepancy: row.discrepancy,
      openKey: row.openKey,
    }).toEqual({
      provider: 'nuvion',
      merchant: nuvion.operational.nuvionBan,
      payee: creator.wawuUserId,
      payeeShareKobo: 85_000n,
      wawuShareKobo: 15_000n,
      discrepancy: null,
      openKey: null,
    });
    expect(split).toEqual({ payeeShareKobo: 85_000, wawuShareKobo: 15_000 });

    // The ledger: the buyer's debit with Nuvion's fee, WAWU's credit, both
    // completed, Nuvion's transfer id kept.
    const transferId = sendsFrom(p)[0].id;
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
        paymentId: r.paymentId,
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
        account: nuvion.operational.nuvionBan,
        transactionId: transferId,
        paymentId: paid.id,
        discrepancy: null,
      },
      {
        wallet: 'user',
        direction: 'out',
        status: 'completed',
        amount: 100_000n,
        fee: BigInt(q.fee.providerFeeKobo),
        total: BigInt(q.totalKobo),
        account: p.account.accountNumber,
        transactionId: transferId,
        paymentId: paid.id,
        discrepancy: null,
      },
    ]);
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(1);
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
    const statuses = answers.map((a) => a.status).sort();
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(1);
    for (const a of answers) {
      if (a.status === 409) {
        expect(body(a).reason).toMatchObject({
          code: 'idempotency_in_progress',
        });
      } else {
        expect(a.status).toBe(201);
      }
    }
    // One book transfer for each of the two payments, never more.
    expect(sendsFrom(p).map((t) => t.request.unique_reference)).toEqual([
      body<PaymentView>(first).data!.reference,
      expect.stringMatching(/^wawu-pay-/),
    ]);
    expect(p.account.availableKobo).toBe(
      BigInt(1_000_000 - q.totalKobo - q2.totalKobo),
    );
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
      const reason = body(a).reason as { code: string; paymentId?: string };
      // The item is claimed (in progress) or already delivered (owned).
      expect(['payment_in_progress', 'target_not_payable']).toContain(
        reason.code,
      );
      if (reason.code === 'payment_in_progress') {
        expect(reason.paymentId).toBe(paid.id);
      }
    }
    expect(sendsFrom(p)).toHaveLength(1);
    expect(p.account.availableKobo).toBe(BigInt(2_000_000 - q.totalKobo));
  });

  // -------------------------------------------------------------------------
  // Unknown outcomes: pending until Nuvion says, never sent again
  // -------------------------------------------------------------------------

  it('a book transfer Nuvion accepted and has not completed: pending, nothing delivered; the sweep asks Nuvion, sends nothing again, and completes it once Nuvion does', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-queued');
    nuvion.mode = 'queued';
    const res = await pay(p, q);
    expect(res.status).toBe(201);
    const paid = body<PaymentView>(res).data!;
    expect(paid).toMatchObject({
      status: 'pending',
      statusMessage: STILL_CONFIRMING_MESSAGE,
      failureReason: null,
    });
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(0);
    // Nothing has moved yet at Nuvion.
    expect(p.account.availableKobo).toBe(500_000n);

    // Asked while still pending: still pending, asked again later.
    nuvion.mode = 'instant';
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    let row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.status).toBe('pending');
    expect(row.checks).toBe(1);
    expect(
      nuvion.calls.filter(
        (c) =>
          c.method === 'reconcileSend' &&
          (c.args as { reference: string }).reference === paid.reference,
      ),
    ).toHaveLength(1);

    // Another tap for the item while it is open: refused, nothing sent.
    const tap = await pay(p, q);
    expect(tap.status).toBe(409);
    expect(body(tap).reason).toMatchObject({
      code: 'payment_in_progress',
      paymentId: paid.id,
    });

    nuvion.settle(paid.reference, 'successful');
    await payments.sweep(new Date(Date.now() + 10 * 60_000));
    row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.status).toBe('completed');
    expect(row.openKey).toBeNull();
    expect(sendsFrom(p)).toHaveLength(1);
    expect(p.account.availableKobo).toBe(BigInt(500_000 - q.totalKobo));
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(1);
    const rows = await ledgerRows(paid.reference);
    expect(rows.map((r) => [r.direction, r.status])).toEqual([
      ['in', 'completed'],
      ['out', 'completed'],
    ]);
  });

  it('a queued book transfer Nuvion then fails (a compliance hold): failed, nothing moved or delivered, the item payable again', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-hold');
    nuvion.mode = 'queued';
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('pending');
    nuvion.settle(paid.reference, 'failed');
    nuvion.mode = 'instant';
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect([row.status, row.failureReason, row.openKey]).toEqual([
      'failed',
      PAYMENT_FAILED_REASON,
      null,
    ]);
    expect(p.account.availableKobo).toBe(500_000n);
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(0);
    // Paying again is a new payment, sent once.
    const second = await pay(p, q);
    expect(body<PaymentView>(second).data!.status).toBe('completed');
    expect(sendsFrom(p).filter((t) => t.status === 'successful')).toHaveLength(
      1,
    );
  });

  it('a lost answer after Nuvion moved the money: pending; the sweep finds the transfer by our reference and completes it, never sending again', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-lost');
    nuvion.mode = 'timeout';
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('pending');
    expect(sendsFrom(p)).toHaveLength(1);
    nuvion.mode = 'instant';
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.status).toBe('completed');
    expect(sendsFrom(p)).toHaveLength(1);
    expect(p.account.availableKobo).toBe(BigInt(500_000 - q.totalKobo));
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(1);
  });

  it('a lost answer and no record at Nuvion: never failed and never sent again; past the review bound it waits for a person, the item still claimed', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-silent');
    nuvion.mode = 'timeout_nothing';
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('pending');
    nuvion.mode = 'instant';
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    let row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect([row.status, row.reviewSince]).toEqual(['pending', null]);
    await payments.sweep(new Date(Date.now() + 73 * 3_600_000));
    row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toContain('no answer from Nuvion');
    expect(row.openKey).not.toBeNull();
    expect(sendsFrom(p)).toHaveLength(0);
    expect(p.account.availableKobo).toBe(500_000n);
  });

  // -------------------------------------------------------------------------
  // Money figures, refusals and the currency
  // -------------------------------------------------------------------------

  it('short of money by our read of Nuvion: 402 with the exact shortfall, nothing sent, nothing stored', async () => {
    const p = await buyer(50_000);
    const q = await quoted(p, 'content_unlock', 'n-short');
    const res = await pay(p, q);
    expect(res.status).toBe(402);
    expect(body(res).reason).toMatchObject({
      code: 'insufficient_funds',
      balanceKobo: 50_000,
      totalKobo: q.totalKobo,
      shortfallKobo: q.totalKobo - 50_000,
    });
    expect(sendsFrom(p)).toHaveLength(0);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
  });

  it("Nuvion's own insufficient funds (its fee above the quote): 402, the payment failed with both ledger sides, the key given back", async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'content_unlock', 'n-feehigh');
    // The buyer holds exactly the quoted total; Nuvion charges a kobo more.
    p.account.availableKobo = BigInt(q.totalKobo);
    nuvion.feeKobo = () => BigInt(q.fee.providerFeeKobo + 1);
    const key = randomUUID();
    const res = await pay(p, q, key);
    expect(res.status).toBe(402);
    expect(body(res).message).toBe(BALANCE_CHANGED_MESSAGE);
    expect(body(res).reason).toMatchObject({
      code: 'insufficient_funds',
      balanceKobo: q.totalKobo,
      totalKobo: q.totalKobo,
    });
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
  });

  it('Nuvion charging another fee than quoted completes the payment with the difference kept; another amount stops it for review, nothing delivered', async () => {
    const p = await buyer(1_000_000);
    const q = await quoted(p, 'content_unlock', 'n-feelow');
    nuvion.feeKobo = () => 0n;
    const paid = body<PaymentView>(await pay(p, q)).data!;
    expect(paid.status).toBe('completed');
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: paid.id },
    });
    if (q.fee.providerFeeKobo > 0) {
      expect(row.discrepancy).not.toBeNull();
    }
    expect(delivered.filter((d) => d.paymentId === paid.id)).toHaveLength(1);

    const q2 = await quoted(p, 'content_unlock', 'n-wrongamount');
    nuvion.mode = 'wrong_amount';
    const second = body<PaymentView>(await pay(p, q2)).data!;
    expect(second.status).toBe('pending');
    const held = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(held.reviewSince).not.toBeNull();
    expect(held.openKey).not.toBeNull();
    expect(delivered.filter((d) => d.paymentId === second.id)).toHaveLength(0);
  });

  it('an item priced in another currency is refused on the quote and the payment: no kobo taken for cents, nothing stored, nothing sent', async () => {
    const p = await buyer(500_000);
    const qr = await quote(p, 'content_unlock', 'dollar-piece');
    expect(qr.status).toBe(409);
    expect(body(qr).reason).toMatchObject({ code: 'target_not_payable' });
    expect(body(qr).message).toBe(OTHER_CURRENCY_MESSAGE);
    // A payment sent with a naira quote for another piece, aimed at it.
    const naira = await quoted(p, 'content_unlock', 'n-for-dollar');
    const res = await request(app.getHttpServer())
      .post(BASE)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send({
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
        priceKobo: 100_000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 100_000n,
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
    await payments.sweep(new Date(Date.now() + 2 * 60_000));
    let row = await prisma.walletPayment.findUniqueOrThrow({ where: { id } });
    expect([row.status, row.checks, row.reviewSince]).toEqual([
      'pending',
      1,
      null,
    ]);
    const asked = nuvion.calls.filter(
      (c) =>
        c.method === 'reconcileSend' &&
        (c.args as { reference: string }).reference === reference,
    );
    expect(asked).toHaveLength(0);

    await payments.sweep(new Date(Date.now() + 73 * 3_600_000));
    row = await prisma.walletPayment.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toContain('taken by fintava');
    expect(
      nuvion.calls.filter(
        (c) =>
          c.method === 'reconcileSend' &&
          (c.args as { reference: string }).reference === reference,
      ),
    ).toHaveLength(0);
  });

  it('nothing reached the Fintava client, and every payment of this file names Nuvion', async () => {
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
