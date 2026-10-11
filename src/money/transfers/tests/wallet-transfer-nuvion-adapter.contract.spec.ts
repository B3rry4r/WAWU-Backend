import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
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
  PHONE_SHAPE,
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
import { NuvionClient } from '../../../nuvion/nuvion-client';
import {
  NuvionWalletProvider,
  nuvionAreas,
} from '../../../nuvion/nuvion-wallet-provider';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { MoneyModule } from '../../money.module';
import type { FeeQuoteView, TransferView } from '../../money-view.type';
import { WalletTransferService } from '../wallet-transfer.service';

/**
 * Send money to a WAWU user (WALLET-07) on the REAL Nuvion adapter and
 * NUV-05's book area, with Nuvion's stand-in over a socket
 * (test/nuvion/book-standin.ts, from Nuvion's published docs): a send is one
 * book transfer by the receiver's `nuvion_ban` under our reference, Nuvion's
 * first answer is `pending`, there is no lookup by our reference, a repeated
 * reference answers with the original. Nothing here reaches a Nuvion,
 * Fintava or wawuafrica.com host: every connection but loopback is refused
 * (outbound-guard.ts), and a counter stands where Fintava's base URL points.
 *
 * Nuvion's fee settings are spec values (NUV-10 fills the real ones); the
 * stand-in charges them together with WAWU's ₦10 in the one transfer, as a
 * provider whose own fee carries WAWU's does.
 */

const BASE = '/api/hub/money';
const FEE_BANDS = '0:1500,500000:2500';
const WAWU_FEE = 1000;
const bandFee = (amount: number) => (amount >= 500_000 ? 2_500 : 1_500);

jest.setTimeout(120_000);

let numberSeq = 0;
const nuban = () =>
  `7${String(Date.now()).slice(-6)}${String((numberSeq += 1)).padStart(3, '0')}`;

