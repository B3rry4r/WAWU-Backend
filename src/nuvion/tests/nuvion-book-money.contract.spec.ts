import { randomBytes, randomUUID } from 'node:crypto';
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
  NuvionAccountsStandin,
  type StandinAccount,
} from '../../../test/nuvion/accounts-standin';
import {
  NuvionBookStandin,
  type StandinBookTransfer,
} from '../../../test/nuvion/book-standin';
import { NuvionStandin } from '../../../test/nuvion/nuvion-standin';
import { WawuIdDouble } from '../../../test/nuvion/wawu-id-double';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../test/nuvion/outbound-guard';
import { WawuIdClient } from '../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../hub-app-options';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { MoneyError } from '../../money/money-error';
import { MoneyModule } from '../../money/money.module';
import type {
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';
import {
  type CompletedPayment,
  PayableRegistry,
} from '../../money/payments/payable-registry';
import { WalletPaymentService } from '../../money/payments/wallet-payment.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { nuvionWalletId } from '../areas/accounts';
import { NuvionBookArea } from '../areas/book';
import { PrismaNuvionBookStore } from '../areas/book-store';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider, nuvionAreas } from '../nuvion-wallet-provider';
import { signNuvionDelivery } from '../webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * NUV-05 end to end: the real MoneyModule (payments, holds, the ledger), the
 * real Nuvion adapter and client, Nuvion's stand-in over a socket
 * (test/nuvion/book-standin.ts), Nuvion's signed deliveries posted to the
 * real receiver and handed to the real handler by the real dispatcher, a
 * real database, real RS256 tokens. Nothing here reaches a Nuvion, Fintava
 * or wawuafrica.com host: every connection but loopback is refused
 * (outbound-guard.ts), and a counter stands where Fintava's base URL points.
 *
 * Nuvion charges what the spec's fee settings say (`NUVION_FEE_BOOK_TRANSFER`
 * bands), as the settings are Nuvion's published charge once the owner
 * fills them (NUV-10): no figure here is a fact.
 */

jest.setTimeout(120_000);

