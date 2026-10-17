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
 * reference `<send reference>-fee`, once the send itself is confirmed (a send
 * that fails or is reversed never has one, so there is nothing to give back).
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

  it('the person is debited exactly the quoted total and WAWU fee lands in the operational account once, however often the send is replayed, swept or settled again', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    expect(b.quotedTotal).toBe(AMOUNT + FEE + WAWU_FEE);

    const key = randomUUID();
    const res = await post(me, b, key);
    expect(res.status).toBe(201);
    const view = body<TransferView>(res).data!;
    expect(view.status).toBe('pending');
    // Accepted by Nuvion: only the send itself has left her balance so far.
    expect(available(me)).toBe(PERSON_START - AMOUNT - FEE);
    expect(feeLegs(view.reference)).toHaveLength(0);

    // Nuvion finishes the send; the fee follows it, and Nuvion answers that at once.
    book.settle(view.reference, 'successful');
    book.mode = 'successful';
    await transfers.sweep(later());
    const done = await rowOf(view.id);
    expect(done).toMatchObject({ status: 'completed', discrepancy: null });
    expect(Number(done.totalKobo)).toBe(b.quotedTotal);
    expect(Number(done.providerFeeKobo)).toBe(FEE);
    expect(Number(done.wawuFeeKobo)).toBe(WAWU_FEE);

    // The person is debited the quote, to the kobo.
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect(available(to)).toBe(AMOUNT);
    // WAWU's fee, less what Nuvion charged to move it, is in the operational account.
    expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
    expect(feeLegs(view.reference)).toHaveLength(1);
    // The ledger row and the receipt say the fee as quoted.
    const out = await ledgerOut(view.reference);
    expect(Number(out.totalKobo)).toBe(b.quotedTotal);
    expect(Number(out.feeKobo)).toBe(FEE + WAWU_FEE);
    expect(Number(out.wawuFeeKobo)).toBe(WAWU_FEE);

    // Replays and retries move nothing more.
    const replay = await post(me, b, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    await transfers.sweep(later());
    await transfers.settle(view.id, later(), true);
    await transfers.settle(view.id, later(), false);
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(book.byReference(view.reference)).toHaveLength(1);
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
  });

  it('a send Nuvion fails never has a fee: nothing reaches the operational account and the person is whole', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    book.settle(view.reference, 'failed');
    book.mode = 'successful';
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('failed');
    expect(feeLegs(view.reference)).toHaveLength(0);
    expect(available(me)).toBe(PERSON_START);
    expect(operational()).toBe(opBefore);
  });

  it('a send Nuvion reverses never has a fee either', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    book.settle(view.reference, 'successful');
    book.settle(view.reference, 'reversed');
    book.mode = 'successful';
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('reversed');
    expect(feeLegs(view.reference)).toHaveLength(0);
    expect(available(me)).toBe(PERSON_START);
    expect(operational()).toBe(opBefore);
  });

  it('a fee Nuvion has accepted and not finished keeps the send pending, is not made twice, and completes the send once Nuvion finishes it', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    book.settle(view.reference, 'successful');
    // The fee's transfer is accepted as pending and stays so.
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('pending');
    expect(feeLegs(view.reference)).toHaveLength(1);
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('pending');
    expect(feeLegs(view.reference)).toHaveLength(1);

    book.settle(`${view.reference}-fee`, 'successful');
    await transfers.sweep(later());
    expect((await rowOf(view.id)).status).toBe('completed');
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
  });

  it('a send Nuvion completes by its delivery: the ledger row holds the fee as quoted at once, and the send completes with the fee moved once', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    book.settle(view.reference, 'successful');
    book.mode = 'successful';
    const sent = book.byReference(view.reference)[0];
    const result = await new NuvionBookHandler(
      prisma,
      moduleRef.get(ModuleRef),
    ).handle({
      id: randomUUID(),
      eventId: randomUUID(),
      event: 'outflows.completed',
      resourceId: sent.id,
      entityId: me.account.entity_id,
      data: sent,
      receivedAt: new Date(),
      attempts: 1,
    });
    expect(result.outcome).toBe('done');
    const out = await ledgerOut(view.reference);
    expect(out.status).toBe('completed');
    expect(Number(out.totalKobo)).toBe(b.quotedTotal);
    expect(Number(out.feeKobo)).toBe(FEE + WAWU_FEE);
    expect(Number(out.providerFeeKobo)).toBe(FEE);
    expect(Number(out.wawuFeeKobo)).toBe(WAWU_FEE);
    // The ledger's own event settles the send; the sweep finishes it if that raced.
    for (let i = 0; i < 3; i += 1) {
      if ((await rowOf(view.id)).status === 'completed') break;
      await transfers.sweep(later());
    }
    const done = await rowOf(view.id);
    expect(done).toMatchObject({ status: 'completed', discrepancy: null });
    expect(Number(done.totalKobo)).toBe(b.quotedTotal);
    expect(feeLegs(view.reference)).toHaveLength(1);
    expect(PERSON_START - available(me)).toBe(b.quotedTotal);
    expect(operational() - opBefore).toBe(WAWU_FEE - FEE);
  });

  it("a send to a bank, completed from the ledger row the bank handler wrote at the quoted figures, moves WAWU's ₦25 once", async () => {
    const me = await person(PERSON_START);
    const opBefore = operational();
    const bankFee = 2500;
    const id = randomUUID();
    const total = AMOUNT + FEE + bankFee;
    const row = await prisma.walletTransfer.create({
      data: {
        id,
        kind: 'bank_account',
        payerWawuUserId: me.id,
        bankCode: '058',
        bankName: 'Test Bank',
        bankAccountNumber: '0123456789',
        bankAccountName: 'Test Holder',
        amountKobo: BigInt(AMOUNT),
        providerFeeKobo: BigInt(FEE),
        wawuFeeKobo: BigInt(bankFee),
        totalKobo: BigInt(total),
        customerReference: `wawu-bank-${id}`,
        payerAccountNumber: me.accountNumber,
        provider: 'nuvion',
        status: 'pending',
        nextCheckAt: new Date(),
        sentAt: new Date(),
      },
    });
    const ledger = moduleRef.get(LedgerService);
    const movement = (
      transfers as unknown as {
        movement: (t: unknown, side: string, status: string) => never;
      }
    ).movement.bind(transfers);
    await ledger.record(movement(row, 'out', 'pending'));
    await ledger.record(movement(row, 'out', 'completed'));
    // The payout itself is Nuvion's; only the fee is ours to move.
    book.mode = 'successful';
    await transfers.settle(id, later(), false);
    await transfers.settle(id, later(), true);
    const done = await rowOf(id);
    expect(done).toMatchObject({ status: 'completed', discrepancy: null });
    expect(Number(done.totalKobo)).toBe(total);
    expect(Number(done.wawuFeeKobo)).toBe(bankFee);
    expect(feeLegs(row.customerReference)).toHaveLength(1);
    expect(PERSON_START - available(me)).toBe(bankFee);
    expect(operational() - opBefore).toBe(bankFee - FEE);
  });

  it('a person who spent the fee in between is debited what really left, the send completes below the quote and says so, and no fee reaches WAWU', async () => {
    const me = await person(PERSON_START);
    const to = await person(0);
    const opBefore = operational();
    const b = await prepare(me, to, AMOUNT);
    const view = body<TransferView>(await post(me, b)).data!;
    book.settle(view.reference, 'successful');
    accounts.accounts.get(me.account.id)!.balance.available = 0;
    book.mode = 'successful';
    await transfers.sweep(later());
    const done = await rowOf(view.id);
    expect(done.status).toBe('completed');
    expect(Number(done.totalKobo)).toBe(AMOUNT + FEE);
    expect(done.discrepancy).toMatch(/WAWU/);
    expect(feeLegs(view.reference)).toHaveLength(0);
    expect(operational()).toBe(opBefore);
    expect(fintavaHits).toEqual([]);
  });
});
