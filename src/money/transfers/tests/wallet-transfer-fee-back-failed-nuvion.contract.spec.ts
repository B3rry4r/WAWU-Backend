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
} from '../../../../test/nuvion/accounts-standin';
import { NuvionBookStandin } from '../../../../test/nuvion/book-standin';
import {
  errorBody,
  NuvionStandin,
} from '../../../../test/nuvion/nuvion-standin';
import {
  guardOutbound,
  type OutboundGuard,
} from '../../../../test/nuvion/outbound-guard';
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
import { PrismaNuvionBookStore } from '../../../nuvion/areas/book-store';
import { sendReferenceOfFee } from '../../../nuvion/handlers/book';
import { NuvionBookHandler } from '../../../nuvion/handlers/book.handler';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { FeeQuoteService } from '../../fees/fee-quote.service';
import { MoneyModule } from '../../money.module';
import { PaymentSettings } from '../../payments/payment-config';
import type { FeeQuoteView, TransferView } from '../../money-view.type';
import {
  FEE_RETURN_RETRY_MS,
  feeBackReference,
  sendReferenceOfFeeBack,
  WalletTransferService,
} from '../wallet-transfer.service';

/**
 * A fee given back that Nuvion ACCEPTS and then FAILS lands, once, under a
 * new reference (FIX-70, FIX-66's check, finding G-FIX-66-1).
 *
 * A send that did not stand owes its sender the fee WAWU took (FIX-52). It
 * goes back under `<send>-fee-back`. When Nuvion took that transfer and then
 * failed it, Nuvion's own record says the reference is spent (`unique_reference`
 * is its idempotency key, so a repeat answers with the same failed record), and
 * trying again under it brought the same failed record for ever: the person's
 * fee never came back. Now the one new try is made under `<send>-fee-back-2`,
 * and only on the provider's own record that the first failed. A timeout, a
 * 5xx or a transfer Nuvion has not finished never starts a new reference. A
 * second failure sends nothing more, rests, and past the review bound goes to
 * a person.
 *
 * The REAL Nuvion adapter and book area over Nuvion's stand-in (a socket);
 * nothing here reaches a Nuvion, Fintava or wawuafrica.com host (every
 * connection but loopback is refused).
 */

const BASE = '/api/hub/money';
const WAWU_FEE = 1000;
const FEE = 150;
const AMOUNT = 200_000;
const OPERATIONAL_START = 5_000_000;
const PERSON_START = 1_000_000;
const HOUR = 3_600_000;
const HALF_HOUR = 30 * 60_000;

jest.setTimeout(120_000);

