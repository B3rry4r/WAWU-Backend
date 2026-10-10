import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  type NuvionAccount,
  NuvionSeamStandIn,
} from '../../../../test/payments/nuvion-seam-standin';
import {
  body,
  mintToken,
  QuietLogger,
  until,
} from '../../../../test/payments/poll-helpers';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { NO_WALLET_MESSAGE } from '../../gate/wallet-gate';
import { IDEMPOTENT_REPLAYED_HEADER } from '../idempotency';
import { MoneyError } from '../../money-error';
import { MoneyModule } from '../../money.module';
import type {
  PaymentQuoteView,
  PaymentView,
  WalletBalanceView,
} from '../../money-view.type';
import { type CompletedPayment, PayableRegistry } from '../payable-registry';
import {
  FINISHING_MESSAGE,
  PAYMENT_FAILED_REASON,
  PAYMENT_NOT_FOUND_MESSAGE,
  STILL_CONFIRMING_MESSAGE,
  WalletPaymentService,
} from '../wallet-payment.service';

/**
 * Not enough money, and still confirming (task MONEY-19), on the wallet
 * provider seam with NUVION stood in: H17, I6, S11, W13 (the shortfall) and
 * H18, E10 (the poll of a payment that is not finished).
 *
 * The real MoneyModule, a real database, real RS256 tokens checked against
 * the stand-in WAWU ID's JWKS, and `WALLET_PROVIDER` given the Nuvion
 * stand-in (`test/payments/nuvion-seam-standin.ts`). No Nuvion, Fintava or
 * wawuafrica.com host is called; the Fintava client points at a local
 * counter and the last test proves nothing reached it.
 *
 * NUVION_FEE_BOOK_TRANSFER is a spec value (kobo, `2325`: the same figure as
 * the dashboard's Fintava balance-transfer rate, so the task's "₦1,000 item,
 * ₦500 wallet, ₦523.25 short" reads the same on both providers). The owner
 * fills the real settings (NUV-10); no figure here is a fact about Nuvion.
 */

const BASE = '/api/hub/money/payments';
const PIN = '5937';
const FEE_KOBO = 2325;
const PRICE = 100_000;

jest.setTimeout(120_000);

