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
import { MoneyError } from '../../money/money-error';
import { MoneyModule } from '../../money/money.module';
import type {
  EarningsView,
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
import { signNuvionDelivery } from '../webhook/nuvion-signature';
import { NuvionWebhookDispatcher } from '../webhook/nuvion-webhook-dispatcher.service';
import { NuvionWebhookModule } from '../webhook/nuvion-webhook.module';

/**
 * A sale's 85% lands in the payee's wallet by itself (task WALLET-16, R-11)
 * over NUV-05's book transfers: the real MoneyModule, the real Nuvion adapter
 * and client with its book area, Nuvion's stand-in over a socket
 * (test/nuvion/book-standin.ts), Nuvion's signed deliveries posted to the
 * real receiver and handed to the real handler, a real database, real RS256
 * tokens. Nothing here reaches a Nuvion, Fintava or wawuafrica.com host.
 */

jest.setTimeout(120_000);

const RUN = `w16-${randomUUID().slice(0, 8)}`;
const SECRET = 'whsec_w16_book_0123456789abcdef';
const PIN = '5937';
const BASE = '/api/hub/money';
const HOOK = '/api/hub/webhooks/nuvion';
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

describe('WALLET-16 end to end: a sale lands in the payee’s wallet over Nuvion book transfers', () => {
  const standin = new NuvionStandin();
  const wawuId = new WawuIdDouble();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let earnings: EarningSettlementService;
  let dispatcher: NuvionWebhookDispatcher;
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
  async function sale(buyer: Person, targetId: string): Promise<PaymentView> {
    const prior = book.mode;
    book.mode = 'successful';
    const qres = await request(app.getHttpServer())
      .get(`${BASE}/payments/quote?kind=content_unlock&targetId=${targetId}`)
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
  const earningsOf = (p: Person) =>
    request(app.getHttpServer())
      .get(`${BASE}/earnings`)
      .set('Authorization', p.auth);
  const pass = (ms?: number) => earnings.sweep(later(ms));
  const rowsOf = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });

  let evt = 0;
  async function deliverAndDispatch(
    event: string,
    data: unknown,
  ): Promise<void> {
    evt += 1;
    const id = `${RUN}-${evt}-${randomBytes(4).toString('hex')}`;
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
    const r = await prisma.nuvionWebhookEvent.findUniqueOrThrow({
      where: { eventId: id },
    });
    await prisma.nuvionWebhookEvent.update({
      where: { id: r.id },
      data: { nextAttemptAt: null },
    });
    await dispatcher.dispatch(r.id);
  }

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
    earnings = moduleRef.get(EarningSettlementService);
    dispatcher = moduleRef.get(NuvionWebhookDispatcher);

    const registry = moduleRef.get(PayableRegistry);
    registry.register({
      kind: 'content_unlock',
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
  });

  it('check 1: three sales land as one book transfer of the 85% shares, once, and the creator is shown exactly their sum', async () => {
    const creator = await person(0, false);
    const buyer = await person(2_000_000);
    const prices = [200_001, 99_999, 12_345];
    const pays: PaymentView[] = [];
    for (const price of prices) {
      pays.push(await sale(buyer, item(creator, price)));
    }
    const expected = prices.reduce((sum, p) => sum + shareOf(p), 0);
    const opBefore = book.availableOf(book.operational.id);
    book.createRequests.length = 0;

    // R-55: one book transfer for the creator's day, of the three shares.
    // Nuvion takes it and answers `pending`.
    await pass();
    expect(book.createRequests).toHaveLength(1);
    const move = await moveOf(creator);
    const ref = move.customerReference;
    expect(ref).toBe(moveReference(creator.id, move.dayKey, 1));
    expect(book.createRequests[0]).toMatchObject({
      account_id: book.operational.id,
      amount: expected,
      payment_type: 'book-transfer',
      nuvion_ban: creator.account!.nuvion_ban,
      unique_reference: ref,
    });
    for (const p of pays) {
      const e = await settlementOrThrow(p.id);
      expect(e.status).toBe('owed');
      expect(e.moveId).toBe(move.id);
    }
    expect(book.availableOf(creator.account!.id)).toBe(0);
    // A replay while Nuvion still has it pending sends nothing.
    await pass(10 * 60_000);
    expect(book.createRequests).toHaveLength(1);

    // Nuvion finishes it and says so (by its signed delivery).
    const done = book.settle(ref, 'successful');
    await deliverAndDispatch('outflows.completed', done);
    await pass(10 * 60_000);

    expect(book.availableOf(creator.account!.id)).toBe(expected);
    // WAWU's account paid the shares and Nuvion's charge, once.
    expect(opBefore - book.availableOf(book.operational.id)).toBe(
      expected + bandFee(expected),
    );
    expect(book.byReference(ref)).toHaveLength(1);
    const landed = await moveOf(creator);
    expect(landed.status).toBe('landed');
    expect(landed.providerFeeKobo).toBe(BigInt(bandFee(expected)));
    for (const p of pays) {
      expect((await settlementOrThrow(p.id)).status).toBe('landed');
    }
    const rows = await rowsOf(ref);
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.status).toBe('completed');
      expect(r.category).toBe('earning');
      expect(r.provider).toBe('nuvion');
    }
    const view = body<EarningsView>(await earningsOf(creator)).data!;
    expect(view.allTime.earnedKobo).toBe(expected);
    expect(view.waiting).toEqual({ count: 0, amountKobo: 0 });
    expect(book.createRequests).toHaveLength(1);
    expect(fintavaHits).toEqual([]);
  });

  it('check 2: a creator with no wallet keeps earning; the share lands once, the minute the wallet opens', async () => {
    const creator = mint();
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, item(creator, 250_000));
    book.createRequests.length = 0;
    await pass();
    expect((await settlementOrThrow(paid.id)).waiting).toBe('payee_wallet');
    expect(book.createRequests).toHaveLength(0);
    expect(body<EarningsView>(await earningsOf(creator)).data!.waiting).toEqual(
      { count: 1, amountKobo: shareOf(250_000) },
    );
    for (let i = 0; i < 3; i += 1) await pass(30 * 60_000);
    expect(book.createRequests).toHaveLength(0);

    await openFor(creator, 0);
    book.mode = 'successful';
    await earnings.sweep(new Date(Date.now() + 1_000));
    const ref = (await moveOf(creator)).customerReference;
    expect(book.byReference(ref)).toHaveLength(1);
    expect(book.availableOf(creator.account!.id)).toBe(shareOf(250_000));
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
    for (let i = 0; i < 3; i += 1) await pass();
    expect(book.byReference(ref)).toHaveLength(1);
    expect(book.availableOf(creator.account!.id)).toBe(shareOf(250_000));
    expect(await rowsOf(ref)).toHaveLength(2);
  });

  it('a book transfer asked for twice at once, and by two services, is one transfer', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const paid = await sale(buyer, item(creator, 120_000));
    const other = new EarningSettlementService(
      prisma,
      // the same provider the module uses
      (earnings as unknown as { provider: never }).provider,
      (earnings as unknown as { ledger: never }).ledger,
      (earnings as unknown as { fees: never }).fees,
      (earnings as unknown as { settings: never }).settings,
    );
    book.mode = 'successful';
    const now = later();
    await Promise.all([earnings.sweep(now), other.sweep(now)]);
    const row = await settlementOrThrow(paid.id);
    const ref = (await moveOf(creator)).customerReference;
    await Promise.all([
      earnings.drive(row.id, later()),
      other.drive(row.id, later()),
    ]);
    expect(book.byReference(ref)).toHaveLength(1);
    expect(book.availableOf(creator.account!.id)).toBe(shareOf(120_000));
    expect((await settlementOrThrow(paid.id)).status).toBe('landed');
  });

  it('a transfer Nuvion fails is tried again under a new reference, once; Nuvion reversing a completed one is a stop for a person', async () => {
    const creator = await person(0, false);
    const buyer = await person(1_000_000);
    const failed = await sale(buyer, item(creator, 100_000));
    await pass();
    const move = await moveOf(creator);
    const first = move.customerReference;
    expect(book.byReference(first)).toHaveLength(1);
    book.settle(first, 'failed');
    await pass(10 * 60_000);
    const retry = await moveOf(creator);
    expect(retry.attempt).toBe(2);
    expect(retry.customerReference).toBe(
      moveReference(creator.id, retry.dayKey, 2),
    );
    book.mode = 'successful';
    await pass(2 * 60 * 60_000);
    expect((await settlementOrThrow(failed.id)).status).toBe('landed');
    expect(
      book.byReference(moveReference(creator.id, retry.dayKey, 2)),
    ).toHaveLength(1);
    expect(book.availableOf(creator.account!.id)).toBe(85_000);

    // Another creator: a creator has one transfer a day, and this one is theirs.
    book.mode = 'pending';
    const other = await person(0, false);
    const reversed = await sale(buyer, item(other, 100_000));
    await pass();
    const reversedMove = await moveOf(other);
    const ref = reversedMove.customerReference;
    book.settle(ref, 'successful');
    book.settle(ref, 'reversed');
    await pass(10 * 60_000);
    const row = await moveOf(other);
    expect(row.reviewSince).not.toBeNull();
    expect((await settlementOrThrow(reversed.id)).status).toBe('owed');
    await pass(2 * 60 * 60_000);
    expect(book.byReference(ref)).toHaveLength(1);
    expect(
      book.byReference(moveReference(other.id, reversedMove.dayKey, 2)),
    ).toHaveLength(0);
  });
});