let numberSeq = 0;
const nuban = () =>
  `6${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

describe('A fee given back that Nuvion accepts and then fails is given back under a new reference, once (FIX-70)', () => {
  const standin = new NuvionStandin();
  const wawuId = new WawuIdDouble();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let transfers: WalletTransferService;
  let moduleRef: TestingModule;
  let outsideCounter: Server;
  const outsideHits: string[] = [];
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const startedAt = new Date();
  let clock = Date.now();
  const later = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  /**
   * Nuvion fails the next N fee-back transfers it holds pending while the
   * adapter waits on them (the wait between its answer `pending` and the read
   * of the transfer again), as its processing would, and the mode the stand-in
   * takes the next transfers in is then `modeAfter`.
   */
  let failBudget = 0;
  let modeAfter: 'pending' | 'successful' = 'pending';
  /**
   * SWEEP-MONEY-4 C1: a status word Nuvion's docs do not list, put on the next
   * fee-back it holds pending while the adapter waits, so the adapter's own
   * read of that transfer is the one that meets it.
   */
  let rewordTo: string | null = null;
  const failFeeBacksWhileWaiting = (): Promise<void> => {
    for (const t of book.all()) {
      if (
        rewordTo !== null &&
        t.status === 'pending' &&
        /-fee-back(-2)?$/.test(t.unique_reference)
      ) {
        (t as { status: string }).status = rewordTo;
        rewordTo = null;
        continue;
      }
      if (
        failBudget > 0 &&
        t.status === 'pending' &&
        /-fee-back(-2)?$/.test(t.unique_reference)
      ) {
        failBudget -= 1;
        book.settle(t.id, 'failed');
        book.mode = modeAfter;
      }
    }
    return Promise.resolve();
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
        accountName: `Nuvion Feeder ${accountNumber}`,
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
        handle: `f70-${id.slice(0, 8)}`,
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

  async function prepare(p: Person, to: Person, amountKobo: number) {
    const quote = await request(app.getHttpServer())
      .get(`${BASE}/fees/quote?kind=wawu_transfer&amountKobo=${amountKobo}`)
      .set('Authorization', p.auth);
    expect(quote.status).toBe(200);
    const q = body<FeeQuoteView>(quote).data!;
    return {
      recipientWawuUserId: to.id,
      amountKobo,
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
    };
  }

  async function post(p: Person, payload: object) {
    return request(app.getHttpServer())
      .post(`${BASE}/transfers/wawu`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', randomUUID())
      .set('X-Transaction-Pin', PIN)
      .send(payload);
  }

  const available = (p: Person) => book.availableOf(p.account.id);
  const operational = () => book.availableOf(book.operational.id);
  const backRef = (reference: string) => feeBackReference(reference, 1);
  const backRef2 = (reference: string) => feeBackReference(reference, 2);
  /** Every transfer Nuvion holds that gives this send's fee back, whatever the try. */
  const backsOf = (reference: string) =>
    book
      .all()
      .filter((t) => t.unique_reference.startsWith(`${reference}-fee-back`));
  const rowOf = (id: string) =>
    prisma.walletTransfer.findUniqueOrThrow({ where: { id } });
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
  /** What WAWU's ledger says its own (operational) account changed by since this spec began. */
  const operationalLedgerNet = async () => {
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: {
        walletKind: 'merchant',
        accountNumber: book.operational.nuvion_ban,
        status: 'completed',
        createdAt: { gte: startedAt },
      },
      select: { direction: true, totalKobo: true },
    });
    return rows.reduce(
      (n, r) => n + (r.direction === 'in' ? 1 : -1) * Number(r.totalKobo),
      0,
    );
  };
  /** WAWU's ledger = Nuvion for the operational account, and nothing left this machine. */
  const ledgerEqualsNuvion = async () => {
    expect(await operationalLedgerNet()).toBe(
      operational() - OPERATIONAL_START,
    );
    expect(outsideHits).toEqual([]);
  };
  /**
   * The sender's ledger = Nuvion for the sender: what the ledger counts as
   * money moved (completed rows; a failed or reversed row moves nothing, as
   * the money check counts them) is what Nuvion's balance has moved.
   */
  const senderLedgerEqualsNuvion = async (p: Person) => {
    expect(await ledgerNet(p)).toBe(available(p) - PERSON_START);
  };
  /** WAWU's and the sender's ledger both equal Nuvion, at this step. */
  const bothEqualNuvion = async (p: Person) => {
    await ledgerEqualsNuvion();
    await senderLedgerEqualsNuvion(p);
  };
  const merchantRows = (reference: string, direction: 'in' | 'out') =>
    prisma.fintavaLedgerEntry.findMany({
      where: {
        customerReference: reference,
        walletKind: 'merchant',
        direction,
      },
    });

  /**
   * The review bound for the length of one scenario (the default is 72 hours;
   * this spec runs at 24). Returns the way back.
   */
  const reviewBound = (hours: number): (() => void) => {
    const settings: { reviewAfterHours: number } =
      moduleRef.get(PaymentSettings);
    const was = settings.reviewAfterHours;
    settings.reviewAfterHours = hours;
    return () => {
      settings.reviewAfterHours = was;
    };
  };

  /** Puts a status word on a transfer Nuvion holds (one its docs do not list, or a known one back). */
  const wordOn = (reference: string, word: string) => {
    const held = book.byReference(reference);
    expect(held).toHaveLength(1);
    (held[0] as { status: string }).status = word;
  };
  /** Every request that tried to make a fee-back transfer for this send, by reference. */
  const backPosts = (reference: string) =>
    book.createRequests
      .map((r) => String(r.unique_reference))
      .filter((r) => r.startsWith(`${reference}-fee-back`));
  /** Fee-back transfers Nuvion holds that are not finished: never more than one. */
  const backsInFlight = (reference: string) =>
    backsOf(reference).filter(
      (t) => t.status !== 'failed' && t.status !== 'successful',
    ).length;
  /**
   * Nuvion cannot be read for ONE transfer (the read of it answers 503;
   * everything else answers as it does). Returns the way back.
   */
  const unreadable = (id: string): (() => void) => {
    const handler = () => ({
      status: 503,
      body: errorBody('error_system_service_unavailable'),
    });
    standin.on('GET', new RegExp(`^/transfers/${id}$`), handler);
    return () => {
      const routes = (
        standin as unknown as { routes: Array<{ handler: unknown }> }
      ).routes;
      routes.splice(
        routes.findIndex((r) => r.handler === handler),
        1,
      );
    };
  };

  /** Nuvion's own webhook for a transfer it holds (the handler the Hub runs). */
  const deliver = (
    event: string,
    transfer: Record<string, unknown>,
    p: Person,
  ) =>
    new NuvionBookHandler(prisma, moduleRef.get(ModuleRef)).handle({
      id: randomUUID(),
      eventId: randomUUID(),
      event,
      resourceId: transfer.id as string,
      entityId: p.account.entity_id,
      data: transfer,
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
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };
  /**
   * WAWU's fee is not more than Nuvion's charge for moving it, so no transfer
   * of it is due or made (`feeLegKobo` is 0): Nuvion's charge on every transfer
   * is the whole of WAWU's fee. Returns the way back.
   */
  const feeNeverDue = (): (() => void) => {
    const schedule = moduleRef.get(FeeQuoteService).providerFees as {
      walletToWalletKobo: (amountKobo: number) => number;
    };
    const was = schedule.walletToWalletKobo;
    const chargeWas = book.feeKobo;
    schedule.walletToWalletKobo = () => WAWU_FEE;
    book.feeKobo = () => WAWU_FEE;
    return () => {
      schedule.walletToWalletKobo = was;
      book.feeKobo = chargeWas;
    };
  };

  /** The send is read again now: it is failed, and the fee it owes is given back at once. */
  const giveFeeBack = (view: TransferView) =>
    transfers.settle(view.id, later(), true);

  /**
   * A send whose fee moved and which Nuvion then failed: it owes its sender
   * the fee. Returns before the send is read again (`giveFeeBack`).
   */
  async function sendNuvionFails() {
    const me = await person(PERSON_START);
    const to = await person(0);
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    expect(view.status).toBe('pending');
    book.settle(`${view.reference}-fee`, 'successful');
    await transfers.sweep(later());
    expect(book.byReference(view.reference)).toHaveLength(1);
    book.settle(view.reference, 'failed');
    return { me, to, view };
  }

  beforeAll(async () => {
    guard = guardOutbound();
    outsideCounter = createServer((req, res) => {
      outsideHits.push(`${req.method} ${req.url}`);
      res.statusCode = 503;
      res.end('{}');
    });
    await new Promise<void>((r) =>
      outsideCounter.listen(0, '127.0.0.1', () => r()),
    );
    const port = (outsideCounter.address() as AddressInfo).port;
    await standin.start();
    await wawuId.start();
    accounts.install();
    book.install();
    book.fundOperational(OPERATIONAL_START);
    // Nuvion's own charge on every transfer, and nothing of WAWU's in it.
    book.feeKobo = () => FEE;
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_f70_adapter_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'f70-adapter-fee-quote-key-0123456789abcdef01',
      NUVION_FEE_BOOK_TRANSFER: String(FEE),
      NUVION_FEE_BANK_PAYOUT: String(FEE),
      NUVION_FEE_INFLOW: String(FEE),
      WAWU_ID_JWKS_URL: wawuId.jwksUrl,
      WAWU_ID_BASE_URL: wawuId.baseUrl,
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '24',
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
      'nv_test_sk_F70adapterKEY0000000000000000',
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
              { settleStepsMs: [1], sleep: () => failFeeBacksWhileWaiting() },
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
        feeBackReference(r.customerReference, 1),
        feeBackReference(r.customerReference, 2),
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
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { recipientWawuUserId: { in: users } },
          ],
        },
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
    await new Promise<void>((r) => outsideCounter.close(() => r()));
    guard.restore();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    // Each scenario starts at the real time: one that looked ahead past the
    // review bound must not age the sends of the next.
    clock = Date.now();
    book.mode = 'pending';
    failBudget = 0;
    modeAfter = 'pending';
  });

  it('the new reference keeps its link to the send, and does not wake it as the fee transfer does', () => {
    const send = `wawu-send-${randomUUID()}`;
    expect(backRef(send)).toBe(`${send}-fee-back`);
    expect(backRef2(send)).toBe(`${send}-fee-back-2`);
    expect(sendReferenceOfFeeBack(backRef(send))).toBe(send);
    expect(sendReferenceOfFeeBack(backRef2(send))).toBe(send);
    expect(sendReferenceOfFeeBack(send)).toBeNull();
    // The send's own fee transfer is the one a delivery wakes the send for.
    expect(sendReferenceOfFee(`${send}-fee`)).toBe(send);
    expect(sendReferenceOfFee(backRef2(send))).toBeNull();
    // Nuvion takes a unique_reference of 64 characters at most.
    expect(backRef2(send).length).toBeLessThanOrEqual(64);
  });

  it('a fee given back that Nuvion accepts and then fails lands once under a new reference: the person is whole, the ledger holds one row, and sweeping again moves nothing', async () => {
    const { me, to, view } = await sendNuvionFails();
    failBudget = 1;
    modeAfter = 'successful';
    await giveFeeBack(view);
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.sweep(later(40 * 60_000));

    expect((await rowOf(view.id)).status).toBe('failed');
    const first = book.byReference(backRef(view.reference));
    const second = book.byReference(backRef2(view.reference));
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('failed');
    expect(second).toHaveLength(1);
    expect(second[0].status).toBe('successful');
    // Two transfers in all: the one new try, never a third.
    expect(backsOf(view.reference)).toHaveLength(2);
    expect(available(me)).toBe(PERSON_START);
    expect(available(to)).toBe(0);
    expect(await ledgerNet(me)).toBe(0);

    // The OUT row is written once, for the try that landed.
    expect(await merchantRows(backRef(view.reference), 'out')).toEqual([]);
    const out = await merchantRows(backRef2(view.reference), 'out');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ status: 'completed', category: 'refund' });
    expect(Number(out[0].amountKobo)).toBe(WAWU_FEE);
    expect(Number(out[0].feeKobo)).toBe(FEE);
    const done = await rowOf(view.id);
    expect(done.nextCheckAt).toBeNull();
    expect(done.reviewSince).toBeNull();
    await ledgerEqualsNuvion();
  });

  it('the second try is never sent in the pass that saw the first fail, and waits at least the sweep interval for a later one (FIX-70 round 2)', async () => {
    const { me, view } = await sendNuvionFails();
    failBudget = 1;
    modeAfter = 'successful';
    const before = Date.now();
    await giveFeeBack(view);

    // The pass that saw the first fail sent nothing more.
    const first = book.byReference(backRef(view.reference));
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('failed');
    expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
    const waiting = await rowOf(view.id);
    expect(waiting.reviewSince).toBeNull();
    expect(waiting.nextCheckAt!.getTime() - before).toBeGreaterThanOrEqual(
      FEE_RETURN_RETRY_MS - 1_000,
    );
    await bothEqualNuvion(me);

    // A pass inside the interval finds nothing due.
    await transfers.sweep(new Date(Date.now() + FEE_RETURN_RETRY_MS / 2));
    expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
    expect(backsOf(view.reference)).toHaveLength(1);

    // A later pass sends the one new try, and it lands.
    await transfers.sweep(later());
    expect(book.byReference(backRef2(view.reference))).toHaveLength(1);
    expect(book.byReference(backRef2(view.reference))[0].status).toBe(
      'successful',
    );
    expect(backsOf(view.reference)).toHaveLength(2);
    expect(available(me)).toBe(PERSON_START);
    await bothEqualNuvion(me);
    expect((await rowOf(view.id)).nextCheckAt).toBeNull();
  });

  it('a second failure does not loop: nothing more is sent, it rests, and past the review bound it goes to a person, and the ledger equals Nuvion for the sender and for WAWU at every step', async () => {
    const { me, view } = await sendNuvionFails();
    failBudget = 2;
    modeAfter = 'pending';
    await giveFeeBack(view);

    // Step 1: the first try failed; the fee is still the sender's to be
    // given back, and the ledger shows it as gone from the wallet.
    const first = book.byReference(backRef(view.reference));
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe('failed');
    expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
    expect(available(me)).toBe(PERSON_START - WAWU_FEE);
    await bothEqualNuvion(me);

    // Step 2: a later pass makes the one new try, and Nuvion fails that too.
    await transfers.sweep(later());
    const second = book.byReference(backRef2(view.reference));
    expect(second).toHaveLength(1);
    expect(second[0].status).toBe('failed');
    // It rests (a long wait, still owed, not in review yet).
    const resting = await rowOf(view.id);
    expect(resting.reviewSince).toBeNull();
    expect(resting.nextCheckAt).not.toBeNull();
    expect(resting.nextCheckAt!.getTime()).toBeGreaterThan(Date.now());
    await bothEqualNuvion(me);

    // Looked at again and again inside the bound: still two transfers, never a third.
    for (let i = 0; i < 3; i += 1) {
      await transfers.sweep(later(35 * 60_000));
      await bothEqualNuvion(me);
    }
    expect(backsOf(view.reference)).toHaveLength(2);
    expect((await rowOf(view.id)).reviewSince).toBeNull();
    // Nothing was invented: the fee is still the sender's to be given back,
    // and the ledger says so (the fee row is money gone, not reversed).
    expect(available(me)).toBe(PERSON_START - WAWU_FEE);
    const owed = await prisma.fintavaLedgerEntry.findMany({
      where: {
        customerReference: `${view.reference}-fee`,
        walletKind: 'user',
        direction: 'out',
      },
    });
    expect(owed).toHaveLength(1);
    expect(owed[0].status).toBe('completed');
    expect(Number(owed[0].totalKobo)).toBe(WAWU_FEE);

    // Past the review bound a person takes it, and the sweep lets it go.
    await transfers.sweep(later(26 * HOUR));
    const held = await rowOf(view.id);
    expect(held.reviewSince).not.toBeNull();
    expect(held.nextCheckAt).toBeNull();
    expect(held.discrepancy).toMatch(/fee could not be given back/);
    expect(held.discrepancy).not.toContain(String.fromCharCode(0x2014));
    expect(held.status).toBe('failed');
    await bothEqualNuvion(me);
    for (let i = 0; i < 3; i += 1) await transfers.sweep(later(26 * HOUR));
    expect(backsOf(view.reference)).toHaveLength(2);
    expect(await merchantRows(backRef(view.reference), 'out')).toEqual([]);
    expect(await merchantRows(backRef2(view.reference), 'out')).toEqual([]);
    expect(available(me)).toBe(PERSON_START - WAWU_FEE);
    await bothEqualNuvion(me);
  });

  it('the sender fee row shows the fee as gone until a fee-back has landed, then stays what Nuvion shows (completed) and the give-back is a row of its own (FIX-98; FIX-70 round 2 turned it reversed)', async () => {
    const { me, view } = await sendNuvionFails();
    book.mode = 'processing';
    await giveFeeBack(view);
    const feeRow = () =>
      prisma.fintavaLedgerEntry.findFirstOrThrow({
        where: {
          customerReference: `${view.reference}-fee`,
          walletKind: 'user',
          direction: 'out',
        },
      });
    const backIn = () =>
      prisma.fintavaLedgerEntry.findMany({
        where: {
          customerReference: backRef(view.reference),
          walletKind: 'user',
          direction: 'in',
        },
      });
    // The fee-back is made and not finished: the fee is still owed.
    expect((await feeRow()).status).toBe('completed');
    expect(await backIn()).toHaveLength(0);
    await senderLedgerEqualsNuvion(me);
    book.settle(backRef(view.reference), 'successful');
    await transfers.sweep(later());
    // The fee's transfer is `successful` at Nuvion and stays completed here;
    // the give-back is money in under its own reference (FIX-98).
    const kept = await feeRow();
    expect(kept.status).toBe('completed');
    expect(kept.discrepancy).toBeNull();
    expect(Number(kept.totalKobo)).toBe(WAWU_FEE);
    const given = await backIn();
    expect(given).toHaveLength(1);
    expect(given[0]).toMatchObject({
      status: 'completed',
      category: 'refund',
      discrepancy: null,
    });
    expect(Number(given[0].totalKobo)).toBe(WAWU_FEE);
    expect(available(me)).toBe(PERSON_START);
    await bothEqualNuvion(me);
  });

  it("FIX-98: after a refused send the fee row and the give-back agree with Nuvion's records: the fee transfer's own delivery, after the give-back, leaves no discrepancy on any row", async () => {
    // Dev, 23 Oct 2026: a bank send Nuvion refused, WAWU's fee given back by
    // a book transfer of its own. The statement shows the fee out and back,
    // both `successful`; the Hub had turned the fee row `reversed`, and the
    // fee transfer's delivery then wrote "webhook sighting: status reversed
    // vs completed" (row dd9b8c36), which kept money:check at `differences`.
    const { me, view } = await sendNuvionFails();
    book.mode = 'successful';
    await giveFeeBack(view);
    await transfers.sweep(later());
    const feeT = book.byReference(`${view.reference}-fee`)[0];
    const backT = book.byReference(backRef(view.reference))[0];
    expect(feeT.status).toBe('successful');
    expect(backT.status).toBe('successful');
    expect((await deliver('outflows.completed', feeT, me)).outcome).toBe(
      'done',
    );
    expect((await deliver('outflows.completed', backT, me)).outcome).toBe(
      'done',
    );
    await transfers.sweep(later());
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: {
        customerReference: {
          in: [`${view.reference}-fee`, backRef(view.reference)],
        },
      },
    });
    // Four rows, one per side of each of Nuvion's two transfers, each what
    // Nuvion says its transfer is.
    expect(
      rows.map((r) => `${r.walletKind} ${r.direction} ${r.status}`).sort(),
    ).toEqual([
      'merchant in completed',
      'merchant out completed',
      'user in completed',
      'user out completed',
    ]);
    expect(rows.filter((r) => r.discrepancy !== null)).toEqual([]);
    // The sender's history names the two rows as what they are (round 2).
    const mine = rows.filter((r) => r.walletKind === 'user');
    expect(
      mine.map((r) => `${r.direction} ${r.counterpartyName}`).sort(),
    ).toEqual(["in WAWU's fee given back", "out WAWU's fee"]);
    await bothEqualNuvion(me);
  });

  it('a fee given back that Nuvion leaves unfinished is asked about only until the review bound: then a person looks and it is not asked again (FIX-70 round 2)', async () => {
    const { me, view } = await sendNuvionFails();
    book.mode = 'processing';
    await giveFeeBack(view);
    expect(book.byReference(backRef(view.reference))).toHaveLength(1);
    // Inside the bound it is asked every pass and stays in the sweep.
    await transfers.sweep(later());
    await transfers.sweep(later());
    const asking = await rowOf(view.id);
    expect(asking.reviewSince).toBeNull();
    expect(asking.nextCheckAt).not.toBeNull();

    // Past the bound a person takes it and the sweep lets it go.
    await transfers.sweep(later(26 * HOUR));
    const held = await rowOf(view.id);
    expect(held.reviewSince).not.toBeNull();
    expect(held.nextCheckAt).toBeNull();
    expect(held.discrepancy).toMatch(/has not finished the transfer/);
    expect(held.discrepancy).not.toContain(String.fromCharCode(0x2014));

    // Not asked again: when Nuvion fails it, no new reference follows, and
    // nothing is recorded for it.
    book.settle(backRef(view.reference), 'failed');
    for (let i = 0; i < 3; i += 1) await transfers.sweep(later(26 * HOUR));
    expect(backsOf(view.reference)).toHaveLength(1);
    expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
    expect(await merchantRows(backRef(view.reference), 'out')).toEqual([]);
    expect(available(me)).toBe(PERSON_START - WAWU_FEE);
    await bothEqualNuvion(me);
  });

  it('a timeout never starts a new reference: Nuvion took the transfer and the answer was lost, and it is asked about under the same reference until its own record says', async () => {
    const { me, view } = await sendNuvionFails();
    // Nuvion takes the fee back and the answer never arrives.
    book.loseAnswerNext(true);
    await giveFeeBack(view);
    expect(book.byReference(backRef(view.reference))).toHaveLength(1);
    expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
    // Asked again, and again: pending at Nuvion, never a second reference,
    // never a second transfer under the first.
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(book.byReference(backRef(view.reference))).toHaveLength(1);
    expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
    expect((await rowOf(view.id)).nextCheckAt).not.toBeNull();

    // Only when Nuvion's own record says it failed does the one new try follow.
    book.settle(backRef(view.reference), 'failed');
    book.mode = 'successful';
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(book.byReference(backRef(view.reference))).toHaveLength(1);
    expect(book.byReference(backRef2(view.reference))).toHaveLength(1);
    expect(backsOf(view.reference)).toHaveLength(2);
    expect(book.byReference(backRef2(view.reference))[0].status).toBe(
      'successful',
    );
    expect(available(me)).toBe(PERSON_START);
    expect(await ledgerNet(me)).toBe(0);
    expect(await merchantRows(backRef2(view.reference), 'out')).toHaveLength(1);
    await ledgerEqualsNuvion();
  });

  it('a 5xx never starts a new reference: nothing was made, so the first reference is used, once', async () => {
    const { me, view } = await sendNuvionFails();
    book.systemErrorNext({ created: false, status: 503 });
    await giveFeeBack(view);
    expect(backsOf(view.reference)).toHaveLength(0);
    expect((await rowOf(view.id)).nextCheckAt).not.toBeNull();
    book.mode = 'successful';
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(book.byReference(backRef(view.reference))).toHaveLength(1);
    expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
    expect(available(me)).toBe(PERSON_START);
    expect(await merchantRows(backRef(view.reference), 'out')).toHaveLength(1);
    await ledgerEqualsNuvion();
  });

  it('a transfer Nuvion has not finished never starts a new reference, however long it takes', async () => {
    const { me, view } = await sendNuvionFails();
    book.mode = 'processing';
    await giveFeeBack(view);
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(book.byReference(backRef(view.reference))).toHaveLength(1);
    expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
    expect(available(me)).toBe(PERSON_START - WAWU_FEE);
    // It finishes at Nuvion: the same transfer lands, and there is still no second reference.
    book.settle(backRef(view.reference), 'successful');
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(backsOf(view.reference)).toHaveLength(1);
    expect(available(me)).toBe(PERSON_START);
    expect(await merchantRows(backRef(view.reference), 'out')).toHaveLength(1);
    await ledgerEqualsNuvion();
  });

  // -------------------------------------------------------------------------
  // SWEEP-MONEY-4 C1 (FIX-70): the unknown-status-word case, and the retry
  // rule held for every way the provider's answer can be unclear. Each
  // confirmed provider failure gets one new try under a new reference; a
  // timeout, a 5xx, an unreadable record or a word we do not know asks again
  // and never sends again; never two fee-backs in flight.
  // -------------------------------------------------------------------------

  it('a fee given back whose record carries a status word we do not know is asked about only: no new reference, no second request, never two in flight; the failed record then starts exactly one', async () => {
    const { me, view } = await sendNuvionFails();
    const first = backRef(view.reference);
    rewordTo = 'on_hold';
    await giveFeeBack(view);
    expect(rewordTo).toBeNull();
    expect(book.byReference(first)).toHaveLength(1);
    expect(book.byReference(first)[0].status).toBe('on_hold');
    expect(backPosts(view.reference)).toEqual([first]);

    // Asked about, again and again, over most of the review bound.
    for (const ms of [2 * 60_000, 30 * 60_000, 3 * HOUR, 10 * HOUR]) {
      await transfers.sweep(later(ms));
      expect(backPosts(view.reference)).toEqual([first]);
      expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
      expect(backsInFlight(view.reference)).toBeLessThanOrEqual(1);
    }
    const asking = await rowOf(view.id);
    expect(asking.reviewSince).toBeNull();
    expect(asking.nextCheckAt).not.toBeNull();
    // Nothing came back and nothing more left: the word proves neither.
    // (The fee-back is unfinished at Nuvion, so its ledger row is not
    // complete yet: the ledger equals Nuvion again once it lands.)
    expect(available(me)).toBe(PERSON_START - WAWU_FEE);

    // Nuvion's word becomes one it lists: failed. One new try follows, once.
    wordOn(first, 'pending');
    book.settle(first, 'failed');
    book.mode = 'successful';
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(backPosts(view.reference)).toEqual([
      first,
      backRef2(view.reference),
    ]);
    expect(backsOf(view.reference)).toHaveLength(2);
    expect(book.byReference(backRef2(view.reference))[0].status).toBe(
      'successful',
    );
    expect(available(me)).toBe(PERSON_START);
    expect(await merchantRows(first, 'out')).toEqual([]);
    expect(await merchantRows(backRef2(view.reference), 'out')).toHaveLength(1);
    expect((await rowOf(view.id)).nextCheckAt).toBeNull();
    await bothEqualNuvion(me);
  });

  it('a fee transfer whose own record carries a status word we do not know is asked about: the fee is not taken for "never charged", nothing is sent back until Nuvion says', async () => {
    const { me, view } = await sendNuvionFails();
    const fee = `${view.reference}-fee`;
    const owing = available(me);
    wordOn(fee, 'on_hold');
    await giveFeeBack(view);
    for (const ms of [2 * 60_000, 30 * 60_000, 3 * HOUR]) {
      await transfers.sweep(later(ms));
    }
    // No fee-back was started on a guess, and the fee is still owed and asked
    // about (not closed as if it had never been taken).
    expect(backPosts(view.reference)).toEqual([]);
    expect(backsOf(view.reference)).toHaveLength(0);
    expect(available(me)).toBe(owing);
    const asking = await rowOf(view.id);
    expect(asking.nextCheckAt).not.toBeNull();
    expect(asking.reviewSince).toBeNull();

    // Nuvion's word is one it lists: the fee did move, so it comes back, once.
    wordOn(fee, 'successful');
    book.mode = 'successful';
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(backPosts(view.reference)).toEqual([backRef(view.reference)]);
    expect(backsOf(view.reference)).toHaveLength(1);
    expect(available(me)).toBe(PERSON_START);
    expect(await merchantRows(backRef(view.reference), 'out')).toHaveLength(1);
    expect((await rowOf(view.id)).nextCheckAt).toBeNull();
    await bothEqualNuvion(me);
  });

  it('a failed fee-back that Nuvion cannot be read for, pass after pass, never starts a new reference or sends a request; once it can be read, exactly one new try follows', async () => {
    const { me, view } = await sendNuvionFails();
    const first = backRef(view.reference);
    failBudget = 1;
    modeAfter = 'successful';
    await giveFeeBack(view);
    expect(book.byReference(first)).toHaveLength(1);
    expect(book.byReference(first)[0].status).toBe('failed');
    expect(backPosts(view.reference)).toEqual([first]);

    // The failed record exists at Nuvion but cannot be read: the failure is
    // not proven, so nothing is sent, however many passes and however long.
    const readable = unreadable(book.byReference(first)[0].id);
    try {
      for (const ms of [
        2 * 60_000,
        2 * 60_000,
        30 * 60_000,
        3 * HOUR,
        10 * HOUR,
      ]) {
        await transfers.sweep(later(ms));
        expect(backPosts(view.reference)).toEqual([first]);
        expect(book.byReference(backRef2(view.reference))).toHaveLength(0);
        expect(backsInFlight(view.reference)).toBeLessThanOrEqual(1);
        expect((await rowOf(view.id)).nextCheckAt).not.toBeNull();
      }
      expect(available(me)).toBe(PERSON_START - WAWU_FEE);
      await bothEqualNuvion(me);
    } finally {
      readable();
    }

    // Readable again: its own record says failed, and the one new try follows.
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(backPosts(view.reference)).toEqual([
      first,
      backRef2(view.reference),
    ]);
    expect(backsOf(view.reference)).toHaveLength(2);
    expect(backsInFlight(view.reference)).toBe(0);
    expect(available(me)).toBe(PERSON_START);
    expect(await merchantRows(backRef2(view.reference), 'out')).toHaveLength(1);
    await bothEqualNuvion(me);
  });

  for (const word of ['pending', 'on_hold']) {
    it(`a fee transfer still in "${word}" a day after the send goes to a person: under review with a note, the fee still owed to the sender, nothing sent, out of the sweep (SWEEP-MONEY-4 round 2, F1)`, async () => {
      const { me, view } = await sendNuvionFails();
      const fee = `${view.reference}-fee`;
      const owing = available(me);
      expect(owing).toBe(PERSON_START - WAWU_FEE);
      wordOn(fee, word);
      // The default review bound (72 hours): only the day's own rule can act.
      const restore = reviewBound(72);
      try {
        await giveFeeBack(view);
        // Inside the day it is asked about, and kept in the sweep.
        for (const ms of [2 * 60_000, 30 * 60_000, 3 * HOUR]) {
          await transfers.sweep(later(ms));
        }
        const asking = await rowOf(view.id);
        expect(asking.nextCheckAt).not.toBeNull();
        expect(asking.reviewSince).toBeNull();
        expect(backPosts(view.reference)).toEqual([]);

        // Twenty-five hours after the send (the sweep's own clock).
        await transfers.sweep(later(25 * HOUR));
        const held = await rowOf(view.id);
        expect(held.reviewSince).not.toBeNull();
        expect(held.discrepancy).toContain(
          "WAWU's fee could not be given back",
        );
        expect(held.nextCheckAt).toBeNull();
        expect(held.status).toBe('failed');
        // Nothing was sent, and the fee is still owed: the sender is out the
        // fee at Nuvion, and WAWU's ledger equals the stand-in.
        expect(backPosts(view.reference)).toEqual([]);
        expect(backsOf(view.reference)).toHaveLength(0);
        expect(available(me)).toBe(owing);
        await ledgerEqualsNuvion();

        // Out of the sweep: a word Nuvion lists later moves nothing by itself,
        // the mark stays for the person, and the row is not written again.
        wordOn(fee, 'successful');
        for (let i = 0; i < 3; i += 1) await transfers.sweep(later(2 * HOUR));
        const after = await rowOf(view.id);
        expect(after.reviewSince?.getTime()).toBe(held.reviewSince!.getTime());
        expect(after.discrepancy).toBe(held.discrepancy);
        expect(after.nextCheckAt).toBeNull();
        expect(backPosts(view.reference)).toEqual([]);
        expect(available(me)).toBe(owing);
        await ledgerEqualsNuvion();
      } finally {
        restore();
      }
    });
  }

  it('a send is not completed as "WAWU\'s fee was not collected" while the fee transfer reads unfinished or in a word we do not know: it is asked again, and completes at the full figures once Nuvion says (SWEEP-MONEY-4 round 2, F2)', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    const fee = `${view.reference}-fee`;
    book.settle(fee, 'successful');
    await transfers.sweep(later(HALF_HOUR));
    expect(book.byReference(view.reference)).toHaveLength(1);
    // The send finishes at Nuvion while the fee transfer reads in a word we do
    // not know: the fee may have been taken, so the send does not complete.
    wordOn(fee, 'on_hold');
    book.settle(view.reference, 'successful');
    await transfers.sweep(later(HALF_HOUR));
    await transfers.sweep(later(HALF_HOUR));
    let row = await rowOf(view.id);
    expect(row.status).toBe('pending');
    expect(row.discrepancy ?? '').not.toContain('not collected');
    expect(row.nextCheckAt).not.toBeNull();
    expect(row.reviewSince).toBeNull();

    // Unfinished: the same, asked again.
    wordOn(fee, 'pending');
    await transfers.sweep(later(HALF_HOUR));
    row = await rowOf(view.id);
    expect(row.status).toBe('pending');
    expect(row.discrepancy ?? '').not.toContain('not collected');

    // Nuvion says the fee transfer finished: the send completes with its fee.
    wordOn(fee, 'successful');
    await transfers.sweep(later(HALF_HOUR));
    row = await rowOf(view.id);
    expect(row.status).toBe('completed');
    expect(row.discrepancy ?? '').not.toContain('not collected');
    expect(available(me)).toBe(PERSON_START - AMOUNT - WAWU_FEE - FEE);
    expect(available(to)).toBe(AMOUNT);
    await bothEqualNuvion(me);
  });

  it('a late reversal on a send more than a day old is asked about again after one unreadable look at the fee transfer: the day is counted from the reversal, not from the send (SWEEP-MONEY-5a, G1)', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const b = await prepare(me, to, AMOUNT);
    book.mode = 'successful';
    const view = body<TransferView>(await post(me, b)).data!;
    expect(view.status).toBe('completed');
    const fee = `${view.reference}-fee`;
    // The send is a day and a half old when Nuvion reverses it.
    const sent = new Date(Date.now() - 36 * HOUR);
    await prisma.walletTransfer.update({
      where: { id: view.id },
      data: { createdAt: sent, sentAt: sent, completedAt: sent },
    });
    const restore = reviewBound(72);
    const readable = unreadable(book.byReference(fee)[0].id);
    try {
      const reversed = book.settle(view.reference, 'reversed');
      expect((await deliver('outflows.refunded', reversed, me)).outcome).toBe(
        'done',
      );
      // The fee-back is looked at once, and the fee transfer cannot be read.
      expect(
        await waitFor(async () => {
          const r = await rowOf(view.id);
          return (
            r.status === 'reversed' &&
            (r.reviewSince !== null ||
              (r.nextCheckAt?.getTime() ?? 0) > Date.now() + 60_000)
          );
        }),
      ).toBe(true);
      const asking = await rowOf(view.id);
      expect(asking.reviewSince).toBeNull();
      expect(asking.nextCheckAt).not.toBeNull();
      expect(backPosts(view.reference)).toEqual([]);
    } finally {
      readable();
      restore();
    }
    // Readable again: the fee comes back, once, and the person is whole.
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(backPosts(view.reference)).toEqual([backRef(view.reference)]);
    expect(available(me)).toBe(PERSON_START);
    expect((await rowOf(view.id)).reviewSince).toBeNull();
    expect((await rowOf(view.id)).nextCheckAt).toBeNull();
    await bothEqualNuvion(me);
  });

  it('a send is not completed without a fee that was due while the fee transfer cannot be read: it is asked again, and completes at the full figures once it can be (SWEEP-MONEY-5a, G3)', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    const fee = `${view.reference}-fee`;
    book.settle(fee, 'successful');
    await transfers.sweep(later(HALF_HOUR));
    expect(book.byReference(view.reference)).toHaveLength(1);
    book.settle(view.reference, 'successful');
    const readable = unreadable(book.byReference(fee)[0].id);
    try {
      await transfers.sweep(later(HALF_HOUR));
      await transfers.sweep(later(HALF_HOUR));
      const row = await rowOf(view.id);
      expect(row.status).toBe('pending');
      expect(row.discrepancy ?? '').not.toContain('not collected');
      expect(row.nextCheckAt).not.toBeNull();
      expect(row.reviewSince).toBeNull();
    } finally {
      readable();
    }
    await transfers.sweep(later(HALF_HOUR));
    const done = await rowOf(view.id);
    expect(done.status).toBe('completed');
    expect(done.discrepancy ?? '').not.toContain('not collected');
    expect(available(me)).toBe(PERSON_START - AMOUNT - WAWU_FEE - FEE);
    expect(available(to)).toBe(AMOUNT);
    await bothEqualNuvion(me);
  });

  it('where no transfer of the fee was due, a fee lookup that finds nothing completes the send as before, and a failed send gives nothing back and never reaches a person (SWEEP-MONEY-5a, G3 and G2)', async () => {
    const restore = feeNeverDue();
    try {
      const me = await person(PERSON_START);
      const to = await person(0);
      const ok = body<TransferView>(
        await post(me, await prepare(me, to, AMOUNT)),
      ).data!;
      expect(book.byReference(`${ok.reference}-fee`)).toHaveLength(0);
      book.settle(ok.reference, 'successful');
      await transfers.sweep(later(HALF_HOUR));
      const completed = await rowOf(ok.id);
      expect(completed.status).toBe('completed');
      expect(completed.reviewSince).toBeNull();
      expect(completed.discrepancy ?? '').not.toContain('not collected');

      const bad = body<TransferView>(
        await post(me, await prepare(me, to, AMOUNT)),
      ).data!;
      const before = available(me);
      expect(book.byReference(`${bad.reference}-fee`)).toHaveLength(0);
      book.settle(bad.reference, 'failed');
      await giveFeeBack(bad);
      // Nothing was taken, so nothing is owed: closed at once, not asked for a day.
      expect((await rowOf(bad.id)).status).toBe('failed');
      expect((await rowOf(bad.id)).nextCheckAt).toBeNull();
      for (const ms of [2 * 60_000, 3 * HOUR, 25 * HOUR]) {
        await transfers.sweep(later(ms));
      }
      const after = await rowOf(bad.id);
      expect(after.reviewSince).toBeNull();
      expect(after.discrepancy ?? '').not.toContain('fee transfer');
      expect(after.nextCheckAt).toBeNull();
      expect(backPosts(bad.reference)).toEqual([]);
      expect(available(me)).toBe(before + AMOUNT + WAWU_FEE);
      // The ledger holds what Nuvion moved for the send that completed.
      await bothEqualNuvion(me);
    } finally {
      restore();
    }
  });

  it('a fee transfer that was due and cannot be found or read for a day goes to a person with a note that says so, never the note that it has not finished; nothing is sent and the fee stays owed (SWEEP-MONEY-5a, G2)', async () => {
    const { me, view } = await sendNuvionFails();
    const owing = available(me);
    expect(owing).toBe(PERSON_START - WAWU_FEE);
    const readable = unreadable(
      book.byReference(`${view.reference}-fee`)[0].id,
    );
    const restore = reviewBound(72);
    try {
      await giveFeeBack(view);
      for (const ms of [2 * 60_000, 30 * 60_000, 3 * HOUR]) {
        await transfers.sweep(later(ms));
      }
      const asking = await rowOf(view.id);
      expect(asking.nextCheckAt).not.toBeNull();
      expect(asking.reviewSince).toBeNull();

      await transfers.sweep(later(25 * HOUR));
      const held = await rowOf(view.id);
      expect(held.reviewSince).not.toBeNull();
      expect(held.discrepancy).toContain(
        'the fee transfer could not be found or read at',
      );
      expect(held.discrepancy).not.toContain('has not said whether');
      expect(held.nextCheckAt).toBeNull();
      expect(backPosts(view.reference)).toEqual([]);
      expect(available(me)).toBe(owing);
      await ledgerEqualsNuvion();

      // Out of the sweep and not written again.
      for (let i = 0; i < 3; i += 1) await transfers.sweep(later(2 * HOUR));
      const after = await rowOf(view.id);
      expect(after.reviewSince?.getTime()).toBe(held.reviewSince!.getTime());
      expect(after.discrepancy).toBe(held.discrepancy);
    } finally {
      readable();
      restore();
    }
  });

  // SWEEP-MONEY-5a round 2, F2: whether a fee transfer was due is what the send
  // recorded when it was made, never today's fee schedule.
  for (const recorded of [true, null] as const) {
    it(`a send whose fee transfer was made, the fee schedule changed after and the read fails (${recorded === null ? 'nothing recorded' : 'recorded as due'}): asked again for a day, then a person with the fee owed (SWEEP-MONEY-5a round 2, F2)`, async () => {
      const { me, view } = await sendNuvionFails();
      expect((await rowOf(view.id)).feeTransferDue).toBe(true);
      if (recorded === null) {
        await prisma.walletTransfer.update({
          where: { id: view.id },
          data: { feeTransferDue: null },
        });
      }
      const owing = available(me);
      expect(owing).toBe(PERSON_START - WAWU_FEE);
      const readable = unreadable(
        book.byReference(`${view.reference}-fee`)[0].id,
      );
      // After the send, the schedule changes: today no fee transfer is due.
      const scheduleBack = feeNeverDue();
      const restore = reviewBound(72);
      try {
        await giveFeeBack(view);
        for (const ms of [2 * 60_000, 30 * 60_000, 3 * HOUR]) {
          await transfers.sweep(later(ms));
        }
        const asking = await rowOf(view.id);
        expect(asking.status).toBe('failed');
        expect(asking.nextCheckAt).not.toBeNull();
        expect(asking.reviewSince).toBeNull();

        await transfers.sweep(later(25 * HOUR));
        const held = await rowOf(view.id);
        expect(held.reviewSince).not.toBeNull();
        expect(held.discrepancy).toContain(
          'the fee transfer could not be found or read at',
        );
        expect(held.nextCheckAt).toBeNull();
        expect(backPosts(view.reference)).toEqual([]);
        expect(available(me)).toBe(owing);
        await ledgerEqualsNuvion();
      } finally {
        readable();
        scheduleBack();
        restore();
      }
    });
  }

  it('a send recorded as having no fee transfer due closes at once when the schedule later says one is due: nobody is called and nothing is sent (SWEEP-MONEY-5a round 2, F2)', async () => {
    const scheduleBack = feeNeverDue();
    let me: Person;
    let bad: TransferView;
    let before = 0;
    try {
      me = await person(PERSON_START);
      const to = await person(0);
      bad = body<TransferView>(
        await post(me, await prepare(me, to, AMOUNT)),
      ).data!;
      expect((await rowOf(bad.id)).feeTransferDue).toBe(false);
      expect(book.byReference(`${bad.reference}-fee`)).toHaveLength(0);
      before = available(me);
      book.settle(bad.reference, 'failed');
    } finally {
      scheduleBack();
    }
    await giveFeeBack(bad);
    for (const ms of [2 * 60_000, 3 * HOUR, 25 * HOUR]) {
      await transfers.sweep(later(ms));
    }
    const after = await rowOf(bad.id);
    expect(after.status).toBe('failed');
    expect(after.nextCheckAt).toBeNull();
    expect(after.reviewSince).toBeNull();
    expect(after.discrepancy ?? '').not.toContain('fee transfer');
    expect(backPosts(bad.reference)).toEqual([]);
    expect(available(me)).toBe(before + AMOUNT + WAWU_FEE);
    await ledgerEqualsNuvion();
  });

  it('after every scenario of this spec WAWU operational ledger still equals Nuvion', async () => {
    await ledgerEqualsNuvion();
  });
});