describe('Send to a WAWU user (WALLET-07) on the real Nuvion adapter and the book area (NUV-05)', () => {
  const standin = new NuvionStandin();
  const wawuId = new WawuIdDouble();
  const accounts = new NuvionAccountsStandin(standin);
  const book = new NuvionBookStandin(standin, accounts);
  const logger = new QuietLogger();
  let guard: OutboundGuard;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let transfers: WalletTransferService;
  let fintavaCounter: Server;
  const fintavaHits: string[] = [];
  const users: string[] = [];
  const seenTexts: string[] = [];
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
        accountName: `Nuvion Booker ${accountNumber}`,
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
        handle: `w07a-${id.slice(0, 8)}`,
      },
    });
    const auth = `Bearer ${mintToken(id)}`;
    const set = await request(app.getHttpServer())
      .post(`${BASE}/pin`)
      .set('Authorization', auth)
      .send({ pin: PIN, pinConfirmation: PIN });
    expect(set.status).toBe(201);
    return { id, auth, account };
  }

  async function send(
    p: Person,
    to: Person,
    amountKobo: number,
    key: string = randomUUID(),
  ) {
    const quote = await request(app.getHttpServer())
      .get(`${BASE}/fees/quote?kind=wawu_transfer&amountKobo=${amountKobo}`)
      .set('Authorization', p.auth);
    expect(quote.status).toBe(200);
    const q = body<FeeQuoteView>(quote).data!;
    const res = await request(app.getHttpServer())
      .post(`${BASE}/transfers/wawu`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send({
        recipientWawuUserId: to.id,
        amountKobo,
        expectedTotalKobo: q.totalKobo,
        quoteToken: q.quoteToken,
      });
    seenTexts.push(res.text);
    return res;
  }

  const states = async (reference: string) =>
    (
      await prisma.fintavaLedgerEntry.findMany({
        where: { customerReference: reference },
        orderBy: { direction: 'asc' },
      })
    ).map((r) => `${r.direction}:${r.status}`);

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
    book.feeKobo = (amount) => bandFee(amount) + WAWU_FEE;
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: `http://127.0.0.1:${port}`,
      FINTAVA_API_KEY: 'live_test_w07_adapter_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'w07-adapter-fee-quote-key-0123456789abcdef01',
      NUVION_FEE_BOOK_TRANSFER: FEE_BANDS,
      NUVION_FEE_BANK_PAYOUT: FEE_BANDS,
      NUVION_FEE_INFLOW: FEE_BANDS,
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
      'nv_test_sk_W07adapterKEY0000000000000000',
    );
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
      .useFactory({
        inject: [PrismaService],
        factory: (db: PrismaService) =>
          new NuvionWalletProvider(client, {
            ...nuvionAreas(client),
            // No wait inside the request: a transfer Nuvion has not finished
            // is pending, and the sweep or a delivery says (the wait is
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
    transfers = moduleRef.get(WalletTransferService);
  });

  afterAll(async () => {
    if (prisma) {
      const rows = await prisma.walletTransfer.findMany({
        where: { payerWawuUserId: { in: users } },
        select: { customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: rows.map((r) => r.customerReference) } },
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
        where: { reference: { in: rows.map((r) => r.customerReference) } },
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

  it("a send is one book transfer by the receiver's nuvion_ban: pending first, successful when Nuvion says so; the sweep completes it once; ₦2,000 to her, ₦2,000 plus both fees from me", async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const res = await send(me, to, 200_000);
    expect(res.status).toBe(201);
    const view = body<TransferView>(res).data!;
    expect(view.status).toBe('pending');
    const sent = book.byReference(view.reference);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      amount: 200_000,
      account_id: me.account.id,
      payment_type: 'book-transfer',
    });
    // Nuvion took it (the outflow left `available` at once); she waits for it.
    expect(book.availableOf(me.account.id)).toBe(1_000_000 - 200_000 - 2_500);
    expect(book.availableOf(to.account.id)).toBe(0);
    expect(await states(view.reference)).toEqual(['out:pending']);

    book.settle(view.reference, 'successful');
    await transfers.sweep(later());
    const done = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(done).toMatchObject({
      status: 'completed',
      provider: 'nuvion',
      discrepancy: null,
    });
    expect(Number(done.totalKobo)).toBe(202_500);
    expect(Number(done.providerFeeKobo)).toBe(1_500);
    expect(Number(done.wawuFeeKobo)).toBe(1_000);
    expect(book.availableOf(to.account.id)).toBe(200_000);
    expect(await states(view.reference)).toEqual([
      'in:completed',
      'out:completed',
    ]);
    // Never offered to Nuvion twice.
    expect(book.byReference(view.reference)).toHaveLength(1);
  });

  it("six taps at once with one key: one book transfer; a lost answer is found by the walk of the payer's transfers; a failed transfer fails the send", async () => {
    const me = await person(2_000_000);
    const to = await person(0);
    const key = randomUUID();
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => send(me, to, 200_000, key)),
    );
    for (const r of answers) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) {
        expect(body(r).reason?.code).toBe('idempotency_in_progress');
      }
    }
    const first = answers.find((r) => r.status === 201)!;
    const ref = body<TransferView>(first).data!.reference;
    expect(book.byReference(ref)).toHaveLength(1);
    expect(
      book.all().filter((x) => x.account_id === me.account.id),
    ).toHaveLength(1);

    // Nuvion takes the next one and the answer never reaches us.
    book.loseAnswerNext(true);
    const lost = body<TransferView>(await send(me, to, 100_000)).data!;
    expect(lost.status).toBe('pending');
    expect(book.byReference(lost.reference)).toHaveLength(1);
    book.settle(lost.reference, 'successful');
    await transfers.sweep(later());
    expect(
      (
        await prisma.walletTransfer.findUniqueOrThrow({
          where: { id: lost.id },
        })
      ).status,
    ).toBe('completed');
    expect(book.byReference(lost.reference)).toHaveLength(1);

    // Nuvion fails one it accepted: the send fails, the payer is given back.
    const failing = body<TransferView>(await send(me, to, 100_000)).data!;
    const before = book.availableOf(me.account.id);
    book.settle(failing.reference, 'failed');
    await transfers.sweep(later());
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: failing.id },
    });
    expect(row.status).toBe('failed');
    expect(book.availableOf(me.account.id)).toBe(before + 100_000 + 2_500);
    expect(await states(failing.reference)).toEqual(['out:failed']);
    expect(fintavaHits).toEqual([]);
    for (const t of seenTexts) expect(t).not.toMatch(PHONE_SHAPE);
  });
});
