import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test, type TestingModule } from '@nestjs/testing';
import * as argon2 from 'argon2';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import {
  type NuvionAccount,
  NuvionSeamStandIn,
} from '../../../../test/payments/nuvion-seam-standin';
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
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { BALANCE_CHANGED_MESSAGE } from '../../insufficient-funds';
import { LIMIT_REACHED_MESSAGES } from '../../limits/limit-reached';
import { MoneyModule } from '../../money.module';
import type { FeeQuoteView, TransferView } from '../../money-view.type';
import { WalletTransferService } from '../wallet-transfer.service';

/**
 * Send money to a WAWU user (WALLET-07) on the provider seam with NUVION
 * stood in (the Nuvion sandbox key does not work yet; NUV-05's book area is
 * being built beside this task). The stand-in behaves the way Nuvion's PUBLIC
 * DOCS say its API does (test/payments/nuvion-seam-standin.ts): a transfer's
 * first answer is `pending`, a repeated reference answers 409 with the
 * original, there is no lookup by our reference, `applicable_fee` is charged
 * on top. No Fintava host is called (a counter proves it).
 *
 * Nuvion's fee settings are set to ₦23.25 (a spec value, not a fact about
 * Nuvion); WAWU's ₦10 is on top, and the stand-in charges the two together
 * in the one transfer, as a provider whose dashboard carries WAWU's charge
 * does.
 */

const BASE = '/api/hub/money/transfers';
/** Nuvion's book-transfer fee as a spec value; WAWU's R-10 fee of ₦10 is on top. */
const NUVION_FEES = '2325';
const FEE_TOTAL = 3325n;
const PER_TXN_LIMIT_KOBO = 1_000_000;

jest.setTimeout(300_000);

