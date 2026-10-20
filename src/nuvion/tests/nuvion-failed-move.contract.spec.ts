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
  NuvionAccountsStandin,
  type StandinAccount,
} from '../../../test/nuvion/accounts-standin';
import { NuvionBookStandin } from '../../../test/nuvion/book-standin';
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
import { moveReference } from '../../money/earnings/earning-rules';
import { EarningSettlementService } from '../../money/earnings/earning-settlement.service';
import { WalletHoldService } from '../../money/holds/wallet-hold.service';
import { MoneyError } from '../../money/money-error';
import { MoneyModule } from '../../money/money.module';
import type {
  PaymentQuoteView,
  PaymentView,
} from '../../money/money-view.type';
import { PayableRegistry } from '../../money/payments/payable-registry';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { nuvionWalletId } from '../areas/accounts';
import { NuvionBookArea } from '../areas/book';
import { PrismaNuvionBookStore } from '../areas/book-store';
import { NuvionClient } from '../nuvion-client';
import { NuvionWalletProvider, nuvionAreas } from '../nuvion-wallet-provider';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * A move Nuvion ACCEPTS and then FAILS lands, once, under a new reference
 * (FIX-66, CHECK-2 part A finding F1): a paid question's refund and a
 * creator's daily earnings move. Nuvion answers a book transfer `pending`
 * and the adapter reads it again for a few seconds; here Nuvion fails it in
 * that wait, so the failure is seen INSIDE the request that sent it. Its own
 * record (`status: failed`, api-reference__transfers.md "Transfer statuses";
 * `unique_reference` is its idempotency key, so a repeat of the reference
 * answers with the same failed record) says the reference is spent: the
 * move is tried again under a new one, never the same one for ever.
 *
 * The real MoneyModule, the real Nuvion adapter and client with its book
 * area, Nuvion's stand-in over a socket (test/nuvion/book-standin.ts), a real
 * database, real RS256 tokens. Nothing here reaches a Nuvion, Fintava or
 * wawuafrica.com host.
 */

jest.setTimeout(120_000);

