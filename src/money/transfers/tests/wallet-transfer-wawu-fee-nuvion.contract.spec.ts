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
import { NuvionBookHandler } from '../../../nuvion/handlers/book.handler';
import { NuvionClient } from '../../../nuvion/nuvion-client';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyModule } from '../../money.module';
import type { FeeQuoteView, TransferView } from '../../money-view.type';
import { WalletTransferService } from '../wallet-transfer.service';

/**
 * WAWU's fee on a send is collected on Nuvion (FIX-52; R-10, R-42, R-39).
 *
 * Found by INBOX-15's second check: on the Nuvion stack a send's quote total
 * was 101,000 kobo and the person was debited 100,000, because Nuvion's
 * `applicable_fee` is Nuvion's own charge and carries nothing for WAWU.
 * Nuvion's transfer has no field for a fee of ours, so WAWU's fee is its own
 * book transfer from the sender to WAWU's operational account, under the
 * reference `<send reference>-fee`. It moves FIRST (round 2, lead ruling 17
 * Oct): a balance spent while the send is on its way can never evade it. If it
 * is refused nothing else moves; a send that then fails, or is reversed even
 * after it completed, gives the fee back under `<send reference>-fee-back`.
 *
 * The REAL Nuvion adapter and book area over Nuvion's stand-in (a socket);
 * nothing here reaches a Nuvion, Fintava or wawuafrica.com host (every
 * connection but loopback is refused, and a counter stands where Fintava's
 * base URL points).
 *
 * Nuvion charges `FEE` on every transfer here (the setting says the same).
 * WAWU's fee is ₦10; the book transfer that moves it costs `FEE` as well, so
 * it moves ₦10 less that charge and the person still pays exactly the quote.
 */

const BASE = '/api/hub/money';
const WAWU_FEE = 1000;
const FEE = 150;
const AMOUNT = 200_000;
const OPERATIONAL_START = 5_000_000;
const PERSON_START = 1_000_000;

jest.setTimeout(120_000);