const RUN = `n5m-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_nuv05_book_0123456789abcdef';
const PIN = '5937';
const BASE = '/api/hub/money';
const HOOK = '/api/hub/webhooks/nuvion';
const FEE_BANDS = '0:1500,500000:2500';
const PRICE = 100_000;

/** The charge the settings above give: what the stand-in takes on a book transfer. */
const bandFee = (amount: number) => (amount >= 500_000 ? 2_500 : 1_500);

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

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `n5-${sub}@test.wawu.dev`,
      phone: '+2348000009905',
      firstName: 'Nuvion',
      lastName: 'Booker',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: { code: string };
};
const body = <T>(res: Response) => res.body as Envelope<T>;

async function until(
  ok: () => Promise<boolean> | boolean,
  what: string,
  capMs = 30_000,
): Promise<void> {
  const end = Date.now() + capMs;
  while (Date.now() < end) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`until: ${what} never held`);
}

let numberSeq = 0;
const nuban = () =>
  `6${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

describe('NUV-05 end to end: pay from the wallet and held money over Nuvion book transfers', () => {
  const standin = new NuvionStandin();
  const wawuId = new WawuIdDouble();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let payments: WalletPaymentService;
  let holds: WalletHoldService;
  let dispatcher: NuvionWebhookDispatcher;
  let fintavaCounter: Server;
  const fintavaHits: string[] = [];
  const users: string[] = [];
  const delivered: CompletedPayment[] = [];

  /**
   * The payment is delivered exactly once. A payment's status turns
   * `completed` a moment BEFORE its delivery is claimed and made (MONEY-18
   * round 3), so the delivery is waited for, and then a rest is given so a
   * second one would show.
   */
  async function deliveredOnce(paymentId: string): Promise<void> {
    await until(
      () => delivered.filter((d) => d.paymentId === paymentId).length >= 1,
      'the payment to be delivered',
    );
    await new Promise((r) => setTimeout(r, 200));
    expect(delivered.filter((d) => d.paymentId === paymentId)).toHaveLength(1);
  }
  const previous: Record<string, string | undefined> = {};
  let clock = Date.now();
  const later = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  const creator = {
    wawuUserId: randomUUID(),
    displayName: 'Chimamanda Adichie',
    handle: 'chimamanda',
    avatarUrl: null,
    tick: 'creator' as const,
  };

  interface Person {
    id: string;
    auth: string;
    account: StandinAccount;
    accountNumber: string;
  }

  async function person(kobo: number, pin = true): Promise<Person> {
    const id = randomUUID();
    users.push(id);
    const accountNumber = nuban();
    const account = book.openPerson(kobo, accountNumber);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: account.entity_id,
        walletId: nuvionWalletId(account.entity_id, account.id),
        accountNumber,
        provider: 'nuvion',
      },
    });
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: id,
        entityId: account.entity_id,
        accountId: account.id,
        nuvionBan: account.nuvion_ban,
        accountNumber,
        status: 'approved',
        currency: 'NGN',
      },
    });
    const auth = `Bearer ${mintToken(id)}`;
    if (pin) {
      const set = await request(app.getHttpServer())
        .post(`${BASE}/pin`)
        .set('Authorization', auth)
        .send({ pin: PIN, pinConfirmation: PIN });
      expect(set.status).toBe(201);
    }
    return { id, auth, account, accountNumber };
  }

  /** Makes the creator the payee of a person. */
  async function payee(): Promise<Person> {
    return person(0, false);
  }

  const targets = new Map<
    string,
    { priceKobo: number; payee: string | null }
  >();
  function item(price = PRICE, payeeId: string | null = creator.wawuUserId) {
    const id = `n-${randomUUID()}`;
    targets.set(id, { priceKobo: price, payee: payeeId });
    return id;
  }

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

  function payRequest(
    p: Person,
    q: PaymentQuoteView,
    key: string = randomUUID(),
  ) {
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

  async function pay(
    p: Person,
    kind: 'content_unlock' | 'paid_dm' | 'event_ticket' = 'content_unlock',
    targetId = item(),
  ): Promise<{ view: PaymentView; reference: string }> {
    const q = await quoted(p, kind, targetId);
    const res = await payRequest(p, q);
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    const row = await prisma.walletPayment.findUniqueOrThrow({
      where: { id: view.id },
    });
    return { view, reference: row.customerReference };
  }

  const paymentRow = (id: string) =>
    prisma.walletPayment.findUniqueOrThrow({ where: { id } });
  const transferOf = (reference: string): StandinBookTransfer => {
    const t = book.byReference(reference);
    expect(t).toHaveLength(1);
    return t[0];
  };

  /** The columns of a ledger row that say what it is (never its update time). */
  const rowsOf = async (reference: string) =>
    (
      await prisma.fintavaLedgerEntry.findMany({
        where: { customerReference: reference },
        orderBy: [{ direction: 'asc' }, { walletKind: 'asc' }],
      })
    ).map((r) => ({
      walletKind: r.walletKind,
      accountNumber: r.accountNumber,
      direction: r.direction,
      status: r.status,
      amountKobo: String(r.amountKobo),
      feeKobo: String(r.feeKobo),
      totalKobo: String(r.totalKobo),
      discrepancy: r.discrepancy,
      failureReason: r.failureReason,
      fintavaTransactionId: r.fintavaTransactionId,
      completedAt: r.completedAt?.toISOString() ?? null,
      reversedAt: r.reversedAt?.toISOString() ?? null,
    }));

  let evt = 0;
  async function deliver(
    event: string,
    data: unknown,
    opts: { id?: string } = {},
  ): Promise<string> {
    evt += 1;
    const id = opts.id ?? `${RUN}-${evt}-${randomBytes(4).toString('hex')}`;
    const ts = new Date().toISOString();
    const raw = JSON.stringify({ event, data });
    const res = await request(app.getHttpServer() as Server)
      .post(HOOK)
      .set('Content-Type', 'application/json')
      .set('x-nuvion-event-id', id)
      .set('x-nuvion-event-timestamp', ts)
      .set(
        'x-nuvion-event-signature',
        signNuvionDelivery(SECRET, ts, Buffer.from(raw)),
      )
      .send(raw);
    expect(res.status).toBe(200);
    return id;
  }

  async function dispatch(eventId: string) {
    const r = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
      where: { eventId },
    });
    await prisma.nuvionWebhookEvent.update({
      where: { id: r.id },
      data: { nextAttemptAt: null },
    });
    await dispatcher.dispatch(r.id);
    return prisma.nuvionWebhookEvent.findUniqueOrThrow({ where: { eventId } });
  }

  const deliverAndDispatch = async (event: string, data: unknown) =>
    dispatch(await deliver(event, data));

  /** What a reversal looks like when Nuvion sends it as a credit record. */
  const creditRecordOf = (t: StandinBookTransfer) => ({
    id: `01CRD${randomBytes(8).toString('hex').toUpperCase()}`.slice(0, 26),
    amount: t.amount,
    currency: 'NGN',
    unique_reference: `${t.unique_reference}_reversal`,
    counterparty_id: `acct-${t.account_id}-card-debit-reversal`,
    account_id: t.account_id,
    entity_id: t.entity_id,
    status: 'successful',
    status_reason: 'payment_reversed',
    narration: `REVERSAL | ${t.id}`,
    type: 'inflow',
    payment_type: 'book-transfer',
    applicable_fee: 0,
    meta: { source: 'payment_reversal', source_payment_id: t.id },
    created: Date.now(),
    updated: Date.now(),
  });

  beforeAll(async () => {
    guard = guardOutbound();
    fintavaCounter = createServer((req, res) => {
      fintavaHits.push(`${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('{}');
    });
    await new Promise<void>((r) =>
      fintavaCounter.listen(0, '127.0.0.1', () => r()),
    );
    const port = (fintavaCounter.address() as AddressInfo).port;
    await standin.start();
    await wawuId.start();
    accounts.install();
    book.install();
    book.fundOperational(5_000_000);
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_n05_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'n05-nuvion-fee-quote-key-0123456789abcdef01',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: FEE_BANDS,
      NUVION_FEE_BANK_PAYOUT: FEE_BANDS,
      NUVION_FEE_INFLOW: FEE_BANDS,
      NUVION_WEBHOOK_SECRET: SECRET,
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const client = new NuvionClient(
      standin.settings({
        operationalAccountId: book.operational.id,
        moneyTimeoutMs: 2_000,
        readTimeoutMs: 2_000,
      }),
      'nv_test_sk_NUV05moneyKEY000000000000000',
    );
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        NuvionWebhookModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useFactory({
        inject: [PrismaService],
        factory: (db: PrismaService) =>
          new NuvionWalletProvider(client, {
            ...nuvionAreas(client),
            // No wait inside the request: a transfer Nuvion has not finished
            // is pending, and its delivery or the sweep says (the wait is
            // covered in nuvion-book.contract.spec.ts).
            book: new NuvionBookArea(
              client,
              client.settings,
              new PrismaNuvionBookStore(db),
              { settleStepsMs: [] },
            ),
          }),
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
    dispatcher = moduleRef.get(NuvionWebhookDispatcher);

    const registry = moduleRef.get(PayableRegistry);
    const resolve = ({
      targetId,
      amountKobo,
    }: {
      targetId: string;
      amountKobo?: number;
    }) => {
      const t = targets.get(targetId);
      if (!t) throw new MoneyError('target_not_found', 'That is gone.');
      return Promise.resolve({
        title: `Item ${targetId.slice(0, 8)}`,
        priceKobo: amountKobo ?? t.priceKobo,
        payee: t.payee
          ? t.payee === creator.wawuUserId
            ? creator
            : { ...creator, wawuUserId: t.payee }
          : null,
      });
    };
    registry.register({
      kind: 'content_unlock',
      resolve,
      onCompleted: async (p) => {
        await Promise.resolve();
        delivered.push(p);
      },
    });
    for (const kind of ['paid_dm', 'event_ticket'] as const) {
      registry.register({
        kind,
        resolve,
        onCompleted: async (p) => {
          await Promise.resolve();
          delivered.push(p);
        },
      });
    }
  });

  afterAll(async () => {
    if (prisma) {
      const pays = await prisma.walletPayment.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { id: true, customerReference: true },
      });
      const holdRows = await prisma.walletHold.findMany({
        where: { paymentId: { in: pays.map((r) => r.id) } },
        select: { customerReference: true },
      });
      const refs = [
        ...pays.map((r) => r.customerReference),
        ...holdRows
          .map((h) => h.customerReference)
          .filter((r): r is string => !!r),
      ];
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { customerReference: { in: refs } },
      });
      await prisma.walletHold.deleteMany({
        where: { paymentId: { in: pays.map((r) => r.id) } },
      });
      await prisma.walletPayment.deleteMany({
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.nuvionBookTransfer.deleteMany({
        where: { reference: { in: refs } },
      });
      await prisma.nuvionWebhookEvent.deleteMany({
        where: { eventId: { startsWith: RUN } },
      });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.nuvionEntity.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
    }
    if (app) await app.close();
    await standin.stop();
    await wawuId.stop();
    await new Promise<void>((r) => fintavaCounter.close(() => r()));
    guard.restore();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    standin.reset();
    book.mode = 'pending';
    book.duplicateAs = '409';
    book.feeKobo = bandFee;
    book.extraKobo = 0;
    book.failReason = 'compliance_hold';
    book.createRequests.length = 0;
  });

  // -------------------------------------------------------------------------
  // Pay from the wallet
  // -------------------------------------------------------------------------

  describe('a payment from a wallet', () => {
    it("is one book transfer into WAWU's operational account; Nuvion answers pending, and its delivery completes the payment and the ledger once", async () => {
      const buyer = await person(500_000);
      const opBefore = book.availableOf(book.operational.id);
      const { view, reference } = await pay(buyer);
      expect(view.status).toBe('pending');
      expect(reference.length).toBeLessThanOrEqual(64);
      expect(book.createRequests).toHaveLength(1);
      expect(book.createRequests[0]).toMatchObject({
        account_id: buyer.account.id,
        entity_id: buyer.account.entity_id,
        amount: PRICE,
        payment_type: 'book-transfer',
        nuvion_ban: book.operational.nuvion_ban,
        unique_reference: reference,
      });
      // The buyer paid the price and Nuvion's charge; WAWU is not paid yet.
      expect(book.availableOf(buyer.account.id)).toBe(500_000 - PRICE - 1_500);
      expect(book.availableOf(book.operational.id)).toBe(opBefore);
      expect(delivered.filter((d) => d.paymentId === view.id)).toHaveLength(0);
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'pending',
        'pending',
      ]);

      // Nuvion finishes it and says so.
      const t = book.settle(reference, 'successful');
      const stored = await deliverAndDispatch('outflows.completed', t);
      expect(stored.processingStatus).toBe('processed');
      await until(
        async () => (await paymentRow(view.id)).status === 'completed',
        'the payment to complete from the delivery',
      );
      await until(
        () => delivered.filter((d) => d.paymentId === view.id).length === 1,
        'the payment to be delivered',
      );
      expect(book.availableOf(book.operational.id)).toBe(opBefore + PRICE);
      const rows = await rowsOf(reference);
      expect(rows).toEqual([
        expect.objectContaining({
          direction: 'in',
          walletKind: 'merchant',
          accountNumber: 'NVXYT1GUCM',
          status: 'completed',
          amountKobo: String(PRICE),
          fintavaTransactionId: t.id,
        }),
        expect.objectContaining({
          direction: 'out',
          walletKind: 'user',
          accountNumber: buyer.accountNumber,
          status: 'completed',
          amountKobo: String(PRICE),
          feeKobo: '1500',
          totalKobo: String(PRICE + 1_500),
          discrepancy: null,
          fintavaTransactionId: t.id,
        }),
      ]);
      const p = await paymentRow(view.id);
      expect(p).toMatchObject({
        status: 'completed',
        provider: 'nuvion',
        priceKobo: BigInt(PRICE),
        payeeShareKobo: 85_000n,
        wawuShareKobo: 15_000n,
      });

      // The same delivery again (same id: stored once; a re-issue under a
      // new id: handled again) changes nothing.
      const before = await rowsOf(reference);
      await deliverAndDispatch('outflows.completed', t);
      await deliver('outflows.completed', t, {
        id: (
          await prisma.nuvionWebhookEvent.findFirstOrThrow({
            where: { eventId: { startsWith: RUN } },
            orderBy: { receivedAt: 'asc' },
          })
        ).eventId,
      });
      await deliverAndDispatch('outflows.created', t);
      expect(await rowsOf(reference)).toEqual(before);
      expect(delivered.filter((d) => d.paymentId === view.id)).toHaveLength(1);
      expect((await paymentRow(view.id)).status).toBe('completed');
      expect(book.byReference(reference)).toHaveLength(1);
    });

    it('a transfer Nuvion finishes at once completes the payment inside the request', async () => {
      book.mode = 'successful';
      const buyer = await person(500_000);
      const opBefore = book.availableOf(book.operational.id);
      const { view, reference } = await pay(buyer);
      expect(view.status).toBe('completed');
      expect(book.availableOf(book.operational.id)).toBe(opBefore + PRICE);
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'completed',
        'completed',
      ]);
      expect(delivered.filter((d) => d.paymentId === view.id)).toHaveLength(1);
      // Late events for a done transfer change nothing.
      const t = transferOf(reference);
      const before = await rowsOf(reference);
      for (const event of [
        'outflows.created',
        'outflows.completed',
        'outflows.completed',
      ]) {
        const stored = await deliverAndDispatch(event, t);
        expect(stored.processingStatus).toBe('processed');
      }
      expect(await rowsOf(reference)).toEqual(before);
    });

    it('the same request eight times at once moves money once', async () => {
      book.mode = 'successful';
      const buyer = await person(500_000);
      const id = item();
      const q = await quoted(buyer, 'content_unlock', id);
      const key = randomUUID();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => payRequest(buyer, q, key)),
      );
      const ok = results.filter((r) => r.status === 201);
      expect(ok.length).toBeGreaterThanOrEqual(1);
      const ids = new Set(ok.map((r) => body<PaymentView>(r).data!.id));
      expect(ids.size).toBe(1);
      expect(book.createRequests).toHaveLength(1);
      expect(book.availableOf(buyer.account.id)).toBe(500_000 - PRICE - 1_500);
    });

    it('a payer without the price and the charge is told the shortfall and nothing is sent', async () => {
      const buyer = await person(PRICE + 1_000);
      const id = item();
      const q = await quoted(buyer, 'content_unlock', id);
      expect(q.fee.providerFeeKobo).toBe(1_500);
      const res = await payRequest(buyer, q);
      expect(res.status).toBe(402);
      expect(body<unknown>(res).reason?.code).toBe('insufficient_funds');
      expect(book.createRequests).toHaveLength(0);
      expect(book.availableOf(buyer.account.id)).toBe(PRICE + 1_000);
    });

    it('a failed transfer fails both ledger rows and the payment once; cancelled and a repeat change nothing; the item can be paid again', async () => {
      const buyer = await person(500_000);
      const id = item();
      const { view, reference } = await pay(buyer, 'content_unlock', id);
      expect(view.status).toBe('pending');
      const t = book.settle(reference, 'failed');
      // Nuvion gives the buyer back.
      expect(book.availableOf(buyer.account.id)).toBe(500_000);
      const stored = await deliverAndDispatch('outflows.failed', t);
      expect(stored.processingStatus).toBe('processed');
      await until(
        async () => (await paymentRow(view.id)).status === 'failed',
        'the payment to fail',
      );
      const failedRows = await rowsOf(reference);
      expect(failedRows.map((r) => r.status)).toEqual(['failed', 'failed']);
      // Again, as a cancel and as a repeat under new ids: nothing changes.
      await deliverAndDispatch('outflows.failed', t);
      await deliverAndDispatch('outflows.cancelled', t);
      expect(await rowsOf(reference)).toEqual(failedRows);
      expect((await paymentRow(view.id)).status).toBe('failed');
      expect(delivered.filter((d) => d.paymentId === view.id)).toHaveLength(0);
      // Nothing is held against the item: it can be paid, as a new payment
      // under a new reference.
      book.mode = 'successful';
      const again = await pay(buyer, 'content_unlock', id);
      expect(again.view.status).toBe('completed');
      expect(again.reference).not.toBe(reference);
    });

    it('a cancelled transfer (failed with a reason) fails the payment too', async () => {
      const buyer = await person(500_000);
      const { view, reference } = await pay(buyer);
      book.failReason = 'cancelled_by_user';
      const t = book.settle(reference, 'failed');
      const stored = await deliverAndDispatch('outflows.cancelled', t);
      expect(stored.processingStatus).toBe('processed');
      await until(
        async () => (await paymentRow(view.id)).status === 'failed',
        'the payment to fail',
      );
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'failed',
        'failed',
      ]);
    });

    it('a refunded (reversed) transfer reverses both rows once, whichever shape the delivery has, and again changes nothing; a delivered payment stays as it was for a person to decide', async () => {
      book.mode = 'successful';
      const buyer = await person(500_000);
      const opBefore = book.availableOf(book.operational.id);
      const { view, reference } = await pay(buyer);
      expect(view.status).toBe('completed');
      const t = book.settle(reference, 'reversed');
      // Nuvion took the price back from WAWU and gave the buyer the lot.
      expect(book.availableOf(book.operational.id)).toBe(opBefore);
      const credit = creditRecordOf(t);
      const stored = await deliverAndDispatch('outflows.refunded', credit);
      expect(stored.processingStatus).toBe('processed');
      const reversed = await rowsOf(reference);
      expect(reversed.map((r) => r.status)).toEqual(['reversed', 'reversed']);
      // The other shape (the transfer itself), and a repeat: no change.
      await deliverAndDispatch('outflows.refunded', t);
      await deliverAndDispatch('outflows.refunded', credit);
      expect(await rowsOf(reference)).toEqual(reversed);
      expect(book.byReference(reference)).toHaveLength(1);
      // The payment was delivered before the reversal: nothing un-delivers
      // it here (BACKEND_GAPS G-450); the ledger says what Nuvion did.
      expect((await paymentRow(view.id)).status).toBe('completed');
      expect(delivered.filter((d) => d.paymentId === view.id)).toHaveLength(1);
    });

    it('a transfer Nuvion completed and reversed before it was read reverses the pending payment, once', async () => {
      const buyer = await person(500_000);
      const { view, reference } = await pay(buyer);
      expect(view.status).toBe('pending');
      book.settle(reference, 'successful');
      const t = book.settle(reference, 'reversed');
      const stored = await deliverAndDispatch(
        'outflows.refunded',
        creditRecordOf(t),
      );
      expect(stored.processingStatus).toBe('processed');
      await until(
        async () => (await paymentRow(view.id)).status === 'reversed',
        'the payment to be reversed',
      );
      const rows = await rowsOf(reference);
      expect(rows.map((r) => r.status)).toEqual(['reversed', 'reversed']);
      await deliverAndDispatch('outflows.refunded', creditRecordOf(t));
      expect(await rowsOf(reference)).toEqual(rows);
      expect(delivered.filter((d) => d.paymentId === view.id)).toHaveLength(0);
    });

    it("an event ahead of Nuvion's own record waits and changes nothing; the record decides; a stale failed for a completed transfer does not undo it", async () => {
      const buyer = await person(500_000);
      const { view, reference } = await pay(buyer);
      const t = transferOf(reference);
      // `.completed` while Nuvion's record still says pending: it waits.
      const early = await deliverAndDispatch('outflows.completed', {
        ...t,
        status: 'successful',
      });
      expect(early.processingStatus).toBe('pending');
      expect(early.note).toMatch(
        /outflows\.completed came but Nuvion's record says pending/,
      );
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'pending',
        'pending',
      ]);
      // Nuvion finishes it. The waiting delivery is tried again; a stale
      // `.failed` that arrives now does not undo what the record says.
      book.settle(reference, 'successful');
      const stale = await deliverAndDispatch('outflows.failed', {
        ...t,
        status: 'failed',
      });
      expect(stale.processingStatus).toBe('processed');
      await until(
        async () => (await paymentRow(view.id)).status === 'completed',
        'the payment to complete',
      );
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'completed',
        'completed',
      ]);
      const waiting = await prisma.nuvionWebhookEvent.findFirstOrThrow({
        where: {
          event: 'outflows.completed',
          processingStatus: 'pending',
          payload: { path: ['data', 'id'], equals: t.id },
        },
      });
      await prisma.nuvionWebhookEvent.update({
        where: { id: waiting.id },
        data: { nextAttemptAt: null },
      });
      await dispatcher.dispatch(waiting.id);
      const after = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
        where: { id: waiting.id },
      });
      expect(after.processingStatus).toBe('processed');
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'completed',
        'completed',
      ]);
      expect((await paymentRow(view.id)).status).toBe('completed');
    });

    it.each([
      ['above', 2_000, 'debit above the quote'],
      ['below', 1_000, 'debit differs from the quote'],
    ])(
      "a charge %s the quote: the payment completes at the charge Nuvion's record states, and the difference is kept",
      async (_what, charge, note) => {
        const buyer = await person(500_000);
        const { view, reference } = await pay(buyer);
        // Nuvion took another charge than the settings the quote came from.
        const t = book.byReference(reference)[0];
        const total = PRICE + charge;
        buyer.account.balance.available =
          Number(buyer.account.balance.available) + 1_500 - charge;
        t.applicable_fee = charge;
        book.settle(reference, 'successful');
        const stored = await deliverAndDispatch('outflows.completed', t);
        expect(stored.processingStatus).toBe('processed');
        // The payment turns `completed`, then its figures and the note of the
        // difference are written (two steps): the end state is waited for.
        await until(async () => {
          const q = await paymentRow(view.id);
          return (
            q.status === 'completed' &&
            q.providerFeeKobo === BigInt(charge) &&
            (q.discrepancy ?? '').includes(note)
          );
        }, 'the payment to complete at the stated charge with its note');
        const p = await paymentRow(view.id);
        expect(p.providerFeeKobo).toBe(BigInt(charge));
        expect(p.totalKobo).toBe(BigInt(total));
        expect(p.discrepancy ?? '').toContain(note);
        const out = (await rowsOf(reference)).find(
          (r) => r.direction === 'out',
        );
        expect(out).toMatchObject({
          status: 'completed',
          feeKobo: String(charge),
          totalKobo: String(total),
        });
        await deliveredOnce(view.id);
      },
    );

    it("a delivery for a transfer WAWU did not send is left alone: another rail, or a move on Nuvion's dashboard", async () => {
      const before = await prisma.fintavaLedgerEntry.count();
      const strangers = [
        { ...transferShape(book.operational), payment_type: 'bank-transfer' },
        {
          ...transferShape(book.operational),
          unique_reference: 'dashboard-move-1',
        },
      ];
      for (const data of strangers) {
        const stored = await deliverAndDispatch('outflows.completed', data);
        // NUV-06 (changed there, SHARED-CHANGES NUV-06 #5): a `bank-transfer`
        // outflow is that task's rail. Its handler reads the transfer back,
        // finds none Nuvion holds under this made-up id, and waits (it is not
        // a send of ours to leave alone); this task's handler still leaves it
        // alone, and the ledger below is unchanged.
        expect(stored.processingStatus).toBe(
          data.payment_type === 'bank-transfer' ? 'pending' : 'processed',
        );
      }
      // A card's refund shares the event name.
      const card = await deliverAndDispatch('outflows.refunded', {
        ...transferShape(book.operational),
        type: 'inflow',
        payment_type: 'card-debit-reversal',
      });
      expect(card.processingStatus).toBe('processed');
      expect(await prisma.fintavaLedgerEntry.count()).toBe(before);
      expect(
        standin.seen.filter(
          (r) => r.method === 'GET' && r.path.startsWith('/transfers/'),
        ),
      ).toHaveLength(1); // NUV-06's read-back of the bank-transfer stranger; none by this task's handler
    });

    it('a delivery that names another transfer than the one under our reference is a stop kept for review', async () => {
      const buyer = await person(500_000);
      const { reference } = await pay(buyer);
      const t = transferOf(reference);
      const stored = await deliverAndDispatch('outflows.completed', {
        ...t,
        id: '01HXYZSOMEOTHERTRANSFER001',
      });
      expect(stored.processingStatus).toBe('failed');
      expect(stored.note).toMatch(/another transfer/);
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'pending',
        'pending',
      ]);
    });

    it('a record that is not the transfer we sent is a stop kept for review, and nothing is recorded', async () => {
      const buyer = await person(500_000);
      const { reference } = await pay(buyer);
      const t = transferOf(reference);
      const swapped = book.byId(t.id)!;
      swapped.amount += 1;
      try {
        const stored = await deliverAndDispatch('outflows.completed', t);
        expect(stored.processingStatus).toBe('failed');
        expect(stored.note).toMatch(/not the transfer we sent/);
      } finally {
        swapped.amount -= 1;
      }
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'pending',
        'pending',
      ]);
    });

    it('a lost answer: the payment is pending, the sweep finds the transfer by its reference, completes it once and sends nothing again', async () => {
      book.mode = 'successful';
      const buyer = await person(500_000);
      book.loseAnswerNext(true);
      const { view, reference } = await pay(buyer);
      expect(view.status).toBe('pending');
      expect(book.byReference(reference)).toHaveLength(1);
      const sent = book.createRequests.length;
      await payments.sweep(later());
      await until(
        async () => (await paymentRow(view.id)).status === 'completed',
        'the sweep to find the transfer',
      );
      expect(book.createRequests).toHaveLength(sent);
      expect(book.byReference(reference)).toHaveLength(1);
      await deliveredOnce(view.id);
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'completed',
        'completed',
      ]);
      expect(book.availableOf(buyer.account.id)).toBe(500_000 - PRICE - 1_500);
    });

    it('a lost answer with nothing made at Nuvion: never failed, never sent again under a new reference', async () => {
      book.mode = 'successful';
      const buyer = await person(500_000);
      book.loseAnswerNext(false);
      const { view, reference } = await pay(buyer);
      expect(view.status).toBe('pending');
      expect(book.byReference(reference)).toHaveLength(0);
      for (let i = 0; i < 3; i += 1) await payments.sweep(later(10 * 60_000));
      const p = await paymentRow(view.id);
      expect(p.status).toBe('pending');
      expect(p.customerReference).toBe(reference);
      // One attempt, never sent again under this reference or another.
      expect(book.createRequests).toHaveLength(1);
      expect(book.createRequests[0].unique_reference).toBe(reference);
      expect(book.availableOf(buyer.account.id)).toBe(500_000);
    });
  });

  // -------------------------------------------------------------------------
  // Held money: release and refund
  // -------------------------------------------------------------------------

  describe('held money in the operational account', () => {
    async function held(kind: 'paid_dm' | 'event_ticket' = 'paid_dm') {
      book.mode = 'successful';
      const payeeP = await payee();
      const buyer = await person(500_000);
      const id = item(PRICE, payeeP.id);
      const { view } = await pay(buyer, kind, id);
      expect(view.status).toBe('completed');
      const hold = await prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: view.id },
      });
      book.mode = 'pending';
      return { payeeP, buyer, view, hold };
    }

    it('a release is one book transfer out of the operational account to the payee, once, and reaches the ledger once', async () => {
      const { payeeP, view, hold } = await held();
      const reference = `wawu-rel-${hold.id}`;
      const opBefore = book.availableOf(book.operational.id);
      const s = await holds.release({ paymentId: view.id });
      expect(s).toMatchObject({ state: 'pending', status: 'held' });
      expect(book.byReference(reference)).toHaveLength(1);
      expect(book.createRequests.at(-1)).toMatchObject({
        account_id: book.operational.id,
        amount: 85_000,
        nuvion_ban: payeeP.account.nuvion_ban,
        payment_type: 'book-transfer',
        unique_reference: reference,
      });
      expect(book.createRequests.at(-1)).not.toHaveProperty('entity_id');
      // Not paid until Nuvion finishes; a repeat sends nothing again.
      expect(book.availableOf(payeeP.account.id)).toBe(0);
      await holds.release({ paymentId: view.id });
      expect(book.byReference(reference)).toHaveLength(1);

      const t = book.settle(reference, 'successful');
      // The delivery changes nothing in the ledger (the hold writes its own
      // rows when it settles), and the hold's sweep settles it once.
      const stored = await deliverAndDispatch('outflows.completed', t);
      expect(stored.processingStatus).toBe('processed');
      expect(await rowsOf(reference)).toEqual([]);
      await holds.sweep(later());
      const done = await prisma.walletHold.findUniqueOrThrow({
        where: { id: hold.id },
      });
      expect(done.status).toBe('released');
      expect(done.providerFeeKobo).toBe(BigInt(bandFee(85_000)));
      expect(book.availableOf(payeeP.account.id)).toBe(85_000);
      // WAWU's account paid the amount and Nuvion's charge (R-31).
      expect(opBefore - book.availableOf(book.operational.id)).toBe(
        85_000 + bandFee(85_000),
      );
      const rows = await rowsOf(reference);
      expect(
        rows.map((r) => [r.walletKind, r.direction, r.status, r.feeKobo]),
      ).toEqual([
        ['user', 'in', 'completed', '0'],
        ['merchant', 'out', 'completed', String(bandFee(85_000))],
      ]);
      // Deliveries again, and sweeps again: still one transfer, two rows.
      await deliverAndDispatch('outflows.completed', t);
      await deliverAndDispatch('outflows.created', t);
      await holds.sweep(later());
      expect(await rowsOf(reference)).toEqual(rows);
      expect(book.byReference(reference)).toHaveLength(1);
    });

    it('a refund returns the price to the payer, once, even asked twice at once', async () => {
      const { buyer, view, hold } = await held('event_ticket');
      const reference = `wawu-ref-${hold.id}`;
      const before = book.availableOf(buyer.account.id);
      await Promise.all([
        holds.refund({ paymentId: view.id }),
        holds.refund({ paymentId: view.id }),
      ]);
      expect(book.byReference(reference)).toHaveLength(1);
      book.settle(reference, 'successful');
      await holds.sweep(later());
      const done = await prisma.walletHold.findUniqueOrThrow({
        where: { id: hold.id },
      });
      expect(done).toMatchObject({
        status: 'refunded',
        refundedKobo: 100_000n,
      });
      // The payer gets the price, not Nuvion's charge on the original.
      expect(book.availableOf(buyer.account.id) - before).toBe(PRICE);
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'completed',
        'completed',
      ]);
    });

    it("a release WAWU's own account cannot cover waits, sends nothing, and moves when it can", async () => {
      const { payeeP, view, hold } = await held();
      const reference = `wawu-rel-${hold.id}`;
      const op = book.operational;
      const funds = Number(op.balance.available);
      op.balance.available = 1_000;
      op.balance.current = 1_000;
      try {
        const s = await holds.release({ paymentId: view.id });
        expect(s).toMatchObject({ state: 'waiting', status: 'held' });
        expect(book.byReference(reference)).toHaveLength(0);
        expect(book.availableOf(payeeP.account.id)).toBe(0);
      } finally {
        op.balance.available = funds;
        op.balance.current = funds;
      }
      book.mode = 'successful';
      await holds.sweep(later(2 * 3_600_000));
      expect(
        (await prisma.walletHold.findUniqueOrThrow({ where: { id: hold.id } }))
          .status,
      ).toBe('released');
      expect(book.byReference(reference)).toHaveLength(1);
      expect(book.availableOf(payeeP.account.id)).toBe(85_000);
    });

    it('a release whose answer is lost is found by its reference and not sent again', async () => {
      const { payeeP, view, hold } = await held();
      const reference = `wawu-rel-${hold.id}`;
      book.mode = 'successful';
      book.loseAnswerNext(true);
      const s = await holds.release({ paymentId: view.id });
      expect(s.state).toBe('pending');
      expect(book.byReference(reference)).toHaveLength(1);
      const sent = book.createRequests.length;
      await holds.sweep(later());
      expect(
        (await prisma.walletHold.findUniqueOrThrow({ where: { id: hold.id } }))
          .status,
      ).toBe('released');
      expect(book.createRequests).toHaveLength(sent);
      expect(book.availableOf(payeeP.account.id)).toBe(85_000);
      expect(await rowsOf(reference)).toHaveLength(2);
    });

    it('a release Nuvion fails is tried again under a new reference; the failed one never moved money', async () => {
      const { payeeP, view, hold } = await held();
      const first = `wawu-rel-${hold.id}`;
      await holds.release({ paymentId: view.id });
      const op = book.availableOf(book.operational.id);
      book.settle(first, 'failed');
      expect(book.availableOf(book.operational.id)).toBe(
        op + 85_000 + bandFee(85_000),
      );
      const failedEvent = await deliverAndDispatch(
        'outflows.failed',
        book.byReference(first)[0],
      );
      expect(failedEvent.processingStatus).toBe('processed');
      expect(await rowsOf(first)).toEqual([]);
      await holds.sweep(later());
      const h = await prisma.walletHold.findUniqueOrThrow({
        where: { id: hold.id },
      });
      expect(h.status).toBe('held');
      expect(h.attempt).toBe(2);
      expect(book.availableOf(payeeP.account.id)).toBe(0);
    });

    it('a release that Nuvion later reverses reverses the ledger rows once and is a stop for a person', async () => {
      const { payeeP, view, hold } = await held();
      const reference = `wawu-rel-${hold.id}`;
      book.mode = 'successful';
      await holds.release({ paymentId: view.id });
      expect((await rowsOf(reference)).map((r) => r.status)).toEqual([
        'completed',
        'completed',
      ]);
      const t = book.settle(reference, 'reversed');
      const stored = await deliverAndDispatch(
        'outflows.refunded',
        creditRecordOf(t),
      );
      expect(stored.processingStatus).toBe('processed');
      const rows = await rowsOf(reference);
      expect(rows.map((r) => r.status)).toEqual(['reversed', 'reversed']);
      await deliverAndDispatch('outflows.refunded', creditRecordOf(t));
      expect(await rowsOf(reference)).toEqual(rows);
      expect(book.availableOf(payeeP.account.id)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // The ledger equals the provider
  // -------------------------------------------------------------------------

  describe('after a run of payments, releases and refunds', () => {
    /** WAWU's side of the ledger: what came in less what went out, completed rows only. */
    async function ledgerNet(): Promise<number> {
      const rows = await prisma.fintavaLedgerEntry.findMany({
        where: {
          walletKind: 'merchant',
          accountNumber: 'NVXYT1GUCM',
          status: 'completed',
          provider: 'nuvion',
        },
        select: { direction: true, amountKobo: true, totalKobo: true },
      });
      return rows.reduce(
        (sum, r) =>
          r.direction === 'in'
            ? sum + Number(r.amountKobo)
            : sum - Number(r.totalKobo),
        0,
      );
    }

    it("the ledger's figure for the operational account moves exactly as Nuvion's available does", async () => {
      const ledgerStart = await ledgerNet();
      const providerStart = book.availableOf(book.operational.id);

      // Payments: two finished at once, one pending then finished by its
      // delivery, one failed.
      book.mode = 'successful';
      const a = await person(900_000);
      const b = await person(900_000);
      const pa = await pay(a, 'paid_dm', item(PRICE, (await payee()).id));
      const pb = await pay(
        b,
        'event_ticket',
        item(250_000, (await payee()).id),
      );
      book.mode = 'pending';
      const c = await person(900_000);
      const pc = await pay(c);
      await deliverAndDispatch(
        'outflows.completed',
        book.settle(pc.reference, 'successful'),
      );
      const d = await person(900_000);
      const pd = await pay(d);
      await deliverAndDispatch(
        'outflows.failed',
        book.settle(pd.reference, 'failed'),
      );
      await until(
        async () => (await paymentRow(pc.view.id)).status === 'completed',
        'the pending payment to complete',
      );

      // Releases and refunds of the two held payments.
      const holdA = await prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: pa.view.id },
      });
      const holdB = await prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: pb.view.id },
      });
      book.mode = 'successful';
      await holds.release({ paymentId: pa.view.id });
      await holds.refund({ paymentId: pb.view.id });
      await holds.sweep(later());
      expect(
        (await prisma.walletHold.findUniqueOrThrow({ where: { id: holdA.id } }))
          .status,
      ).toBe('released');
      expect(
        (await prisma.walletHold.findUniqueOrThrow({ where: { id: holdB.id } }))
          .status,
      ).toBe('refunded');

      const ledgerDelta = (await ledgerNet()) - ledgerStart;
      const providerDelta =
        book.availableOf(book.operational.id) - providerStart;
      expect(ledgerDelta).toBe(providerDelta);
      // And it is not a trivial figure.
      expect(providerDelta).not.toBe(0);
    });
  });

  it("nothing reached a Nuvion, Fintava or wawuafrica.com host, and Fintava's client was never called", () => {
    expect(guard.violations).toEqual([]);
    expect(fintavaHits).toEqual([]);
  });
});

/** The shape of a transfer object, for a delivery about a transfer WAWU did not send. */
function transferShape(account: StandinAccount) {
  return {
    id: `01HXYZSTRANGER${randomBytes(6).toString('hex').toUpperCase()}`.slice(
      0,
      26,
    ),
    amount: 12_345,
    currency: 'NGN',
    unique_reference: `stranger-${randomBytes(4).toString('hex')}`,
    counterparty_id: '01HXYZCOUNTERPARTY000001',
    account_id: account.id,
    entity_id: account.entity_id,
    status: 'successful',
    status_reason: 'processing_complete',
    narration: 'A move on the dashboard',
    type: 'outflow',
    payment_type: 'book-transfer',
    applicable_fee: 0,
    meta: {},
    created: Date.now(),
    updated: Date.now(),
  };
}
