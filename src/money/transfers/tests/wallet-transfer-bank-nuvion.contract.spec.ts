import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  NuvionAccountsStandin,
  type StandinAccount,
  standinId,
} from '../../../../test/nuvion/accounts-standin';
import { NuvionBookStandin } from '../../../../test/nuvion/book-standin';
import {
  NuvionStandin,
  type StandinAnswer,
  type StandinRequest,
} from '../../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../../test/nuvion/outbound-guard';
import { NuvionPayoutsStandin } from '../../../../test/nuvion/payouts-standin';
import { WawuIdDouble } from '../../../../test/nuvion/wawu-id-double';
import {
  body,
  mintToken,
  PIN,
  QuietLogger,
} from '../../../../test/transfers/harness';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { nuvionWalletId } from '../../../nuvion/areas/accounts';
import { NuvionBookArea } from '../../../nuvion/areas/book';
import { NuvionBookHandler } from '../../../nuvion/handlers/book.handler';
import { PrismaNuvionBookStore } from '../../../nuvion/areas/book-store';
import { NuvionPayoutsHandler } from '../../../nuvion/handlers/payouts.handler';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import {
  LedgerService,
  LEDGER_BANK_SEND_FAILURE,
} from '../../ledger/ledger.service';
import { MoneyModule } from '../../money.module';
import type {
  AccountNameView,
  FeeQuoteView,
  TransferView,
} from '../../money-view.type';
import {
  BANK_SEND_RETURNED_REASON,
  feeBackReference,
  SEND_STILL_CONFIRMING_MESSAGE,
  WalletTransferService,
} from '../wallet-transfer.service';

/**
 * A bank send on Nuvion shows its true outcome (FIX-54).
 *
 * Found by WA's check: the Hub marked a bank send `completed` about 49 ms after
 * the request, on Nuvion's ACCEPTANCE, while the transfer was still pending at
 * Nuvion. When Nuvion then failed it (and gave the money back) the Hub dropped
 * the `outflows.failed` delivery ("a sighting disagreed ... stored figures
 * kept"), so the receipt said Completed; after `outflows.refunded` the history
 * said Reversed but `GET /money/transfers/{id}` stayed completed.
 *
 * Here the REAL Nuvion adapter (payouts and book areas), the real money layer
 * and the real ledger run over Nuvion's stand-in on a socket: one stand-in
 * server answers both a book transfer (WAWU's fee, FIX-52) and a NIP bank send
 * (composed below, the two doubles share it). Deliveries are handed to the
 * real NUV-06 handler. Nothing reaches a Nuvion, Fintava or wawuafrica.com
 * host (every connection but loopback is refused).
 */

const BASE = '/api/hub/money';
const FEE = 150;
const WAWU_FEE = 2500;
const AMOUNT = 200_000;
const OPERATIONAL_START = 5_000_000;
const PERSON_START = 2_000_000;
const BANK = '044';
const HOLDER = 'Chidinma Okafor';

jest.setTimeout(120_000);

type Answer = (req: StandinRequest) => StandinAnswer;

/**
 * One server for the book transfer double and the payouts double: both answer
 * `POST /transfers`, `GET /transfers` and `GET /transfers/{id}`, and the real
 * Nuvion does both on the same routes. A write goes to the double of its
 * `payment_type`; a read asks each in turn; the lists are put together.
 */
class ComposedStandin extends NuvionStandin {
  layer = 'base';
  private readonly stacks = new Map<
    string,
    Array<{ layer: string; handler: Answer }>
  >();

  override on(
    method: string,
    path: string | RegExp,
    answer: StandinAnswer | Answer,
  ): this {
    const handler: Answer =
      typeof answer === 'function' ? answer : () => answer;
    const key = `${method} ${String(path)}`;
    const stack = this.stacks.get(key) ?? [];
    stack.push({ layer: this.layer, handler });
    this.stacks.set(key, stack);
    return super.on(method, path, (req) => this.answerFrom(key, req));
  }

  private answerFrom(key: string, req: StandinRequest): StandinAnswer {
    const stack = this.stacks.get(key) ?? [];
    const latestFirst = [...stack].reverse();
    if (key === 'POST /transfers') {
      const want =
        (req.body as { payment_type?: string } | undefined)?.payment_type ===
        'book-transfer'
          ? 'book'
          : 'pay';
      return (
        latestFirst.find((l) => l.layer === want) ?? latestFirst[0]
      ).handler(req);
    }
    if (key === 'GET /transfers') {
      const answers = latestFirst
        .filter((l) => l.layer === 'book' || l.layer === 'pay')
        .map((l) => l.handler(req));
      const pages = answers.map(
        (a) =>
          (
            a.body as {
              data: { data: Array<{ created: number }>; meta: object };
            }
          ).data,
      );
      const rows = pages
        .flatMap((p) => p.data)
        .sort((a, b) => Number(b.created) - Number(a.created));
      return {
        status: 200,
        body: {
          status: 'success',
          message: 'Transfers retrieved successfully',
          data: {
            data: rows,
            meta: {
              pagination: {
                order: 'desc',
                has_next: false,
                limit: 100,
                has_previous: false,
                next_cursor: null,
                previous_cursor: null,
              },
            },
          },
        },
      };
    }
    let last: StandinAnswer = { status: 404 };
    for (const l of latestFirst) {
      last = l.handler(req);
      if (last.status !== 404) return last;
    }
    return last;
  }
}