let numberSeq = 0;
const nuban = () =>
  `6${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

describe('WAWU fee on a send to a WAWU user, collected on Nuvion (FIX-52)', () => {
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
        handle: `f52-${id.slice(0, 8)}`,
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
      quotedTotal: q.totalKobo,
    };
  }

  async function post(p: Person, payload: object, key: string = randomUUID()) {
    const wire = Object.fromEntries(
      Object.entries(payload).filter(([k]) => k !== 'quotedTotal'),
    );
    return request(app.getHttpServer())
      .post(`${BASE}/transfers/wawu`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send(wire);
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
   * What WAWU's ledger says its own (operational) account changed by (FIX-66):
   * every completed row on it since this spec began, in minus out.
   */
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
  const merchantRow = (reference: string, direction: 'in' | 'out') =>
    prisma.fintavaLedgerEntry.findMany({
      where: {
        customerReference: reference,
        walletKind: 'merchant',
        direction,
      },
    });
  const deliver = async (
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
  /** The order Nuvion made its transfers in (the stand-in keeps it). */
  const madeBefore = (first: string, second: string) => {
    const refs = book.all().map((t) => t.unique_reference);
    return (
      refs.indexOf(first) >= 0 && refs.indexOf(first) < refs.indexOf(second)
    );
  };
  const rowOf = (id: string) =>
    prisma.walletTransfer.findUniqueOrThrow({ where: { id } });
  const ledgerOut = (reference: string) =>
    prisma.fintavaLedgerEntry.findFirstOrThrow({
      where: { customerReference: reference, direction: 'out' },
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
    book.fundOperational(OPERATIONAL_START);
    // Nuvion's own charge on every transfer, and nothing of WAWU's in it.
    book.feeKobo = () => FEE;
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_f52_adapter_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'f52-adapter-fee-quote-key-0123456789abcdef01',
      NUVION_FEE_BOOK_TRANSFER: String(FEE),
      NUVION_FEE_BANK_PAYOUT: String(FEE),
      NUVION_FEE_INFLOW: String(FEE),
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
      'nv_test_sk_F52adapterKEY0000000000000000',
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
    await new Promise<void>((r) => fintavaCounter.close(() => r()));
    guard.restore();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    book.mode = 'pending';
  });

  it('the fee moves BEFORE the send; the person is debited exactly the quote, WAWU gets the fee once, and replays, parallel taps, sweeps and settling again move nothing more', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    expect(b.quotedTotal).toBe(AMOUNT + FEE + WAWU_FEE);
    book.mode = 'successful';

    const key = randomUUID();
    const taps = await Promise.all([post(me, b, key), post(me, b, key)]);
    const res = taps[0];
    expect(res.status).toBe(201);
    const view = body<TransferView>(res).data!;
    expect(view.status).toBe('completed');
    expect(madeBefore(`${view.reference}-fee`, view.reference)).toBe(true);
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect(available(to)).toBe(AMOUNT);
    expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
    const done = await rowOf(view.id);
    expect(done).toMatchObject({ status: 'completed', discrepancy: null });
    expect(Number(done.totalKobo)).toBe(b.quotedTotal);
    // The ledger holds what Nuvion moved, as the quote says it.
    const out = await ledgerOut(view.reference);
    expect(Number(out.totalKobo)).toBe(b.quotedTotal);
    expect(Number(out.feeKobo)).toBe(FEE + WAWU_FEE);
    expect(Number(out.wawuFeeKobo)).toBe(WAWU_FEE);
    expect(await ledgerNet(me)).toBe(-(PERSON_START - available(me)));

    const replay = await post(me, b, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    await transfers.sweep(later());
    await transfers.settle(view.id, later(), true);
    await transfers.settle(view.id, later(), false);
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(book.byReference(view.reference)).toHaveLength(1);
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
  });

  it('finding 1: a balance spent between two sends cannot evade the fee: the send that cannot be paid fails whole and its fee comes back', async () => {
    const quoteEach = AMOUNT + FEE + WAWU_FEE;
    // Enough for two sends' amounts and charges and ONE fee: the old order
    // accepted both sends and collected one fee.
    const me = await person(2 * (AMOUNT + FEE) + WAWU_FEE);
    const to = await person(0);
    const opBefore = operational();
    const b1 = await prepare(me, to, AMOUNT);
    const b2 = await prepare(me, to, AMOUNT);
    const one = body<TransferView>(await post(me, b1)).data!;
    const two = body<TransferView>(await post(me, b2)).data!;
    // Both wait on their fee; nothing is sent yet.
    expect(one.status).toBe('pending');
    expect(two.status).toBe('pending');
    expect(book.byReference(one.reference)).toHaveLength(0);
    expect(book.byReference(two.reference)).toHaveLength(0);
    book.settle(`${one.reference}-fee`, 'successful');
    book.settle(`${two.reference}-fee`, 'successful');
    await transfers.sweep(later());
    // Only one of the sends can be paid; the other is refused by Nuvion.
    const sent = [one, two].filter((v) => book.byReference(v.reference).length);
    expect(sent).toHaveLength(1);
    book.settle(sent[0].reference, 'successful');
    for (const v of [one, two]) {
      if (feeBacks(v.reference).length) {
        book.settle(`${v.reference}-fee-back`, 'successful');
      }
    }
    book.mode = 'successful';
    await transfers.sweep(later());
    await transfers.sweep(later());
    const rows = [await rowOf(one.id), await rowOf(two.id)];
    expect(rows.map((r) => r.status).sort()).toEqual(['completed', 'failed']);
    const failed = rows.find((r) => r.status === 'failed')!;
    // The fee of the send that did not go is back; the other paid its own.
    expect(feeBacks(failed.customerReference)).toHaveLength(1);
    expect(2 * (AMOUNT + FEE) + WAWU_FEE - available(me)).toBe(quoteEach);
    expect(await ledgerNet(me)).toBe(-quoteEach);
    // Both fees reached WAWU; the one given back cost the return and Nuvion's charge on it.
    expect(operational() - opBefore).toBe(
      2 * (WAWU_FEE - FEE) - (WAWU_FEE + FEE),
    );
    expect(available(to)).toBe(AMOUNT);
  });

  it('a fee Nuvion has accepted and not finished keeps the send waiting with nothing sent, is not made twice, and the send goes on once the fee is finished', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    expect(view.status).toBe('pending');
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(book.byReference(view.reference)).toHaveLength(0);
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(book.byReference(view.reference)).toHaveLength(0);
    expect((await rowOf(view.id)).status).toBe('pending');

    book.settle(`${view.reference}-fee`, 'successful');
    await transfers.sweep(later(60 * 60_000));
    expect(book.byReference(view.reference)).toHaveLength(1);
    book.settle(view.reference, 'successful');
    await transfers.sweep(later(60 * 60_000));
    expect((await rowOf(view.id)).status).toBe('completed');
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(book.byReference(view.reference)).toHaveLength(1);
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
  });

  it('finding 3: a fee Nuvion fails stops the send before anything else moves: nothing is sent, the person is whole and told', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    book.settle(`${view.reference}-fee`, 'failed');
    await transfers.sweep(later());
    const row = await rowOf(view.id);
    expect(row.status).toBe('failed');
    expect(book.byReference(view.reference)).toHaveLength(0);
    expect(feeBacks(view.reference)).toHaveLength(0);
    expect(available(me)).toBe(PERSON_START);
    expect(operational()).toBe(opBefore);
    expect(await ledgerNet(me)).toBe(0);
    const told = await request(app.getHttpServer())
      .get(`${BASE}/transfers/${view.id}`)
      .set('Authorization', me.auth);
    expect(body<TransferView>(told).data!.status).toBe('failed');
  });

  it('a send Nuvion fails after the fee moved gives the fee back: the person is whole, and the fee comes back once however often it is swept', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    book.settle(`${view.reference}-fee`, 'successful');
    await transfers.sweep(later());
    book.settle(view.reference, 'failed');
    book.mode = 'successful';
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('failed');
    expect(feeBacks(view.reference)).toHaveLength(1);
    expect(available(me)).toBe(PERSON_START);
    expect(available(to)).toBe(0);
    expect(await ledgerNet(me)).toBe(0);
  });

  it('finding 4: a completed send Nuvion reverses later gives WAWU fee back too, and the send says reversed', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const b = await prepare(me, to, AMOUNT);
    book.mode = 'successful';
    const view = body<TransferView>(await post(me, b)).data!;
    expect(view.status).toBe('completed');
    const sent = book.settle(view.reference, 'reversed');
    const result = await deliver('outflows.refunded', sent, me);
    expect(result.outcome).toBe('done');
    // The ledger's own event settles the send; settling again is harmless.
    await waitFor(async () => (await rowOf(view.id)).status === 'reversed');
    await transfers.settle(view.id, later(), false);
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('reversed');
    expect(feeBacks(view.reference)).toHaveLength(1);
    expect(available(me)).toBe(PERSON_START);
    expect(available(to)).toBe(0);
    const read = await request(app.getHttpServer())
      .get(`${BASE}/transfers/${view.id}`)
      .set('Authorization', me.auth);
    expect(body<TransferView>(read).data!.status).toBe('reversed');
  });

  it('finding 5: the delivery of the fee transfer wakes the send at once, without waiting for the sweep', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    expect(book.byReference(view.reference)).toHaveLength(0);
    const fee = book.settle(`${view.reference}-fee`, 'successful');
    const result = await deliver('outflows.completed', fee, me);
    expect(result.outcome).toBe('done');
    expect(
      await waitFor(() => book.byReference(view.reference).length === 1),
    ).toBe(true);

    // The send's own delivery writes the ledger row at what Nuvion moved, the
    // fee's transfer included, which is what the quote says.
    const sendTx = book.settle(view.reference, 'successful');
    const completed = await deliver('outflows.completed', sendTx, me);
    expect(completed.outcome).toBe('done');
    const out = await ledgerOut(view.reference);
    expect(out.status).toBe('completed');
    expect(Number(out.totalKobo)).toBe(b.quotedTotal);
    expect(Number(out.wawuFeeKobo)).toBe(WAWU_FEE);
    expect(await ledgerNet(me)).toBe(-(PERSON_START - available(me)));
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
  });

  it('finding 2: the ledger holds what Nuvion moved on the delivery path too: a send whose fee never moved is written at the send alone', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    // A send already on its way when the fee came first (the book transfer
    // went out under the old order): its fee was never moved.
    const id = randomUUID();
    const reference = `wawu-send-${id}`;
    const total = AMOUNT + FEE + WAWU_FEE;
    const row = await prisma.walletTransfer.create({
      data: {
        id,
        kind: 'wawu_user',
        payerWawuUserId: me.id,
        recipientWawuUserId: to.id,
        amountKobo: BigInt(AMOUNT),
        providerFeeKobo: BigInt(FEE),
        wawuFeeKobo: BigInt(WAWU_FEE),
        totalKobo: BigInt(total),
        customerReference: reference,
        payerAccountNumber: me.accountNumber,
        recipientAccountNumber: to.accountNumber,
        provider: 'nuvion',
        status: 'pending',
        nextCheckAt: new Date(),
        sentAt: new Date(),
      },
    });
    const movement = (
      transfers as unknown as {
        movement: (t: unknown, side: string, status: string) => never;
      }
    ).movement.bind(transfers);
    await moduleRef.get(LedgerService).record(movement(row, 'out', 'pending'));
    await moduleRef.get(LedgerService).record(movement(row, 'in', 'pending'));
    book.mode = 'successful';
    const provider = moduleRef.get<NuvionWalletProvider>(WALLET_PROVIDER);
    await provider.walletToWallet({
      fromAccountNumber: me.accountNumber,
      toAccountNumber: to.accountNumber,
      amountKobo: BigInt(AMOUNT),
      reference,
    });
    const sent = book.byReference(reference)[0];
    const delivered = await deliver('outflows.completed', sent, me);
    expect(delivered).toMatchObject({ outcome: 'done' });
    // The ledger will not complete its row at a charge other than the one
    // quoted (it keeps it pending and notes it); the send settles it at what
    // Nuvion moved, and the fee is not moved after the fact.
    await transfers.settle(id, later(), false);
    await transfers.settle(id, later(), true);
    const out = await ledgerOut(reference);
    expect(out.status).toBe('completed');
    expect(Number(out.totalKobo)).toBe(AMOUNT + FEE);
    expect(await ledgerNet(me)).toBe(-(PERSON_START - available(me)));
    const done = await rowOf(id);
    expect(done.status).toBe('completed');
    expect(Number(done.totalKobo)).toBe(AMOUNT + FEE);
    expect(done.discrepancy).toMatch(/WAWU/);
    // The fee is not moved after the fact.
    expect(feeLegs(reference)).toHaveLength(0);
    expect(operational()).toBe(opBefore);
    expect(fintavaHits).toEqual([]);
  });

  it('FIX-66 F2: after sends the operational account ledger equals Nuvion exactly: the fee leg writes its row, once however often it is swept', async () => {
    const me = await person(5 * PERSON_START);
    const to = await person(0);
    book.mode = 'successful';
    const sent: TransferView[] = [];
    for (let i = 0; i < 3; i += 1) {
      const b = await prepare(me, to, AMOUNT);
      const view = body<TransferView>(await post(me, b)).data!;
      expect(view.status).toBe('completed');
      sent.push(view);
    }
    for (const view of sent) {
      // The fee transfer's money came into WAWU's account: one row, at what it moved.
      const rows = await merchantRow(`${view.reference}-fee`, 'in');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'completed',
        category: 'transfer',
        walletKind: 'merchant',
        wawuUserId: null,
      });
      expect(Number(rows[0].totalKobo)).toBe(WAWU_FEE - FEE);
      expect(await merchantRow(`${view.reference}-fee-back`, 'out')).toEqual(
        [],
      );
    }
    await transfers.sweep(later());
    await transfers.settle(sent[0].id, later(), true);
    expect(await merchantRow(`${sent[0].reference}-fee`, 'in')).toHaveLength(1);
    // Hub = Nuvion = ledger for WAWU's account, after all the sends of this spec.
    expect(await operationalLedgerNet()).toBe(
      operational() - OPERATIONAL_START,
    );
    expect(await ledgerNet(me)).toBe(-(5 * PERSON_START - available(me)));
  });

  it('FIX-66 F2: a send that fails after its fee moved reverses the fee leg in the ledger as the money is reversed', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const ledgerBefore = await operationalLedgerNet();
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    book.settle(`${view.reference}-fee`, 'successful');
    await transfers.sweep(later());
    expect(await merchantRow(`${view.reference}-fee`, 'in')).toHaveLength(1);
    book.settle(view.reference, 'failed');
    book.mode = 'successful';
    await transfers.sweep(later());
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('failed');
    expect(feeBacks(view.reference)).toHaveLength(1);
    // The fee came in (the amount it moved) and went back (what it moved
    // and Nuvion's charge on the way back, which is WAWU's): both rows are
    // there, once, and the ledger moved as Nuvion's balance did.
    const inRows = await merchantRow(`${view.reference}-fee`, 'in');
    const outRows = await merchantRow(`${view.reference}-fee-back`, 'out');
    expect(inRows).toHaveLength(1);
    expect(outRows).toHaveLength(1);
    expect(Number(inRows[0].totalKobo)).toBe(WAWU_FEE - FEE);
    expect(outRows[0]).toMatchObject({
      status: 'completed',
      category: 'refund',
    });
    expect(Number(outRows[0].amountKobo)).toBe(WAWU_FEE);
    expect(Number(outRows[0].feeKobo)).toBe(FEE);
    expect(Number(outRows[0].totalKobo)).toBe(WAWU_FEE + FEE);
    expect(operational() - opBefore).toBe(-2 * FEE);
    expect((await operationalLedgerNet()) - ledgerBefore).toBe(-2 * FEE);
    expect(await operationalLedgerNet()).toBe(
      operational() - OPERATIONAL_START,
    );
    expect(available(me)).toBe(PERSON_START);
    expect(await ledgerNet(me)).toBe(0);
  });

  it('FIX-66 F2: a completed send Nuvion reverses later: the fee leg and the fee back are both in the operational ledger, and it equals Nuvion', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const b = await prepare(me, to, AMOUNT);
    book.mode = 'successful';
    const view = body<TransferView>(await post(me, b)).data!;
    expect(view.status).toBe('completed');
    const sent = book.settle(view.reference, 'reversed');
    await deliver('outflows.refunded', sent, me);
    await waitFor(async () => (await rowOf(view.id)).status === 'reversed');
    await transfers.sweep(later());
    await transfers.sweep(later());
    expect(feeBacks(view.reference)).toHaveLength(1);
    expect(await merchantRow(`${view.reference}-fee`, 'in')).toHaveLength(1);
    expect(await merchantRow(`${view.reference}-fee-back`, 'out')).toHaveLength(
      1,
    );
    expect(await operationalLedgerNet()).toBe(
      operational() - OPERATIONAL_START,
    );
    expect(available(me)).toBe(PERSON_START);
  });

  it('FIX-66 F2: after every scenario of this spec (a fee that waited, a fee Nuvion failed, a balance spent, a delivery first) the operational ledger still equals Nuvion', async () => {
    expect(await operationalLedgerNet()).toBe(
      operational() - OPERATIONAL_START,
    );
    expect(fintavaHits).toEqual([]);
  });
});