describe('Not enough money, and still confirming (MONEY-19), Nuvion stood in', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let cheapPinHash: string;
  const nuvion = new NuvionSeamStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];
  /** How many of the next deliveries fail (the owning feature down). */
  let failDeliveries = 0;
  const previous: Record<string, string | undefined> = {};
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

  /** A person with an approved Nuvion account holding `kobo` and a PIN. */
  async function buyer(kobo: number): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    accountSeq += 1;
    const accountNumber = `82${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
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
    // The PIN as POST /money/pin stores it (argon2id), at the cheapest cost
    // the library takes: the PIN routes are proved in money-pin.contract.spec.
    await prisma.transactionPin.create({
      data: { wawuUserId: id, pinHash: cheapPinHash },
    });
    return { id, auth: `Bearer ${mintToken(id, 'poll')}`, account };
  }

  async function quoted(
    p: Person,
    targetId: string,
  ): Promise<PaymentQuoteView> {
    const res = await request(app.getHttpServer())
      .get(`${BASE}/quote?kind=content_unlock&targetId=${targetId}`)
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    const q = body<PaymentQuoteView>(res).data!;
    // Nuvion charges what its settings say, which is what the quote says.
    const fee = BigInt(q.fee.providerFeeKobo);
    nuvion.feeKobo = () => fee;
    return q;
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

  const poll = (p: Person, id: string) =>
    request(app.getHttpServer())
      .get(`${BASE}/${id}`)
      .set('Authorization', p.auth);

  async function polled(p: Person, id: string): Promise<PaymentView> {
    const res = await poll(p, id);
    expect(res.status).toBe(200);
    return body<PaymentView>(res).data!;
  }

  /** The provider's own balance for the person, through the real balance route. */
  async function balanceOf(p: Person): Promise<number> {
    const res = await request(app.getHttpServer())
      .get('/api/hub/money/wallet/balance')
      .set('Authorization', p.auth);
    expect(res.status).toBe(200);
    return body<WalletBalanceView>(res).data!.availableKobo;
  }

  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account.accountId);
  const rowOf = (id: string) =>
    prisma.walletPayment.findUniqueOrThrow({ where: { id } });
  const deliveriesOf = (id: string) =>
    delivered.filter((d) => d.paymentId === id).length;
  const callsOf = (method: string) =>
    nuvion.calls.filter((c) => c.method === method).length;

  beforeAll(async () => {
    cheapPinHash = await argon2.hash(PIN, {
      type: argon2.argon2id,
      timeCost: 1,
      memoryCost: 1024,
      parallelism: 1,
    });
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
      FINTAVA_API_KEY: 'live_test_m19_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'm19-nuvion-fee-quote-key-0123456789abcdef01',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: String(FEE_KOBO),
      NUVION_FEE_BANK_PAYOUT: String(FEE_KOBO),
      NUVION_FEE_INFLOW: String(FEE_KOBO),
      WAWU_LIMIT_PURCHASE_DAILY_KOBO: '100000000',
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

    // A selling feature registers its kind the way HOME-15 will: the price
    // from its own record, and a delivery that can fail.
    moduleRef.get(PayableRegistry).register({
      kind: 'content_unlock',
      resolve: async ({ targetId }) => {
        await Promise.resolve();
        if (!targetId.startsWith('p-')) {
          throw new MoneyError('target_not_found', 'That piece is gone.');
        }
        return { title: `Piece ${targetId}`, priceKobo: PRICE, payee: creator };
      },
      onCompleted: async (p) => {
        await Promise.resolve();
        if (failDeliveries > 0) {
          failDeliveries -= 1;
          throw new Error('feature down');
        }
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
    failDeliveries = 0;
  });

  // -------------------------------------------------------------------------
  // How much short (H17, I6, S11, W13)
  // -------------------------------------------------------------------------

  it('check 1: with ₦500 in the wallet, a ₦1,000 purchase is refused with a ₦523.25 shortfall (₦1,023.25 total), on the quote and on the payment, and nothing is sent', async () => {
    const p = await buyer(50_000);
    const q = await quoted(p, 'p-short');
    expect(q).toMatchObject({
      priceKobo: 100_000,
      totalKobo: 102_325,
      balanceKobo: 50_000,
      shortfallKobo: 52_325,
      fee: { providerFeeKobo: FEE_KOBO, wawuFeeKobo: 0 },
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
    // Nothing moved, nothing was stored, nothing was claimed.
    expect(sendsFrom(p)).toHaveLength(0);
    expect(p.account.availableKobo).toBe(50_000n);
    expect(
      await prisma.walletPayment.count({ where: { payerWawuUserId: p.id } }),
    ).toBe(0);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: p.id } }),
    ).toBe(0);

    // The person adds exactly the shortfall and taps again with the same key:
    // the payment goes through once.
    p.account.availableKobo += 52_325n;
    nuvion.mode = 'successful';
    const again = await pay(p, q, key);
    expect(again.status).toBe(201);
    expect(body<PaymentView>(again).data).toMatchObject({
      status: 'completed',
      totalKobo: 102_325,
      delivered: true,
    });
    expect(sendsFrom(p)).toHaveLength(1);
    expect(p.account.availableKobo).toBe(0n);
  });

  it('one kobo short is ₦0.01 short, never ₦0.00, and a wallet holding exactly the total pays', async () => {
    const short = await buyer(102_324);
    const q = await quoted(short, 'p-onekobo');
    expect(q.shortfallKobo).toBe(1);
    const refused = await pay(short, q);
    expect(refused.status).toBe(402);
    expect(body(refused).reason).toMatchObject({
      code: 'insufficient_funds',
      balanceKobo: 102_324,
      totalKobo: 102_325,
      shortfallKobo: 1,
    });
    expect(body(refused).message).toBe('You need ₦0.01 more in your wallet.');
    expect(sendsFrom(short)).toHaveLength(0);

    const exact = await buyer(102_325);
    const q2 = await quoted(exact, 'p-exact');
    expect(q2.shortfallKobo).toBe(0);
    nuvion.mode = 'successful';
    const paid = await pay(exact, q2);
    expect(paid.status).toBe(201);
    expect(body<PaymentView>(paid).data!.status).toBe('completed');
    expect(exact.account.availableKobo).toBe(0n);
  });

  // -------------------------------------------------------------------------
  // The poll (H18, E10)
  // -------------------------------------------------------------------------

  it('a payment answered pending is polled by its id: still confirming, then paid and delivered once', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'p-poll');
    const key = randomUUID();
    const first = await pay(p, q, key);
    expect(first.status).toBe(201);
    const pending = body<PaymentView>(first).data!;
    expect(pending).toMatchObject({
      status: 'pending',
      statusMessage: STILL_CONFIRMING_MESSAGE,
      delivered: false,
      failureReason: null,
      completedAt: null,
    });

    const res = await poll(p, pending.id);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(body<PaymentView>(res).data).toEqual(pending);

    // The provider completes the transfer; the next sweep settles the payment.
    nuvion.settle(pending.reference, 'successful');
    await sweepLater();
    const paid = await polled(p, pending.id);
    expect(paid).toMatchObject({
      id: pending.id,
      status: 'completed',
      statusMessage: null,
      delivered: true,
      priceKobo: PRICE,
      totalKobo: 102_325,
    });
    expect(paid.completedAt).not.toBeNull();
    expect(deliveriesOf(pending.id)).toBe(1);
    expect(sendsFrom(p)).toHaveLength(1);

    // The key still answers what it stored (K1); the poll is where the app
    // learns the outcome.
    const replay = await pay(p, q, key);
    expect(replay.headers[IDEMPOTENT_REPLAYED_HEADER.toLowerCase()]).toBe(
      'true',
    );
    expect(body<PaymentView>(replay).data!.status).toBe('pending');
  });

  it('check 2: pending payments become paid, failed or reversed at the next sweep, and none stays pending; the balance is the provider’s', async () => {
    const start = 500_000;
    const a = await buyer(start);
    const b = await buyer(start);
    const c = await buyer(start);
    const made: Array<{ p: Person; view: PaymentView }> = [];
    for (const [p, target] of [
      [a, 'p-resolve-a'],
      [b, 'p-resolve-b'],
      [c, 'p-resolve-c'],
    ] as const) {
      const res = await pay(p, await quoted(p, target));
      expect(res.status).toBe(201);
      const view = body<PaymentView>(res).data!;
      expect(view.status).toBe('pending');
      made.push({ p, view });
    }
    // Each person's balance already shows the debit: the provider's figure.
    for (const { p } of made) {
      expect(await balanceOf(p)).toBe(start - 102_325);
    }

    nuvion.settle(made[0].view.reference, 'successful');
    nuvion.settle(made[1].view.reference, 'failed');
    nuvion.settle(made[2].view.reference, 'successful');
    nuvion.settle(made[2].view.reference, 'reversed');
    const swept = await sweepLater();
    expect(swept.settled).toBeGreaterThanOrEqual(3);

    const [paid, failed, reversed] = await Promise.all(
      made.map(({ p, view }) => polled(p, view.id)),
    );
    expect(paid).toMatchObject({
      status: 'completed',
      delivered: true,
      statusMessage: null,
    });
    expect(failed).toMatchObject({
      status: 'failed',
      failureReason: PAYMENT_FAILED_REASON,
      delivered: false,
      statusMessage: null,
    });
    expect(reversed).toMatchObject({
      status: 'reversed',
      delivered: false,
      statusMessage: null,
      failureReason: null,
    });
    for (const view of [paid, failed, reversed]) {
      expect(view.status).not.toBe('pending');
    }
    // Only the paid one delivered anything, and its item is free of any claim.
    expect(deliveriesOf(made[0].view.id)).toBe(1);
    expect(deliveriesOf(made[1].view.id)).toBe(0);
    expect(deliveriesOf(made[2].view.id)).toBe(0);
    for (const { view } of made) {
      expect((await rowOf(view.id)).openKey).toBeNull();
    }
    // The provider's balance: the paid buyer is down the price and the charge;
    // the failed and the reversed buyers have their money back.
    expect(await balanceOf(a)).toBe(start - 102_325);
    expect(await balanceOf(b)).toBe(start);
    expect(await balanceOf(c)).toBe(start);
    // A failed or reversed payment frees the item: the same person pays again.
    nuvion.mode = 'successful';
    const retry = await pay(b, await quoted(b, 'p-resolve-b'));
    expect(retry.status).toBe(201);
    expect(body<PaymentView>(retry).data!.status).toBe('completed');
  });

  it('H18: a payment that moved the money and whose item is not delivered yet reads completed with delivered false and "finishing", blocks a second payment, and the sweep finishes it', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'p-finishing');
    nuvion.mode = 'successful';
    failDeliveries = 1;
    const res = await pay(p, q);
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view).toMatchObject({
      status: 'completed',
      delivered: false,
      statusMessage: FINISHING_MESSAGE,
    });
    expect(deliveriesOf(view.id)).toBe(0);
    expect(await polled(p, view.id)).toEqual(view);

    // Paid and not yet opened: another tap is refused and points at the payment.
    const second = await pay(p, q);
    expect(second.status).toBe(409);
    expect(body(second).reason).toMatchObject({
      code: 'payment_in_progress',
      paymentId: view.id,
    });
    expect(body(second).message).toBe(FINISHING_MESSAGE);
    expect(sendsFrom(p)).toHaveLength(1);

    await sweepLater();
    const done = await polled(p, view.id);
    expect(done).toMatchObject({
      status: 'completed',
      delivered: true,
      statusMessage: null,
    });
    expect(deliveriesOf(view.id)).toBe(1);
  });

  it('a payment the provider never answers for stays pending and goes to review past the bound: the poll says so in the same words, and the item stays blocked', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'p-silent');
    // The answer is lost and the provider holds no record of the transfer.
    nuvion.mode = 'timeout_nothing';
    const res = await pay(p, q);
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('pending');
    nuvion.mode = 'pending';

    // Asked at once, then past PAYMENT_REVIEW_AFTER_HOURS (72): never read as
    // "no money moved" (lead ruling D1).
    await sweepLater();
    expect(await polled(p, view.id)).toMatchObject({ status: 'pending' });
    const asked = callsOf('reconcileSend');
    expect(asked).toBeGreaterThan(0);
    await sweepLater(73 * 3_600_000);
    const row = await rowOf(view.id);
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toMatch(/no answer from .* after 72 hours/);
    expect(await polled(p, view.id)).toMatchObject({
      status: 'pending',
      statusMessage: STILL_CONFIRMING_MESSAGE,
      delivered: false,
    });
    // Under review it is out of the sweep: no more asking.
    const before = callsOf('reconcileSend');
    await sweepLater(3_600_000);
    expect(callsOf('reconcileSend')).toBe(before);
    // The item stays blocked, and nothing was sent a second time.
    const again = await pay(p, q);
    expect(again.status).toBe(409);
    expect(body(again).reason).toMatchObject({
      code: 'payment_in_progress',
      paymentId: view.id,
    });
    expect(
      nuvion.calls.filter(
        (c) =>
          c.method === 'walletToWallet' &&
          (c.args as { reference: string }).reference === view.reference,
      ),
    ).toHaveLength(1);
  });

  it('a payment paid at once is polled as the same answer it was paid with', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'p-instant');
    nuvion.mode = 'successful';
    const res = await pay(p, q);
    const paid = body<PaymentView>(res).data!;
    expect(paid).toMatchObject({
      status: 'completed',
      delivered: true,
      statusMessage: null,
    });
    expect(await polled(p, paid.id)).toEqual(paid);
  });

  it('only the payer reads a payment: another person and an unknown id get the same 404; a bad id is 400; no token is 401; no wallet is 409; the quote route is still the quote', async () => {
    const p = await buyer(500_000);
    const other = await buyer(500_000);
    const q = await quoted(p, 'p-private');
    nuvion.mode = 'successful';
    const paid = body<PaymentView>(await pay(p, q)).data!;

    const stranger = await poll(other, paid.id);
    const unknown = await poll(other, randomUUID());
    for (const res of [stranger, unknown]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        statusCode: 404,
        message: PAYMENT_NOT_FOUND_MESSAGE,
        data: null,
        reason: { code: 'not_found', message: PAYMENT_NOT_FOUND_MESSAGE },
      });
    }
    expect(stranger.body).toEqual(unknown.body);

    const bad = await poll(p, 'not-a-uuid');
    expect(bad.status).toBe(400);
    expect(body(bad).reason).toBeUndefined();

    const anonymous = await request(app.getHttpServer()).get(
      `${BASE}/${paid.id}`,
    );
    expect(anonymous.status).toBe(401);

    const nobody = randomUUID();
    const walletless = await request(app.getHttpServer())
      .get(`${BASE}/${paid.id}`)
      .set('Authorization', `Bearer ${mintToken(nobody, 'poll')}`);
    expect(walletless.status).toBe(409);
    expect(body(walletless).reason).toMatchObject({
      code: 'wallet_not_open',
    });
    expect(body(walletless).message).toBe(NO_WALLET_MESSAGE);

    const quote = await request(app.getHttpServer())
      .get(`${BASE}/quote?kind=content_unlock&targetId=p-private`)
      .set('Authorization', other.auth);
    expect(quote.status).toBe(200);
    expect(body<PaymentQuoteView>(quote).data).toMatchObject({
      kind: 'content_unlock',
      targetId: 'p-private',
    });
  });

  it('a poll reads our record only: it asks the provider for nothing and moves nothing', async () => {
    const p = await buyer(500_000);
    const q = await quoted(p, 'p-readonly');
    const pending = body<PaymentView>(await pay(p, q)).data!;
    const calls = nuvion.calls.length;
    const ledgerBefore = await prisma.fintavaLedgerEntry.count({
      where: { customerReference: pending.reference },
    });
    for (let i = 0; i < 5; i += 1) {
      expect((await polled(p, pending.id)).status).toBe('pending');
    }
    expect(nuvion.calls).toHaveLength(calls);
    expect(
      await prisma.fintavaLedgerEntry.count({
        where: { customerReference: pending.reference },
      }),
    ).toBe(ledgerBefore);
    expect((await rowOf(pending.id)).checks).toBe(0);
  });

  it('nothing in this file reached Fintava', async () => {
    await until(() => true);
    expect(fintavaHits).toEqual([]);
  });
});