let numberSeq = 0;
const nuban = () =>
  `6${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

describe('A bank send on Nuvion shows its true outcome (FIX-54)', () => {
  const standin = new ComposedStandin();
  const wawuId = new WawuIdDouble();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const pay = new NuvionPayoutsStandin(standin, accounts, standinId('01OPS'));
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let transfers: WalletTransferService;
  let moduleRef: TestingModule;
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

  interface Person {
    id: string;
    auth: string;
    account: StandinAccount;
    accountNumber: string;
  }

  async function person(kobo: number): Promise<Person> {
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
        accountName: `Nuvion Sender ${accountNumber}`,
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
    await prisma.userProfile.create({
      data: {
        wawuUserId: id,
        accountType: 'user',
        handle: `f54-${id.slice(0, 8)}`,
      },
    });
    const auth = `Bearer ${mintToken(id)}`;
    const set = await request(app.getHttpServer())
      .post(`${BASE}/pin`)
      .set('Authorization', auth)
      .send({ pin: PIN, pinConfirmation: PIN });
    expect(set.status).toBe(201);
    return { id, auth, account, accountNumber };
  }

  /** The quote and the name check the person saw, as the app sends them. */
  async function prepare(p: Person, number: string, amountKobo = AMOUNT) {
    const quote = await request(app.getHttpServer())
      .get(`${BASE}/fees/quote?kind=bank_transfer&amountKobo=${amountKobo}`)
      .set('Authorization', p.auth);
    expect(quote.status).toBe(200);
    const q = body<FeeQuoteView>(quote).data!;
    const checked = await request(app.getHttpServer())
      .post(`${BASE}/banks/name-check`)
      .set('Authorization', p.auth)
      .send({ bankCode: BANK, accountNumber: number });
    expect(checked.status).toBe(200);
    return {
      bankCode: BANK,
      accountNumber: number,
      amountKobo,
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
      nameToken: body<AccountNameView>(checked).data!.nameToken,
      quotedTotal: q.totalKobo,
    };
  }

  async function post(p: Person, payload: object, key: string = randomUUID()) {
    const wire = Object.fromEntries(
      Object.entries(payload).filter(([k]) => k !== 'quotedTotal'),
    );
    return request(app.getHttpServer())
      .post(`${BASE}/transfers/bank`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send(wire);
  }

  /** A bank send from a fresh person: the view, and what is needed to follow it. */
  async function send(amountKobo = AMOUNT) {
    const me = await person(PERSON_START);
    const number =
      `07${String(Date.now()).slice(-7)}${String((numberSeq += 1)).padStart(1, '0')}`.slice(
        0,
        10,
      );
    pay.addAccountAtBank(BANK, number, HOLDER);
    const b = await prepare(me, number, amountKobo);
    const res = await post(me, b);
    expect(res.status).toBe(201);
    const view = body<TransferView>(res).data!;
    const nuvion = pay.byReference(view.reference);
    return { me, b, view, nuvion: nuvion[0], count: nuvion.length };
  }

  const available = (p: Person) => book.availableOf(p.account.id);
  const operational = () => book.availableOf(book.operational.id);
  const feeLegs = (reference: string) => book.byReference(`${reference}-fee`);
  const feeBacks = (reference: string) =>
    book.byReference(`${reference}-fee-back`);
  const ledgerNet = async (p: Person) => {
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: { wawuUserId: p.id, status: 'completed' },
      select: { direction: true, totalKobo: true },
    });
    return rows.reduce(
      (n, r) => n + (r.direction === 'in' ? 1 : -1) * Number(r.totalKobo),
      0,
    );
  };
  /**
   * What the sender's ledger counts as moved (FIX-70 round 3): a completed row
   * at its total, a reversed row at what is left of it once what came back is
   * taken off (a reversed debit with no figures yet counts whole).
   */
  const senderNet = async (p: Person) => {
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: { wawuUserId: p.id, status: { in: ['completed', 'reversed'] } },
      select: {
        direction: true,
        status: true,
        totalKobo: true,
        reversalTotalKobo: true,
      },
    });
    return rows.reduce((n, r) => {
      const left =
        r.status === 'reversed'
          ? Number(r.totalKobo) - Number(r.reversalTotalKobo ?? 0)
          : Number(r.totalKobo);
      return n + (r.direction === 'in' ? 1 : -1) * left;
    }, 0);
  };
  const deliver = (event: string, data: unknown, p: Person) =>
    new NuvionPayoutsHandler(prisma, moduleRef.get(ModuleRef)).handle({
      id: randomUUID(),
      eventId: randomUUID(),
      event,
      resourceId: (data as { id: string }).id,
      entityId: p.account.entity_id,
      data,
      receivedAt: new Date(),
      attempts: 1,
    });
  const waitFor = async (
    check: () => boolean | Promise<boolean>,
    ms = 8000,
  ) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  };
  const rowOf = (id: string) =>
    prisma.walletTransfer.findUniqueOrThrow({ where: { id } });
  const ledgerOut = (reference: string) =>
    prisma.fintavaLedgerEntry.findFirstOrThrow({
      where: { customerReference: reference, direction: 'out' },
    });
  const reversalTotal = async (reference: string, kobo: number) =>
    Number((await ledgerOut(reference)).reversalTotalKobo ?? 0) === kobo;
  const read = async (p: Person, id: string) =>
    body<TransferView>(
      await request(app.getHttpServer())
        .get(`${BASE}/transfers/${id}`)
        .set('Authorization', p.auth),
    ).data!;

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
    standin.layer = 'accounts';
    accounts.install();
    standin.layer = 'book';
    book.install();
    book.fundOperational(OPERATIONAL_START);
    standin.layer = 'pay';
    pay.install();
    pay.fee = FEE;
    // Nuvion's own charge on every transfer, and nothing of WAWU's in it.
    book.feeKobo = () => FEE;
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_f54_bank_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'f54-bank-fee-quote-key-0123456789abcdef01',
      NUVION_FEE_BOOK_TRANSFER: String(FEE),
      NUVION_FEE_BANK_PAYOUT: String(FEE),
      NUVION_FEE_INFLOW: String(FEE),
      WAWU_FEE_BANK_TRANSFER_KOBO: String(WAWU_FEE),
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
        moneyTimeoutMs: 500,
        readTimeoutMs: 2_000,
      }),
      'nv_test_sk_F54bankKEY000000000000000000',
    );
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
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
    transfers = moduleRef.get(WalletTransferService);
  });

  afterAll(async () => {
    if (prisma) {
      const rows = await prisma.walletTransfer.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { customerReference: true },
      });
      const refs = rows.flatMap((r) => [
        r.customerReference,
        `${r.customerReference}-fee`,
        `${r.customerReference}-fee-back`,
      ]);
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: refs } },
            { wawuUserId: { in: users } },
          ],
        },
      });
      await prisma.walletTransfer.deleteMany({
        where: { payerWawuUserId: { in: users } },
      });
      await prisma.nuvionBookTransfer.deleteMany({
        where: { reference: { in: refs } },
      });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.userProfile.deleteMany({
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
    // WAWU's fee transfer finishes inside the request; the bank send itself is
    // pending at Nuvion until a test settles it ("all transfers are asynchronous").
    book.mode = 'successful';
  });

  afterEach(() => {
    expect(fintavaHits).toEqual([]);
    expect(guard.violations).toEqual([]);
  });

  it('is pending until Nuvion says completed; the money has left, the fee is moved once, and nothing the Hub does on its own finishes it', async () => {
    const opBefore = operational();
    const { me, b, view, nuvion, count } = await send();
    expect(count).toBe(1);
    expect(nuvion.status).toBe('pending');
    // The answer is not "completed": the bank has not said so.
    expect(view.status).toBe('pending');
    expect(view.statusMessage).toBe(SEND_STILL_CONFIRMING_MESSAGE);
    expect(view.timeline.map((t) => t.step)).toEqual([
      'requested',
      'sent_to_bank',
    ]);
    // The person is debited exactly the quote; WAWU's fee moved first, once.
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
    expect(await rowOf(view.id)).toMatchObject({
      status: 'pending',
      completedAt: null,
    });
    expect((await ledgerOut(view.reference)).status).toBe('pending');
    expect((await read(me, view.id)).status).toBe('pending');

    // The sweep reads the transfer: still pending at Nuvion, still pending here.
    await transfers.sweep(later());
    await transfers.settle(view.id, later(), true);
    expect((await rowOf(view.id)).status).toBe('pending');
    expect((await read(me, view.id)).status).toBe('pending');

    // Nuvion completes it; its delivery settles the send.
    pay.settle(nuvion.id, 'successful');
    const done = await deliver(
      'outflows.completed',
      pay.delivery(nuvion.id),
      me,
    );
    expect(done.outcome).toBe('done');
    expect(
      await waitFor(async () => (await rowOf(view.id)).status === 'completed'),
    ).toBe(true);
    const final = await read(me, view.id);
    expect(final.status).toBe('completed');
    expect(final.timeline.map((t) => t.step)).toEqual([
      'requested',
      'sent_to_bank',
      'completed',
    ]);
    const out = await ledgerOut(view.reference);
    expect(out.status).toBe('completed');
    expect(Number(out.totalKobo)).toBe(b.quotedTotal);
    expect(await ledgerNet(me)).toBe(-(PERSON_START - available(me)));

    // A replay, the sweep and a second settle change nothing.
    await deliver('outflows.completed', pay.delivery(nuvion.id), me);
    await transfers.sweep(later());
    await transfers.settle(view.id, later(), true);
    await transfers.settle(view.id, later(), false);
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(feeBacks(view.reference)).toHaveLength(0);
    expect(pay.byReference(view.reference)).toHaveLength(1);
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect((await rowOf(view.id)).status).toBe('completed');
  });

  it("a send Nuvion fails after it accepted it is failed, with the money and WAWU's fee back, once however often it is told", async () => {
    const opBefore = operational();
    const { me, view, nuvion } = await send();
    expect(view.status).toBe('pending');
    expect(available(me)).toBeLessThan(PERSON_START);

    // The stand-in fails it at once and gives the money back (as Nuvion does).
    pay.settle(nuvion.id, 'failed', 'invalid_account_details');
    const told = await deliver('outflows.failed', pay.delivery(nuvion.id), me);
    expect(told.outcome).toBe('done');
    expect(
      await waitFor(async () => (await rowOf(view.id)).status === 'failed'),
    ).toBe(true);
    expect(await waitFor(() => feeBacks(view.reference).length === 1)).toBe(
      true,
    );

    const failed = await read(me, view.id);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe(BANK_SEND_RETURNED_REASON);
    expect(failed.statusMessage).toBeNull();
    expect(failed.timeline.map((t) => t.step)).toEqual(['requested', 'failed']);
    // The ledger is the provider: failed, and the person is whole again.
    expect((await ledgerOut(view.reference)).status).toBe('failed');
    // The sender's owed-fee row turns reversed a moment after the fee-back
    // exists at Nuvion (FIX-70 round 3): wait for it, then assert as before.
    await waitFor(async () => (await ledgerNet(me)) === 0);
    expect(await ledgerNet(me)).toBe(0);
    expect(available(me)).toBe(PERSON_START);
    // Nuvion's charge on WAWU's fee transfer and on giving it back is WAWU's
    // (FIX-52), nothing is the person's.
    expect(operational() - opBefore).toBe(-2 * FEE);

    // Told again, swept, settled again, and a late "completed" from an old
    // delivery: nothing moves twice.
    await deliver('outflows.failed', pay.delivery(nuvion.id), me);
    await deliver('outflows.completed', pay.delivery(nuvion.id), me);
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.settle(view.id, later(), true);
    const row = await rowOf(view.id);
    expect(row.status).toBe('failed');
    expect(row.reviewSince).toBeNull();
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(feeBacks(view.reference)).toHaveLength(1);
    expect(available(me)).toBe(PERSON_START);
    expect((await ledgerOut(view.reference)).status).toBe('failed');
  });

  it("a completed send Nuvion refunds is reversed, GET shows the reversal, WAWU's fee comes back, and a replay changes nothing", async () => {
    const { me, b, view, nuvion } = await send();
    pay.settle(nuvion.id, 'successful');
    await deliver('outflows.completed', pay.delivery(nuvion.id), me);
    expect(
      await waitFor(async () => (await rowOf(view.id)).status === 'completed'),
    ).toBe(true);

    // The refund is the credit record of the money coming back (the docs'
    // shape: type inflow, the send named in meta.source_payment_id), for the
    // whole of what the wallet got back.
    const { credit } = pay.reverse(nuvion.id);
    const refund = {
      ...pay.delivery(credit.id),
      amount: b.quotedTotal - WAWU_FEE,
    };
    const told = await deliver('outflows.refunded', refund, me);
    expect(told.outcome).toBe('done');
    expect(
      await waitFor(async () => (await rowOf(view.id)).status === 'reversed'),
    ).toBe(true);
    expect(await waitFor(() => feeBacks(view.reference).length === 1)).toBe(
      true,
    );

    // The fee-back is counted once it has been made and noted (round 2).
    expect(
      await waitFor(() => reversalTotal(view.reference, b.quotedTotal)),
    ).toBe(true);

    const reversed = await read(me, view.id);
    expect(reversed.status).toBe('reversed');
    expect(reversed.timeline.map((t) => t.step)).toEqual([
      'requested',
      'completed',
      'reversed',
    ]);
    // All of it came back, Nuvion's credit and WAWU's fee: nothing is kept.
    expect(reversed.reversal).toMatchObject({
      returnedKobo: b.quotedTotal,
      keptKobo: 0,
    });
    const out = await ledgerOut(view.reference);
    expect(out.status).toBe('reversed');
    expect(Number(out.reversalTotalKobo)).toBe(b.quotedTotal);
    // The whole of it is back: Nuvion's credit and WAWU's fee.
    expect(available(me)).toBe(PERSON_START);

    // Replays change nothing: the refund again, the sweep, the old "completed".
    await deliver('outflows.refunded', refund, me);
    await deliver('outflows.completed', pay.delivery(nuvion.id), me);
    await transfers.sweep(later());
    await transfers.settle(view.id, later(), true);
    await transfers.settle(view.id, later(), false);
    expect((await rowOf(view.id)).status).toBe('reversed');
    expect(feeBacks(view.reference)).toHaveLength(1);
    expect(available(me)).toBe(PERSON_START);
    const again = await read(me, view.id);
    expect(again.reversal).toEqual(reversed.reversal);
  });

  for (const heardCompleted of [true, false]) {
    it(`a send Nuvion reverses (${
      heardCompleted
        ? 'completed first'
        : 'before the Hub heard of the completion'
    }) whose fee-back Nuvion fails twice: the sender's ledger equals Nuvion at every step, the fee counted once (FIX-70 round 3)`, async () => {
      const { me, b, view, nuvion } = await send();
      // The sender's ledger = Nuvion for the sender, once the ledger writes
      // that follow a step have landed (polled with a bound, then asserted).
      const senderEqualsNuvion = async () => {
        await waitFor(
          async () => (await senderNet(me)) === available(me) - PERSON_START,
          3000,
        );
        expect(await senderNet(me)).toBe(available(me) - PERSON_START);
      };
      pay.settle(nuvion.id, 'successful');
      if (heardCompleted) {
        await deliver('outflows.completed', pay.delivery(nuvion.id), me);
        expect(
          await waitFor(
            async () => (await rowOf(view.id)).status === 'completed',
          ),
        ).toBe(true);
        await senderEqualsNuvion();
      }
      // From here every fee-back stays pending at Nuvion until the test fails it.
      book.mode = 'pending';
      const { credit } = pay.reverse(nuvion.id);
      const refund = {
        ...pay.delivery(credit.id),
        amount: b.quotedTotal - WAWU_FEE,
      };
      expect((await deliver('outflows.refunded', refund, me)).outcome).toBe(
        'done',
      );
      expect(
        await waitFor(async () => (await rowOf(view.id)).status === 'reversed'),
      ).toBe(true);
      const first = feeBackReference(view.reference, 1);
      const second = feeBackReference(view.reference, 2);
      expect(await waitFor(() => book.byReference(first).length === 1)).toBe(
        true,
      );
      // The credit is back and WAWU's fee is not: the fee is owed, once.
      expect(available(me)).toBe(PERSON_START - WAWU_FEE);
      await senderEqualsNuvion();

      // Nuvion fails the first fee-back; a later pass makes the one new try.
      book.settle(first, 'failed');
      await transfers.sweep(later());
      await senderEqualsNuvion();
      await transfers.sweep(later());
      expect(book.byReference(second)).toHaveLength(1);
      await senderEqualsNuvion();

      // It fails too: nothing more is sent, and the fee is still owed, once.
      book.settle(second, 'failed');
      for (let i = 0; i < 3; i += 1) {
        await transfers.sweep(later(35 * 60_000));
        await senderEqualsNuvion();
      }
      expect(feeBacks(view.reference)).toHaveLength(1);
      expect(book.byReference(second)).toHaveLength(1);
      expect(book.byReference(`${view.reference}-fee-back-3`)).toEqual([]);
      expect((await rowOf(view.id)).status).toBe('reversed');
      expect(available(me)).toBe(PERSON_START - WAWU_FEE);
      expect(await senderNet(me)).toBe(-WAWU_FEE);
    });
  }

  /**
   * A send the Hub holds as failed whose record at Nuvion then turns reversed
   * (G-FIX-70-6, FIX-85): the failure gave the whole total back, so the stand-in
   * moves as Nuvion would. The send went out after all (the total leaves
   * again) and the bank returned `creditKobo` of it. The stand-in's `reverse`
   * moves the total back on top of the failure's, so the balance is set to
   * what that sequence leaves. Returns the refund as the webhook delivers it.
   */
  const reverseAfterFailure = (p: Person, id: string, creditKobo: number) => {
    const t = pay.transfer(id);
    const total = Number(t.amount) + Number(t.applicable_fee);
    const { credit } = pay.reverse(id);
    const account = accounts.accounts.get(p.account.id)!;
    account.balance.available =
      Number(account.balance.available) - 2 * total + creditKobo;
    return { ...pay.delivery(credit.id), amount: creditKobo };
  };

  /**
   * The sender's ledger = Nuvion for the sender, once the ledger writes that
   * follow a step have landed (polled with a bound, then asserted).
   */
  const ledgerEqualsNuvion = async (p: Person) => {
    await waitFor(
      async () => (await senderNet(p)) === available(p) - PERSON_START,
      3000,
    );
    expect(await senderNet(p)).toBe(available(p) - PERSON_START);
  };

  const credits = [
    { name: 'the principal only', kobo: AMOUNT, kept: FEE },
    { name: 'the whole of what Nuvion held', kobo: AMOUNT + FEE, kept: 0 },
  ];

  for (const credited of credits) {
    for (const feeBack of ['lands', 'fails twice'] as const) {
      it(`a send the Hub failed that Nuvion then refunds (${credited.name}), the fee-back ${feeBack}: the sender's ledger equals Nuvion at every step, the fee given back at most once (FIX-85)`, async () => {
        const opBefore = operational();
        const { me, view, nuvion } = await send();
        const sameAsNuvion = () => ledgerEqualsNuvion(me);
        // Every fee-back stays pending at Nuvion until the test settles it.
        book.mode = 'pending';
        pay.settle(nuvion.id, 'failed');
        expect(
          (await deliver('outflows.failed', pay.delivery(nuvion.id), me))
            .outcome,
        ).toBe('done');
        expect(
          await waitFor(async () => (await rowOf(view.id)).status === 'failed'),
        ).toBe(true);
        const first = feeBackReference(view.reference, 1);
        const second = feeBackReference(view.reference, 2);
        expect(await waitFor(() => book.byReference(first).length === 1)).toBe(
          true,
        );
        // Failed: the money is back and WAWU's fee is owed, once.
        expect(available(me)).toBe(PERSON_START - WAWU_FEE);
        await sameAsNuvion();

        // Nuvion's record of the failed send turns reversed.
        const refund = reverseAfterFailure(me, nuvion.id, credited.kobo);
        expect((await deliver('outflows.refunded', refund, me)).outcome).toBe(
          'done',
        );
        expect(
          await waitFor(
            async () => (await rowOf(view.id)).status === 'reversed',
          ),
        ).toBe(true);
        const owed = WAWU_FEE + credited.kept;
        expect(available(me)).toBe(PERSON_START - owed);
        await sameAsNuvion();

        if (feeBack === 'lands') {
          book.settle(first, 'successful');
          await transfers.sweep(later());
          expect(
            await waitFor(
              async () =>
                (await senderNet(me)) === available(me) - PERSON_START &&
                available(me) === PERSON_START - credited.kept,
            ),
          ).toBe(true);
          await sameAsNuvion();
          // Every naira is back but what Nuvion kept; WAWU paid its charges.
          expect(available(me)).toBe(PERSON_START - credited.kept);
          expect(operational() - opBefore).toBe(-2 * FEE);
        } else {
          // Nuvion fails the first fee-back; a later pass makes the one new try.
          book.settle(first, 'failed');
          await transfers.sweep(later());
          await sameAsNuvion();
          await transfers.sweep(later());
          expect(book.byReference(second)).toHaveLength(1);
          await sameAsNuvion();
          // It fails too: nothing more is sent, the fee is still owed, once.
          book.settle(second, 'failed');
          for (let i = 0; i < 3; i += 1) {
            await transfers.sweep(later(35 * 60_000));
            await sameAsNuvion();
          }
          expect(book.byReference(`${view.reference}-fee-back-3`)).toEqual([]);
          expect(available(me)).toBe(PERSON_START - owed);
          expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
        }
        // Replays and more passes change nothing, and the fee goes back once.
        await deliver('outflows.refunded', refund, me);
        await transfers.sweep(later());
        await transfers.settle(view.id, later(), true);
        expect(feeBacks(view.reference)).toHaveLength(1);
        expect(book.byReference(second)).toHaveLength(
          feeBack === 'lands' ? 0 : 1,
        );
        expect((await rowOf(view.id)).status).toBe('reversed');
        await sameAsNuvion();
      });
    }
  }

  for (const credited of credits) {
    it(`a send the Hub failed whose fee-back already landed, that Nuvion then refunds (${credited.name}): the fee stays given back once and the sender's ledger equals Nuvion (FIX-85)`, async () => {
      const opBefore = operational();
      const { me, view, nuvion } = await send();
      pay.settle(nuvion.id, 'failed');
      expect(
        (await deliver('outflows.failed', pay.delivery(nuvion.id), me)).outcome,
      ).toBe('done');
      expect(
        await waitFor(async () => (await rowOf(view.id)).status === 'failed'),
      ).toBe(true);
      expect(await waitFor(() => feeBacks(view.reference).length === 1)).toBe(
        true,
      );
      expect(await waitFor(async () => (await senderNet(me)) === 0)).toBe(true);
      expect(available(me)).toBe(PERSON_START);

      // Nuvion's record of the failed send turns reversed.
      const refund = reverseAfterFailure(me, nuvion.id, credited.kobo);
      expect((await deliver('outflows.refunded', refund, me)).outcome).toBe(
        'done',
      );
      expect(
        await waitFor(async () => (await rowOf(view.id)).status === 'reversed'),
      ).toBe(true);
      expect(available(me)).toBe(PERSON_START - credited.kept);
      await ledgerEqualsNuvion(me);

      // Replays and more passes change nothing: the fee went back once.
      await deliver('outflows.refunded', refund, me);
      await transfers.sweep(later());
      await transfers.settle(view.id, later(), true);
      expect(feeBacks(view.reference)).toHaveLength(1);
      expect(book.byReference(feeBackReference(view.reference, 2))).toEqual([]);
      expect(operational() - opBefore).toBe(-2 * FEE);
      expect(available(me)).toBe(PERSON_START - credited.kept);
      expect((await rowOf(view.id)).status).toBe('reversed');
      await ledgerEqualsNuvion(me);
    });
  }

  // FIX-98 round 2: the same two FIX-85 sequences, with Nuvion's own deliveries
  // of the fee transfer and of the give-back (both `successful` at Nuvion, as
  // dev shows them) read through the book handler. The fee row is what Nuvion
  // says it is (`completed`) and the give-back is its own row; when the send's
  // reversal came first its row carries the fee and the fee row is paired with
  // Nuvion's `successful` transfer. No row holds a discrepancy, whichever of
  // the send's reversal, the fee-back and the two deliveries came first.
  const bookDeliver = (transfer: Record<string, unknown>, p: Person) =>
    new NuvionBookHandler(prisma, moduleRef.get(ModuleRef)).handle({
      id: randomUUID(),
      eventId: randomUUID(),
      event: 'outflows.completed',
      resourceId: transfer.id as string,
      entityId: p.account.entity_id,
      data: transfer,
      receivedAt: new Date(),
      attempts: 1,
    });
  const feeRowsOf = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: {
        customerReference: {
          in: [
            `${reference}-fee`,
            feeBackReference(reference, 1),
            feeBackReference(reference, 2),
          ],
        },
      },
    });

  for (const credited of credits) {
    for (const order of [
      'fee-back lands, then the send is reversed',
      'the send is reversed, then the fee-back lands',
    ] as const) {
      it(`FIX-98: a send the Hub failed that Nuvion refunds (${credited.name}), ${order}: no row holds a discrepancy after Nuvion's deliveries of the fee transfer and the give-back`, async () => {
        const { me, view, nuvion } = await send();
        if (order.startsWith('the send is reversed')) {
          // Every fee-back stays pending at Nuvion until the send is reversed.
          book.mode = 'pending';
        }
        pay.settle(nuvion.id, 'failed');
        expect(
          (await deliver('outflows.failed', pay.delivery(nuvion.id), me))
            .outcome,
        ).toBe('done');
        expect(
          await waitFor(async () => (await rowOf(view.id)).status === 'failed'),
        ).toBe(true);
        if (order.startsWith('fee-back lands')) {
          expect(
            await waitFor(() => feeBacks(view.reference).length === 1),
          ).toBe(true);
          expect(await waitFor(async () => (await senderNet(me)) === 0)).toBe(
            true,
          );
        }
        const refund = reverseAfterFailure(me, nuvion.id, credited.kobo);
        expect((await deliver('outflows.refunded', refund, me)).outcome).toBe(
          'done',
        );
        expect(
          await waitFor(
            async () => (await rowOf(view.id)).status === 'reversed',
          ),
        ).toBe(true);
        if (order.startsWith('the send is reversed')) {
          // The fee-back lands only now.
          book.mode = 'successful';
          const waiting = feeBacks(view.reference)[0];
          if (waiting) book.settle(waiting.unique_reference, 'successful');
          await transfers.sweep(later());
          await transfers.sweep(later());
          await transfers.settle(view.id, later(), true);
        }
        expect(await waitFor(() => feeBacks(view.reference).length === 1)).toBe(
          true,
        );
        await transfers.sweep(later());
        // Nuvion's deliveries of the fee transfer and of the give-back.
        const feeT = feeLegs(view.reference)[0];
        const backT = feeBacks(view.reference)[0];
        expect(feeT.status).toBe('successful');
        expect(backT.status).toBe('successful');
        expect((await bookDeliver(feeT, me)).outcome).toBe('done');
        expect((await bookDeliver(backT, me)).outcome).toBe('done');
        await transfers.sweep(later());
        const rows = await feeRowsOf(view.reference);
        // The fee row is what Nuvion says its transfer is.
        const fee = rows.find(
          (r) =>
            r.customerReference === `${view.reference}-fee` &&
            r.walletKind === 'user',
        );
        // Fee-back first: the fee row stays what Nuvion says (completed) and
        // the give-back is its own row. Reversal first: the reversed send's
        // row carries the fee (FIX-85), so the fee row is turned reversed and
        // Nuvion's `successful` fee transfer is paired with it, not flagged.
        expect(fee?.status).toBe(
          order.startsWith('fee-back lands') ? 'completed' : 'reversed',
        );
        expect(rows.filter((r) => r.discrepancy !== null)).toEqual([]);
        expect(available(me)).toBe(PERSON_START - credited.kept);
        await ledgerEqualsNuvion(me);
      });
    }
  }

  it('duplicated and reordered deliveries: a refund before the completion reverses the pending send once, and the old completion cannot undo it', async () => {
    const { me, b, view, nuvion } = await send();
    expect(view.status).toBe('pending');
    // Nuvion completes and then reverses before the Hub heard of the first;
    // the deliveries arrive the wrong way round, and twice each.
    pay.settle(nuvion.id, 'successful');
    const { credit } = pay.reverse(nuvion.id);
    const refund = {
      ...pay.delivery(credit.id),
      amount: b.quotedTotal - WAWU_FEE,
    };
    expect((await deliver('outflows.refunded', refund, me)).outcome).toBe(
      'done',
    );
    expect((await deliver('outflows.refunded', refund, me)).outcome).toBe(
      'done',
    );
    expect(
      await waitFor(async () => (await rowOf(view.id)).status === 'reversed'),
    ).toBe(true);
    // The completion that was sent first: Nuvion's record says reversed, so
    // that is what is recorded, and it is already.
    await deliver('outflows.completed', pay.delivery(nuvion.id), me);
    await deliver('outflows.completed', pay.delivery(nuvion.id), me);
    expect(await waitFor(() => feeBacks(view.reference).length === 1)).toBe(
      true,
    );
    await transfers.sweep(later());
    await transfers.sweep(later());

    const row = await rowOf(view.id);
    expect(row.status).toBe('reversed');
    expect(row.reviewSince).toBeNull();
    expect(feeBacks(view.reference)).toHaveLength(1);
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect((await ledgerOut(view.reference)).status).toBe('reversed');
    expect(available(me)).toBe(PERSON_START);
    expect(
      await waitFor(() => reversalTotal(view.reference, b.quotedTotal)),
    ).toBe(true);
    expect((await read(me, view.id)).reversal).toMatchObject({
      returnedKobo: b.quotedTotal,
      keptKobo: 0,
    });
  });

  it("a reversed send's figures equal what the stand-in returned: the credit and WAWU's fee-back, whichever of them the Hub heard of first", async () => {
    const { me, b, view, nuvion } = await send();
    pay.settle(nuvion.id, 'successful');
    await deliver('outflows.completed', pay.delivery(nuvion.id), me);
    expect(
      await waitFor(async () => (await rowOf(view.id)).status === 'completed'),
    ).toBe(true);
    const beforeRefund = available(me);

    const { credit } = pay.reverse(nuvion.id);
    const refund = {
      ...pay.delivery(credit.id),
      amount: b.quotedTotal - WAWU_FEE,
    };
    expect((await deliver('outflows.refunded', refund, me)).outcome).toBe(
      'done',
    );
    expect(
      await waitFor(async () => (await rowOf(view.id)).status === 'reversed'),
    ).toBe(true);
    expect(await waitFor(() => feeBacks(view.reference).length === 1)).toBe(
      true,
    );
    expect(
      await waitFor(() => reversalTotal(view.reference, b.quotedTotal)),
    ).toBe(true);

    // What moved back, read from the stand-in: the wallet's gain since the
    // refund is Nuvion's credit and WAWU's fee-back together.
    const movedBack = available(me) - beforeRefund;
    const feeBack = feeBacks(view.reference).reduce(
      (n, t) => n + Number(t.amount),
      0,
    );
    expect(feeBack).toBe(WAWU_FEE);
    const reversal = (await read(me, view.id)).reversal!;
    expect(reversal.returnedKobo).toBe(movedBack);
    expect(reversal.returnedKobo + reversal.keptKobo).toBe(b.quotedTotal);
    expect(reversal.keptKobo).toBe(PERSON_START - available(me));

    // The other order: the fee-back was noted before the credit's figures
    // reached the row. The row ends the same, and a replay changes nothing.
    const out = await ledgerOut(view.reference);
    await prisma.fintavaLedgerEntry.update({
      where: { id: out.id },
      data: {
        reversedAt: null,
        reversalReference: null,
        reversalAmountKobo: null,
        reversalChargesKobo: null,
        reversalTotalKobo: null,
      },
    });
    const ledger = moduleRef.get(LedgerService);
    expect(
      await ledger.noteFeeReturned(
        { customerReference: view.reference, wawuUserId: me.id },
        BigInt(WAWU_FEE),
      ),
    ).toBe(true);
    expect((await read(me, view.id)).reversal).toBeNull();
    expect(
      await ledger.noteReversalFigures(out.id, {
        at: new Date(),
        reference: credit.id,
        amountKobo: b.quotedTotal - WAWU_FEE,
        chargesKobo: 0,
        totalKobo: b.quotedTotal - WAWU_FEE,
      }),
    ).toBe(true);
    expect((await read(me, view.id)).reversal).toMatchObject({
      returnedKobo: b.quotedTotal,
      keptKobo: 0,
    });
    expect(
      await ledger.noteFeeReturned(
        { customerReference: view.reference, wawuUserId: me.id },
        BigInt(WAWU_FEE),
      ),
    ).toBe(false);
    expect((await read(me, view.id)).reversal).toMatchObject({
      returnedKobo: b.quotedTotal,
      keptKobo: 0,
    });
  });

  it('a send the sweep fails on its own reading says what the webhook path says, not Fintava', async () => {
    pay.loseAnswerNext();
    const { me, view } = await send();
    await new Promise((r) => setTimeout(r, 700));
    pay.settle(pay.byReference(view.reference)[0].id, 'failed');
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('failed');
    const out = await ledgerOut(view.reference);
    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe(LEDGER_BANK_SEND_FAILURE);
    expect(out.failureReason).not.toMatch(/fintava/i);
    expect(await waitFor(() => feeBacks(view.reference).length === 1)).toBe(
      true,
    );
    expect(available(me)).toBe(PERSON_START);
  });

  it('a send that waited on its fee and is issued later by the sweep is pending too, not completed on acceptance', async () => {
    // WAWU's fee transfer is accepted and not finished: the send waits, and
    // nothing is sent to the bank yet.
    book.mode = 'pending';
    const { me, b, view, count } = await send();
    expect(view.status).toBe('pending');
    expect(count).toBe(0);
    expect(PERSON_START - available(me)).toBeLessThan(b.quotedTotal);

    // The fee finishes; the sweep issues the send once Nuvion's answer is
    // overdue. Nuvion accepts it: pending, and the Hub says so.
    book.settle(`${view.reference}-fee`, 'successful');
    await new Promise((r) => setTimeout(r, 700));
    await transfers.sweep(later());
    await waitFor(() => pay.byReference(view.reference).length === 1);
    const made = pay.byReference(view.reference);
    expect(made).toHaveLength(1);
    expect(made[0].status).toBe('pending');
    expect((await rowOf(view.id)).status).toBe('pending');
    expect((await read(me, view.id)).status).toBe('pending');
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);

    // Only Nuvion's word completes it.
    pay.settle(made[0].id, 'successful');
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('completed');
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(pay.byReference(view.reference)).toHaveLength(1);
    expect(await ledgerNet(me)).toBe(-(PERSON_START - available(me)));
  });

  it("a lost answer then a status poll: the send waits, is never sent twice, and the sweep settles it from Nuvion's own record", async () => {
    pay.loseAnswerNext();
    const { me, b, view, count } = await send();
    // The Hub never saw the answer: pending, not failed and not completed.
    expect(view.status).toBe('pending');
    expect(count).toBe(1);
    expect((await rowOf(view.id)).status).toBe('pending');
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);

    // The poll finds Nuvion's transfer, still pending: nothing is decided.
    await new Promise((r) => setTimeout(r, 700));
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('pending');
    expect(pay.byReference(view.reference)).toHaveLength(1);

    // Nuvion completes it with no delivery reaching us: the next poll does.
    pay.settle(pay.byReference(view.reference)[0].id, 'successful');
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('completed');
    expect((await read(me, view.id)).status).toBe('completed');
    expect((await ledgerOut(view.reference)).status).toBe('completed');
    expect(await ledgerNet(me)).toBe(-(PERSON_START - available(me)));
    await transfers.sweep(later());
    expect(pay.byReference(view.reference)).toHaveLength(1);
    expect(feeLegs(view.reference)).toHaveLength(1);

    // A second one that Nuvion fails: the poll fails it and gives the fee back.
    pay.loseAnswerNext();
    const second = await send();
    expect(second.view.status).toBe('pending');
    await new Promise((r) => setTimeout(r, 700));
    pay.settle(pay.byReference(second.view.reference)[0].id, 'failed');
    await transfers.sweep(later());
    expect((await rowOf(second.view.id)).status).toBe('failed');
    expect(
      await waitFor(() => feeBacks(second.view.reference).length === 1),
    ).toBe(true);
    expect(available(second.me)).toBe(PERSON_START);
    await transfers.sweep(later());
    expect(feeBacks(second.view.reference)).toHaveLength(1);
    expect((await read(second.me, second.view.id)).failureReason).toBe(
      BANK_SEND_RETURNED_REASON,
    );
  });

  it('FIX-66 F2: after every send of this spec (completed, failed, reversed, waiting on its fee) the operational account ledger equals Nuvion exactly', async () => {
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: {
        walletKind: 'merchant',
        accountNumber: book.operational.nuvion_ban,
        status: 'completed',
        createdAt: { gte: startedAt },
      },
      select: { direction: true, totalKobo: true, customerReference: true },
    });
    const net = rows.reduce(
      (n, r) => n + (r.direction === 'in' ? 1 : -1) * Number(r.totalKobo),
      0,
    );
    // The fee leg of each bank send is a row of its own on WAWU's account.
    expect(
      rows.filter((r) => r.customerReference?.endsWith('-fee')).length,
    ).toBeGreaterThan(0);
    expect(net).toBe(operational() - OPERATIONAL_START);
  });
});
