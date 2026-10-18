import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  NuvionAccountsStandin,
  type StandinAccount,
} from '../../../../test/nuvion/accounts-standin';
import { NuvionBookStandin } from '../../../../test/nuvion/book-standin';
import { NuvionStandin } from '../../../../test/nuvion/nuvion-standin';
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
import { NuvionClient } from '../../../nuvion/nuvion-client';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { MoneyModule } from '../../money.module';
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
  const failFeeBacksWhileWaiting = (): Promise<void> => {
    for (const t of book.all()) {
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

  it('the sender fee row shows the fee as gone until a fee-back has landed, and turns reversed only then (FIX-70 round 2)', async () => {
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
    // The fee-back is made and not finished: the fee is still owed.
    expect((await feeRow()).status).toBe('completed');
    await senderLedgerEqualsNuvion(me);
    book.settle(backRef(view.reference), 'successful');
    await transfers.sweep(later());
    const turned = await feeRow();
    expect(turned.status).toBe('reversed');
    expect(turned.reversalReference).toBe(backRef(view.reference));
    expect(Number(turned.reversalTotalKobo)).toBe(WAWU_FEE);
    expect(available(me)).toBe(PERSON_START);
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

  it('after every scenario of this spec WAWU operational ledger still equals Nuvion', async () => {
    await ledgerEqualsNuvion();
  });
});