const RUN = `f66-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_w16_book_0123456789abcdef';
const PIN = '5937';
const BASE = '/api/hub/money';
const FEE_BANDS = '0:1500,500000:2500';
const bandFee = (amount: number) => (amount >= 500_000 ? 2_500 : 1_500);
/** The payee's 85%, rounded down to the kobo (R-5), worked out here. */
const shareOf = (priceKobo: number) => Math.floor((priceKobo * 85) / 100);

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
      email: `w16-${sub}@test.wawu.dev`,
      phone: '+2348000009915',
      firstName: 'Nuvion',
      lastName: 'Earner',
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

let numberSeq = 0;
const nuban = () =>
  `6${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

describe('FIX-66: a move Nuvion accepts and then fails is tried again under a new reference, once', () => {
  const standin = new NuvionStandin();
  const wawuId = new WawuIdDouble();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let earnings: EarningSettlementService;
  let holds: WalletHoldService;
  let fintavaCounter: Server;
  const fintavaHits: string[] = [];
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const startedAt = new Date();
  let clock = Date.now();
  const later = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };
  /**
   * Nuvion fails the transfers it holds pending during the next N waits of
   * the adapter (the wait between its answer `pending` and the read of the
   * transfer again), as its processing would: the payer is given back.
   */
  let failWaits = 0;
  let testStart = Date.now();
  const failWhileWaiting = (): Promise<void> => {
    if (failWaits > 0) {
      failWaits -= 1;
      for (const t of book.all()) {
        if (t.status === 'pending' && Number(t.created) >= testStart) {
          book.settle(t.id, 'failed');
        }
      }
    }
    return Promise.resolve();
  };
  const targets = new Map<
    string,
    { priceKobo: number; payee: string | null }
  >();

  interface Person {
    id: string;
    auth: string;
    account: StandinAccount | null;
    accountNumber: string;
  }

  function mint(): Person {
    const id = randomUUID();
    users.push(id);
    return {
      id,
      auth: `Bearer ${mintToken(id)}`,
      account: null,
      accountNumber: '',
    };
  }

  /** The person's Nuvion wallet opens now, holding `kobo`. */
  async function openFor(p: Person, kobo: number): Promise<Person> {
    p.accountNumber = nuban();
    p.account = book.openPerson(kobo, p.accountNumber);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: p.id,
        customerId: p.account.entity_id,
        walletId: nuvionWalletId(p.account.entity_id, p.account.id),
        accountNumber: p.accountNumber,
        provider: 'nuvion',
      },
    });
    await prisma.nuvionEntity.create({
      data: {
        wawuUserId: p.id,
        entityId: p.account.entity_id,
        accountId: p.account.id,
        nuvionBan: p.account.nuvion_ban,
        accountNumber: p.accountNumber,
        status: 'approved',
        currency: 'NGN',
      },
    });
    return p;
  }

  async function person(kobo: number, pin = true): Promise<Person> {
    const p = await openFor(mint(), kobo);
    if (pin) {
      const set = await request(app.getHttpServer())
        .post(`${BASE}/pin`)
        .set('Authorization', p.auth)
        .send({ pin: PIN, pinConfirmation: PIN });
      expect(set.status).toBe(201);
    }
    return p;
  }

  function item(payee: Person, price = 100_000): string {
    const id = `w-${randomUUID()}`;
    targets.set(id, { priceKobo: price, payee: payee.id });
    return id;
  }

  /** Pays for an ordinary item: Nuvion finishes the payment's own transfer at once. */
  async function sale(
    buyer: Person,
    targetId: string,
    kind: 'content_unlock' | 'paid_dm' = 'content_unlock',
  ): Promise<PaymentView> {
    const prior = book.mode;
    book.mode = 'successful';
    const qres = await request(app.getHttpServer())
      .get(`${BASE}/payments/quote?kind=${kind}&targetId=${targetId}`)
      .set('Authorization', buyer.auth);
    expect(qres.status).toBe(200);
    const q = body<PaymentQuoteView>(qres).data!;
    const res = await request(app.getHttpServer())
      .post(`${BASE}/payments`)
      .set('Authorization', buyer.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send({
        kind: q.kind,
        targetId: q.targetId,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      });
    expect(res.status).toBe(201);
    const view = body<PaymentView>(res).data!;
    expect(view.status).toBe('completed');
    book.mode = prior;
    return view;
  }

  const settlementOrThrow = (paymentId: string) =>
    prisma.earningSettlement.findUniqueOrThrow({ where: { paymentId } });
  /** The creator's move of the day (R-55): the one book transfer their earnings travel in. */
  const moveOf = (p: Person) =>
    prisma.earningMove.findFirstOrThrow({
      where: { payeeWawuUserId: p.id },
      orderBy: { createdAt: 'asc' },
    });
  const pass = (ms?: number) => earnings.sweep(later(ms));
  const rowsOf = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
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
      FINTAVA_API_KEY: 'live_test_w16_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'w16-nuvion-fee-quote-key-0123456789abcdef01',
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
      'nv_test_sk_W16earningsKEY00000000000000',
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
            book: new NuvionBookArea(
              client,
              client.settings,
              new PrismaNuvionBookStore(db),
              {
                settleStepsMs: [1],
                sleep: () => failWhileWaiting(),
              },
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
    earnings = moduleRef.get(EarningSettlementService);
    holds = moduleRef.get(WalletHoldService);

    const registry = moduleRef.get(PayableRegistry);
    for (const kind of ['content_unlock', 'paid_dm'] as const)
      registry.register({
        kind,
        resolve: ({ targetId }) => {
          const t = targets.get(targetId);
          if (!t) throw new MoneyError('target_not_found', 'That is gone.');
          return Promise.resolve({
            title: `Item ${targetId.slice(0, 8)}`,
            priceKobo: t.priceKobo,
            payee: t.payee
              ? {
                  wawuUserId: t.payee,
                  displayName: 'Chimamanda Adichie',
                  handle: 'chimamanda',
                  avatarUrl: null,
                  tick: 'creator' as const,
                }
              : null,
          });
        },
        onCompleted: async () => {
          await Promise.resolve();
        },
      });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.earningSettlement.deleteMany({
        where: { createdAt: { gte: startedAt } },
      });
      await prisma.earningMove.deleteMany({
        where: { createdAt: { gte: startedAt } },
      });
      const pays = await prisma.walletPayment.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { payeeWawuUserId: { in: users } },
          ],
        },
        select: { id: true, customerReference: true },
      });
      const refs = pays.map((r) => r.customerReference);
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: refs } },
            { customerReference: { startsWith: 'wawu-earn-' } },
          ],
        },
      });
      const holdRows = await prisma.walletHold.findMany({
        where: { paymentId: { in: pays.map((r) => r.id) } },
        select: { id: true },
      });
      const holdRefs = holdRows.flatMap((h) => [
        { customerReference: { startsWith: `wawu-ref-${h.id}` } },
        { customerReference: { startsWith: `wawu-rel-${h.id}` } },
      ]);
      if (holdRefs.length > 0) {
        await prisma.fintavaLedgerEntry.deleteMany({ where: { OR: holdRefs } });
        await prisma.nuvionBookTransfer.deleteMany({
          where: {
            OR: holdRows.flatMap((h) => [
              { reference: { startsWith: `wawu-ref-${h.id}` } },
              { reference: { startsWith: `wawu-rel-${h.id}` } },
            ]),
          },
        });
      }
      await prisma.walletHold.deleteMany({
        where: { paymentId: { in: pays.map((r) => r.id) } },
      });
      await prisma.earningSettlement.deleteMany({
        where: { paymentId: { in: pays.map((r) => r.id) } },
      });
      await prisma.walletPayment.deleteMany({
        where: { id: { in: pays.map((r) => r.id) } },
      });
      await prisma.nuvionBookTransfer.deleteMany({
        where: {
          OR: [
            { reference: { in: refs } },
            { reference: { startsWith: 'wawu-earn-' } },
          ],
        },
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
    book.createRequests.length = 0;
    failWaits = 0;
    testStart = Date.now();
  });

  const OPERATIONAL_START = 5_000_000;
  const operational = () => book.availableOf(book.operational.id);
  const nuvionBalance = (p: Person) => book.availableOf(p.account!.id);
  const hubBalance = async (p: Person) =>
    body<{ availableKobo: number }>(
      await request(app.getHttpServer())
        .get(`${BASE}/wallet/balance`)
        .set('Authorization', p.auth),
    ).data!.availableKobo;
  const netOf = (
    rows: Array<{ direction: string; totalKobo: bigint }>,
  ): number =>
    rows.reduce(
      (n, r) => n + (r.direction === 'in' ? 1 : -1) * Number(r.totalKobo),
      0,
    );
  /** What WAWU's ledger says a person's wallet changed by (completed rows only). */
  const ledgerNetOf = async (p: Person) =>
    netOf(
      await prisma.fintavaLedgerEntry.findMany({
        where: { wawuUserId: p.id, status: 'completed' },
        select: { direction: true, totalKobo: true },
      }),
    );
  /** The same for WAWU's own (operational) account, from the ledger of this run. */
  const ledgerNetOfWawu = async () =>
    netOf(
      await prisma.fintavaLedgerEntry.findMany({
        where: {
          walletKind: 'merchant',
          status: 'completed',
          createdAt: { gte: startedAt },
        },
        select: { direction: true, totalKobo: true },
      }),
    );
  /** A time `ms` from the real now: a hold is first moved at the real now, so its rests are counted from there. */
  const at = (ms: number) => new Date(Date.now() + ms);
  const holdOf = (paymentId: string) =>
    prisma.walletHold.findUniqueOrThrow({ where: { paymentId } });
  const statusesOf = (reference: string) =>
    book.byReference(reference).map((t) => t.status);

  it('F1 earnings: a move Nuvion accepts and then fails lands once, under a new reference; the Hub, Nuvion and the ledger agree', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, item(creator, 100_000));
    const opAfterSale = operational();
    book.createRequests.length = 0;

    // Nuvion takes the move and fails it inside the wait of this very request.
    failWaits = 1;
    const t0 = later();
    await earnings.sweep(t0);
    const move = await moveOf(creator);
    const ref1 = moveReference(creator.id, move.dayKey, 1);
    const ref2 = moveReference(creator.id, move.dayKey, 2);
    expect(statusesOf(ref1)).toEqual(['failed']);
    // Its own record said failed: a new try, under a new reference, resting.
    expect(move).toMatchObject({
      status: 'owed',
      attempt: 2,
      customerReference: ref2,
      sentAt: null,
      waiting: 'refused',
    });
    expect(book.createRequests).toHaveLength(1);
    expect(nuvionBalance(creator)).toBe(0);
    // Nuvion gave the failed move back: WAWU's account is where it was.
    expect(operational()).toBe(opAfterSale);
    expect((await settlementOrThrow(paid.id)).status).toBe('owed');
    // Asked again at the same moment, the move rests: nothing is sent.
    await earnings.sweep(t0);
    await earnings.sweep(t0);
    expect(book.createRequests).toHaveLength(1);

    // Later, with Nuvion healthy: one transfer under the new reference lands it.
    book.mode = 'successful';
    await pass(10 * 60_000);
    await pass(10 * 60_000);
    await pass(10 * 60_000);
    expect(statusesOf(ref1)).toEqual(['failed']);
    expect(statusesOf(ref2)).toEqual(['successful']);
    expect(book.createRequests).toHaveLength(2);
    expect((await moveOf(creator)).status).toBe('landed');
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');

    // Nothing paid twice; the Hub, Nuvion and the ledger say one figure.
    expect(nuvionBalance(creator)).toBe(shareOf(100_000));
    expect(await hubBalance(creator)).toBe(shareOf(100_000));
    expect(await ledgerNetOf(creator)).toBe(shareOf(100_000));
    expect(operational()).toBe(
      opAfterSale - shareOf(100_000) - bandFee(shareOf(100_000)),
    );
    expect(await ledgerNetOfWawu()).toBe(operational() - OPERATIONAL_START);
    expect(await rowsOf(ref1)).toHaveLength(0);
    expect(await rowsOf(ref2)).toHaveLength(2);
    expect(fintavaHits).toEqual([]);
  });

  it('F1 earnings: a second failure rests and never loops; past the 72 hours a person looks and nothing more is sent', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, item(creator, 100_000));
    const opAfterSale = operational();
    book.createRequests.length = 0;

    failWaits = 2;
    await pass();
    const move = await moveOf(creator);
    const ref3 = moveReference(creator.id, move.dayKey, 3);
    const t1 = later(10 * 60_000);
    await earnings.sweep(t1);
    // The new reference failed too: a third reference, resting.
    expect(await moveOf(creator)).toMatchObject({
      attempt: 3,
      customerReference: ref3,
      sentAt: null,
      status: 'owed',
    });
    expect(book.createRequests).toHaveLength(2);
    await earnings.sweep(t1);
    await earnings.sweep(t1);
    expect(book.createRequests).toHaveLength(2);

    // 72 hours after the first refusal (R-55) a person looks: nothing is sent.
    book.mode = 'successful';
    await pass(73 * 60 * 60_000);
    await pass(24 * 60 * 60_000);
    const stopped = await moveOf(creator);
    expect(stopped.status).toBe('owed');
    expect(stopped.reviewSince).not.toBeNull();
    expect((await settlementOrThrow(paid.id)).status).toBe('owed');
    expect(book.createRequests).toHaveLength(2);
    // The money is still in WAWU's account, and every figure agrees.
    expect(operational()).toBe(opAfterSale);
    expect(nuvionBalance(creator)).toBe(0);
    expect(await hubBalance(creator)).toBe(0);
    expect(await ledgerNetOf(creator)).toBe(0);
    expect(await ledgerNetOfWawu()).toBe(operational() - OPERATIONAL_START);
  });

  it('F1 holds: a paid question refund Nuvion accepts and then fails lands once, under a new reference; the Hub, Nuvion and the ledger agree', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const payment = await sale(buyer, item(creator, 100_000), 'paid_dm');
    const hold = await holdOf(payment.id);
    const base = `wawu-ref-${hold.id}`;
    const buyerPaid = nuvionBalance(buyer);
    const opAfterPay = operational();
    book.createRequests.length = 0;

    failWaits = 1;
    const first = await holds.refund({ paymentId: payment.id });
    expect(first.state).toBe('waiting');
    expect(statusesOf(base)).toEqual(['failed']);
    expect(await holdOf(payment.id)).toMatchObject({
      status: 'held',
      attempt: 2,
      customerReference: `${base}-2`,
      sentAt: null,
      waiting: 'refused',
    });
    expect(book.createRequests).toHaveLength(1);
    expect(nuvionBalance(buyer)).toBe(buyerPaid);
    expect(operational()).toBe(opAfterPay);
    // The same moment, asked again: it rests, nothing is sent.
    const soon = at(60_000);
    await holds.sweep(soon);
    await holds.sweep(soon);
    expect(book.createRequests).toHaveLength(1);

    book.mode = 'successful';
    await holds.sweep(at(10 * 60_000));
    await holds.sweep(at(10 * 60_000));
    await holds.refund({ paymentId: payment.id });
    expect(await holdOf(payment.id)).toMatchObject({
      status: 'refunded',
      refundedKobo: 100_000n,
    });
    expect(statusesOf(base)).toEqual(['failed']);
    expect(statusesOf(`${base}-2`)).toEqual(['successful']);
    expect(book.createRequests).toHaveLength(2);

    // The price came back once; the Hub, Nuvion and the ledger say one figure.
    expect(nuvionBalance(buyer)).toBe(buyerPaid + 100_000);
    expect(await hubBalance(buyer)).toBe(buyerPaid + 100_000);
    expect(await ledgerNetOf(buyer)).toBe(nuvionBalance(buyer) - 1_000_000);
    expect(operational()).toBe(opAfterPay - 100_000 - bandFee(100_000));
    expect(await ledgerNetOfWawu()).toBe(operational() - OPERATIONAL_START);
    expect(await rowsOf(base)).toHaveLength(0);
    expect(await rowsOf(`${base}-2`)).toHaveLength(2);
    expect(fintavaHits).toEqual([]);
  });

  it('F1 holds: a second failure rests and never loops, and lands under the third reference; nothing pays twice', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const payment = await sale(buyer, item(creator, 100_000), 'paid_dm');
    const hold = await holdOf(payment.id);
    const base = `wawu-ref-${hold.id}`;
    const buyerPaid = nuvionBalance(buyer);
    const opAfterPay = operational();
    book.createRequests.length = 0;

    failWaits = 2;
    await holds.refund({ paymentId: payment.id });
    const t1 = at(10 * 60_000);
    await holds.sweep(t1);
    expect(await holdOf(payment.id)).toMatchObject({
      attempt: 3,
      customerReference: `${base}-3`,
      sentAt: null,
      status: 'held',
    });
    expect(book.createRequests).toHaveLength(2);
    await holds.sweep(t1);
    await holds.sweep(t1);
    expect(book.createRequests).toHaveLength(2);
    expect(nuvionBalance(buyer)).toBe(buyerPaid);
    expect(operational()).toBe(opAfterPay);

    book.mode = 'successful';
    await holds.sweep(at(60 * 60_000));
    await holds.sweep(at(60 * 60_000));
    expect((await holdOf(payment.id)).status).toBe('refunded');
    expect(statusesOf(base)).toEqual(['failed']);
    expect(statusesOf(`${base}-2`)).toEqual(['failed']);
    expect(statusesOf(`${base}-3`)).toEqual(['successful']);
    expect(book.createRequests).toHaveLength(3);
    expect(nuvionBalance(buyer)).toBe(buyerPaid + 100_000);
    expect(await ledgerNetOf(buyer)).toBe(nuvionBalance(buyer) - 1_000_000);
    expect(await ledgerNetOfWawu()).toBe(operational() - OPERATIONAL_START);
  });

  it('F1 holds: a move that keeps failing goes to a person after the review bound and sends nothing more', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const payment = await sale(buyer, item(creator, 100_000), 'paid_dm');
    const hold = await holdOf(payment.id);
    const buyerPaid = nuvionBalance(buyer);
    const opAfterPay = operational();
    book.createRequests.length = 0;

    failWaits = 3;
    await holds.refund({ paymentId: payment.id });
    await holds.sweep(at(10 * 60_000));
    // The third failure comes after the review bound: a person looks.
    await holds.sweep(at(73 * 60 * 60_000));
    const stopped = await holdOf(payment.id);
    expect(stopped.status).toBe('held');
    expect(stopped.reviewSince).not.toBeNull();
    expect(stopped.discrepancy).toMatch(/failed/);
    expect(book.createRequests).toHaveLength(3);
    book.mode = 'successful';
    await holds.sweep(at(96 * 60 * 60_000));
    await holds.sweep(at(120 * 60 * 60_000));
    expect(book.createRequests).toHaveLength(3);
    expect(statusesOf(`wawu-ref-${hold.id}-3`)).toEqual(['failed']);
    expect(nuvionBalance(buyer)).toBe(buyerPaid);
    expect(operational()).toBe(opAfterPay);
    expect(await ledgerNetOf(buyer)).toBe(nuvionBalance(buyer) - 1_000_000);
    expect(await ledgerNetOfWawu()).toBe(operational() - OPERATIONAL_START);
  });
});