describe('Send to a WAWU user (WALLET-07) on the provider seam, Nuvion stood in', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let transfers: WalletTransferService;
  let cheapPinHash: string;
  const nuvion = new NuvionSeamStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const seenTexts: string[] = [];
  const fintavaHits: string[] = [];
  let fintavaCounter: Server;
  let accountSeq = 0;
  let clock = Date.now();
  const sweepLater = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return transfers.sweep(new Date(clock));
  };

  type Person = { id: string; auth: string; account: NuvionAccount };

  async function person(kobo: number): Promise<Person> {
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
        accountName: `Nuvion Tester ${accountSeq}`,
        provider: 'nuvion',
      },
    });
    await prisma.userProfile.create({
      data: {
        wawuUserId: id,
        accountType: 'user',
        handle: `w07n-${id.slice(0, 8)}`,
      },
    });
    await prisma.transactionPin.create({
      data: { wawuUserId: id, pinHash: cheapPinHash },
    });
    return { id, auth: `Bearer ${mintToken(id)}`, account };
  }

  const track = (res: Response): Response => {
    seenTexts.push(res.text);
    return res;
  };

  async function quoted(p: Person, amountKobo: number): Promise<FeeQuoteView> {
    const res = track(
      await request(app.getHttpServer())
        .get(
          `/api/hub/money/fees/quote?kind=wawu_transfer&amountKobo=${amountKobo}`,
        )
        .set('Authorization', p.auth),
    );
    expect(res.status).toBe(200);
    return body<FeeQuoteView>(res).data!;
  }

  function send(p: Person, payload: object, key: string = randomUUID()) {
    return request(app.getHttpServer())
      .post(`${BASE}/wawu`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', key)
      .set('X-Transaction-Pin', PIN)
      .send(payload)
      .then(track);
  }

  async function ready(p: Person, to: Person, amountKobo: number) {
    const q = await quoted(p, amountKobo);
    nuvion.feeKobo = () => FEE_TOTAL;
    return {
      recipientWawuUserId: to.id,
      amountKobo,
      expectedTotalKobo: q.totalKobo,
      quoteToken: q.quoteToken,
    };
  }

  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account.accountId);
  const available = (p: Person) =>
    nuvion.accounts.get(p.account.accountId)!.availableKobo;
  const ledgerRows = (reference: string) =>
    prisma.fintavaLedgerEntry.findMany({
      where: { customerReference: reference },
      orderBy: { direction: 'asc' },
    });
  const read = (p: Person, id: string) =>
    request(app.getHttpServer())
      .get(`${BASE}/${id}`)
      .set('Authorization', p.auth)
      .then(track);
  const states = async (reference: string) =>
    (await ledgerRows(reference)).map((r) => `${r.direction}:${r.status}`);

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
      FINTAVA_API_KEY: 'live_test_w07_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'w07-nuvion-fee-quote-key-0123456789abcdef01',
      NUVION_FEE_BOOK_TRANSFER: NUVION_FEES,
      NUVION_FEE_BANK_PAYOUT: NUVION_FEES,
      NUVION_FEE_INFLOW: NUVION_FEES,
      WAWU_LIMIT_WAWU_TRANSFER_PER_TRANSACTION_KOBO: String(PER_TXN_LIMIT_KOBO),
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
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
    transfers = moduleRef.get(WalletTransferService);
  });

  afterAll(async () => {
    if (prisma) {
      const rows = await prisma.walletTransfer.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { recipientWawuUserId: { in: users } },
          ],
        },
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
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.userProfile.deleteMany({
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
    jest.restoreAllMocks();
  });

  it("Nuvion's first answer is pending: the send is pending (never sent again, never failed); once Nuvion says successful the sweep completes it, ₦2,000 to her and ₦2,033.25 from me", async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const res = await send(me, b);
    expect(res.status).toBe(201);
    const pending = body<TransferView>(res).data!;
    expect(pending).toMatchObject({ status: 'pending', completedAt: null });
    expect(pending.statusMessage).toMatch(/still confirming/);
    // Nuvion took it (the outflow left `available` at once); she waits for it.
    expect(sendsFrom(me)).toHaveLength(1);
    expect(available(me)).toBe(1_000_000n - 200_000n - FEE_TOTAL);
    expect(available(to)).toBe(0n);
    expect(await states(pending.reference)).toEqual(['out:pending']);

    // Still pending at the first sweep: Nuvion has not finished it.
    await sweepLater();
    expect(body<TransferView>(await read(me, pending.id)).data!.status).toBe(
      'pending',
    );
    nuvion.settle(pending.reference, 'successful');
    await sweepLater();
    const done = body<TransferView>(await read(me, pending.id)).data!;
    expect(done).toMatchObject({
      status: 'completed',
      amountKobo: 200_000,
      totalKobo: 203_325,
      fee: { providerFeeKobo: 2325, wawuFeeKobo: 1000, totalFeeKobo: 3325 },
      statusMessage: null,
    });
    expect(available(to)).toBe(200_000n);
    expect(await states(pending.reference)).toEqual([
      'in:completed',
      'out:completed',
    ]);
    // The same send was never offered to Nuvion twice.
    expect(
      nuvion.calls.filter(
        (c) =>
          c.method === 'walletToWallet' &&
          (c.args as { reference: string }).reference === pending.reference,
      ),
    ).toHaveLength(1);
    expect(sendsFrom(me)).toHaveLength(1);
  });

  it('a transfer Nuvion reports successful in its answer completes at once, at the fee Nuvion took', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    nuvion.mode = 'successful';
    const view = body<TransferView>(await send(me, b)).data!;
    expect(view).toMatchObject({ status: 'completed', totalKobo: 203_325 });
    expect(available(to)).toBe(200_000n);
    expect(await states(view.reference)).toEqual([
      'in:completed',
      'out:completed',
    ]);
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row.discrepancy).toBeNull();
    expect(row.provider).toBe('nuvion');
  });

  it("a lost answer (Nuvion took it, nothing came back) is pending; the sweep walks the sender's transfers for our reference and settles it once", async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    nuvion.mode = 'timeout';
    const res = await send(me, b, key);
    nuvion.mode = 'pending';
    const pending = body<TransferView>(res).data!;
    expect(pending.status).toBe('pending');
    expect(sendsFrom(me)).toHaveLength(1);
    expect((await send(me, b, key)).text).toBe(res.text);
    nuvion.settle(pending.reference, 'successful');
    await sweepLater();
    expect(body<TransferView>(await read(me, pending.id)).data!.status).toBe(
      'completed',
    );
    expect(sendsFrom(me)).toHaveLength(1);
    expect(available(to)).toBe(200_000n);
  });

  it('Nuvion failing or reversing a transfer it accepted: failed or reversed, the sender row says so, nothing for the receiver', async () => {
    const me = await person(2_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const failing = body<TransferView>(await send(me, b)).data!;
    nuvion.settle(failing.reference, 'failed');
    await sweepLater();
    expect(body<TransferView>(await read(me, failing.id)).data!).toMatchObject({
      status: 'failed',
      failureReason: expect.stringMatching(
        /No money left your wallet/,
      ) as unknown,
    });
    expect(await states(failing.reference)).toEqual(['out:failed']);
    expect(available(me)).toBe(2_000_000n);

    const reversing = body<TransferView>(await send(me, b)).data!;
    expect(reversing.status).toBe('pending');
    nuvion.settle(reversing.reference, 'successful');
    nuvion.settle(reversing.reference, 'reversed');
    await sweepLater();
    const view = body<TransferView>(await read(me, reversing.id)).data!;
    expect(view.status).toBe('reversed');
    expect(view.failureReason).toMatch(/reversed/);
    expect(view.timeline.map((t) => t.step)).toEqual(['requested', 'reversed']);
    expect(await states(reversing.reference)).toEqual(['out:reversed']);
    expect(available(to)).toBe(0n);
    expect(available(me)).toBe(2_000_000n);
  });

  it('6 taps at once with one key: one Nuvion transfer', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => send(me, b, key)),
    );
    for (const r of answers) {
      expect([201, 409]).toContain(r.status);
      if (r.status === 409) {
        expect(body(r).reason?.code).toBe('idempotency_in_progress');
      }
    }
    expect(sendsFrom(me)).toHaveLength(1);
    expect(
      await prisma.walletTransfer.count({ where: { payerWawuUserId: me.id } }),
    ).toBe(1);
  });

  it('the adapter has no book transfer yet (not_supported): 503 before any money moves, the send failed, the key given back, and the same key sends once the adapter can', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    nuvion.mode = 'not_supported';
    const res = await send(me, b, key);
    expect(res.status).toBe(503);
    expect(body(res).reason?.code).toBe('provider_unreachable');
    expect(sendsFrom(me)).toHaveLength(0);
    expect(available(me)).toBe(1_000_000n);
    const [row] = await prisma.walletTransfer.findMany({
      where: { payerWawuUserId: me.id },
    });
    expect(row.status).toBe('failed');
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);
    nuvion.mode = 'successful';
    const ok = await send(me, b, key);
    expect(ok.status).toBe(201);
    expect(body<TransferView>(ok).data!.status).toBe('completed');
    expect(sendsFrom(me)).toHaveLength(1);
  });

  it('Nuvion\'s own refusals: not enough after our read is "Your balance changed"; its limit is limit_reached; each gives the key back', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    const key = randomUUID();
    nuvion.mode = 'insufficient';
    const short = await send(me, b, key);
    expect(short.status).toBe(402);
    expect(body(short).reason).toMatchObject({
      code: 'insufficient_funds',
      message: BALANCE_CHANGED_MESSAGE,
    });
    nuvion.mode = 'limit';
    nuvion.limitError = 'error_transfer_daily_limit_exceeded';
    const limited = await send(me, b, key);
    expect(limited.status).toBe(403);
    expect(body(limited).reason).toMatchObject({
      code: 'limit_reached',
      limit: 'daily',
      message: LIMIT_REACHED_MESSAGES.daily,
    });
    expect(sendsFrom(me)).toHaveLength(0);
    nuvion.mode = 'successful';
    expect((await send(me, b, key)).status).toBe(201);
    expect(sendsFrom(me)).toHaveLength(1);
  });

  it("WAWU's own per-transaction limit stops a send before anything is claimed or sent, with the same answer; a send within it goes", async () => {
    const me = await person(5_000_000);
    const to = await person(0);
    const big = await ready(me, to, PER_TXN_LIMIT_KOBO + 1);
    const key = randomUUID();
    const res = await send(me, big, key);
    expect(res.status).toBe(403);
    expect(body(res).reason).toMatchObject({
      code: 'limit_reached',
      limit: 'per_transaction',
    });
    expect(sendsFrom(me)).toHaveLength(0);
    expect(
      await prisma.walletTransfer.count({ where: { payerWawuUserId: me.id } }),
    ).toBe(0);
    expect(
      await prisma.moneyIdempotencyKey.count({ where: { wawuUserId: me.id } }),
    ).toBe(0);
    nuvion.mode = 'successful';
    const ok = await send(me, await ready(me, to, PER_TXN_LIMIT_KOBO), key);
    expect(ok.status).toBe(201);
  });

  it('Nuvion moving another amount than asked is review: pending, nothing completed, the receiver sees nothing', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    const b = await ready(me, to, 200_000);
    nuvion.extraKobo = 100n;
    const view = body<TransferView>(await send(me, b)).data!;
    nuvion.extraKobo = 0n;
    expect(view.status).toBe('pending');
    nuvion.settle(view.reference, 'successful');
    await sweepLater();
    const row = await prisma.walletTransfer.findUniqueOrThrow({
      where: { id: view.id },
    });
    expect(row.status).toBe('pending');
    expect(row.reviewSince).not.toBeNull();
    expect(row.discrepancy).toMatch(/moved 200100 kobo for a send of 200000/);
    expect(await states(view.reference)).toEqual(['out:pending']);
  });

  /**
   * SWEEP-MONEY row WALLET-07 D1 (mutant M02): `completeFromRecord` reads the
   * send afresh and does nothing to one that is no longer pending. A sweep or a
   * webhook that holds an older, pending copy must not complete, re-price or
   * flag a send that settled while it was working.
   */
  describe('completeFromRecord with a stale pending copy of a send that has settled', () => {
    type Record_ = {
      amountKobo: bigint;
      feeKobo: bigint | null;
      totalKobo: bigint | null;
      refs: Record<string, string | null>;
      source: 'send' | 'lookup' | 'history' | 'webhook';
      occurredAt: Date | null;
      debitRecorded: boolean;
    };
    const completeFromRecord = (
      stale: unknown,
      rec: Record_,
    ): Promise<{
      status: string;
      discrepancy: string | null;
      debitReviewSince: Date | null;
      reviewSince: Date | null;
    }> =>
      (
        transfers as unknown as {
          completeFromRecord: (s: unknown, r: Record_) => Promise<never>;
        }
      ).completeFromRecord(stale, rec);
    // A record that charges far more than the quote would flag a pending send.
    const dearRecord: Record_ = {
      amountKobo: 200_000n,
      feeKobo: 90_000n,
      totalKobo: 290_000n,
      refs: {},
      source: 'webhook',
      occurredAt: null,
      debitRecorded: false,
    };
    const ledgerSnapshot = async (reference: string) =>
      (await ledgerRows(reference)).map((r) => ({
        id: r.id,
        direction: r.direction,
        status: r.status,
        amountKobo: String(r.amountKobo),
        feeKobo: String(r.feeKobo),
        totalKobo: String(r.totalKobo),
        discrepancy: r.discrepancy,
        updatedAt: r.updatedAt.getTime(),
      }));

    it.each(['completed', 'failed'] as const)(
      'a send that is already %s is returned as it stands: no ledger row, figure or flag changes',
      async (settled) => {
        const me = await person(1_000_000);
        const to = await person(0);
        const b = await ready(me, to, 200_000);
        const pending = body<TransferView>(await send(me, b)).data!;
        expect(pending.status).toBe('pending');
        const stale = await prisma.walletTransfer.findUniqueOrThrow({
          where: { id: pending.id },
        });
        expect(stale.status).toBe('pending');
        nuvion.settle(
          pending.reference,
          settled === 'completed' ? 'successful' : 'failed',
        );
        await sweepLater();
        const before = await prisma.walletTransfer.findUniqueOrThrow({
          where: { id: pending.id },
        });
        expect(before.status).toBe(settled);
        const rowsBefore = await ledgerSnapshot(pending.reference);

        const out = await completeFromRecord(stale, dearRecord);

        expect(out.status).toBe(settled);
        const after = await prisma.walletTransfer.findUniqueOrThrow({
          where: { id: pending.id },
        });
        expect(after).toEqual(before);
        expect(await ledgerSnapshot(pending.reference)).toEqual(rowsBefore);
      },
    );
  });

  /**
   * SWEEP-MONEY row WALLET-07 D2 (mutants M20 and M21): the sweep asks again
   * 2, 4, 8, 16, 32, 60, 60 minutes after each unknown answer, never sooner,
   * and sends a send nobody has answered to a person at 72 hours, not before.
   */
  describe('the sweep of a pending send', () => {
    const MIN = 60_000;
    const HOUR = 60 * MIN;

    it('asks again 2, 4, 8, 16, 32, 60, 60 minutes after each unknown answer, and not sooner', async () => {
      const me = await person(1_000_000);
      const to = await person(0);
      const pending = body<TransferView>(
        await send(me, await ready(me, to, 200_000)),
      ).data!;
      const row = () =>
        prisma.walletTransfer.findUniqueOrThrow({ where: { id: pending.id } });
      let at = (await row()).nextCheckAt!.getTime();
      const waits = [2, 4, 8, 16, 32, 60, 60];
      for (const [i, minutes] of waits.entries()) {
        await transfers.sweep(new Date(at));
        const r = await row();
        expect(r.status).toBe('pending');
        expect(r.checks).toBe(i + 1);
        expect(r.nextCheckAt!.getTime() - at).toBe(minutes * MIN);
        // One millisecond early asks nothing: the count stays.
        await transfers.sweep(new Date(r.nextCheckAt!.getTime() - 1));
        expect((await row()).checks).toBe(i + 1);
        at = r.nextCheckAt!.getTime();
      }
    });

    it('sends a send nobody has answered to review at 72 hours, not at 71 hours 59 minutes', async () => {
      const me = await person(1_000_000);
      const to = await person(0);
      const pending = body<TransferView>(
        await send(me, await ready(me, to, 200_000)),
      ).data!;
      const first = await prisma.walletTransfer.findUniqueOrThrow({
        where: { id: pending.id },
      });
      const sent = (first.sentAt ?? first.createdAt).getTime();
      await transfers.sweep(new Date(sent + 72 * HOUR - MIN));
      const early = await prisma.walletTransfer.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(early.status).toBe('pending');
      expect(early.reviewSince).toBeNull();
      await transfers.sweep(new Date(sent + 72 * HOUR + 5 * MIN));
      const late = await prisma.walletTransfer.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(late.status).toBe('pending');
      expect(late.reviewSince).not.toBeNull();
      expect(late.discrepancy).toMatch(/no answer from .* after 72 hours/);
    });
  });

  it('a wallet another provider holds is not sent to; and no Fintava host was called, no answer carried a phone', async () => {
    const me = await person(1_000_000);
    const to = await person(0);
    await prisma.fintavaWallet.update({
      where: { wawuUserId: to.id },
      data: { provider: 'fintava' },
    });
    const res = await send(me, await ready(me, to, 100_000));
    expect(res.status).toBe(409);
    expect(body(res).reason?.code).toBe('recipient_has_no_wallet');
    expect(fintavaHits).toEqual([]);
    for (const t of seenTexts) expect(t).not.toMatch(PHONE_SHAPE);
  });
});
