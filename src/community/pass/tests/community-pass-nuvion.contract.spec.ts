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
  type NuvionAccount,
  NuvionSeamStandIn,
} from '../../../../test/payments/nuvion-seam-standin';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { HUB_APP_OPTIONS } from '../../../hub-app-options';
import { EarningSettlementService } from '../../../money/earnings/earning-settlement.service';
import { WalletHoldService } from '../../../money/holds/wallet-hold.service';
import { MoneyModule } from '../../../money/money.module';
import { WalletPaymentService } from '../../../money/payments/wallet-payment.service';
import { isPushed } from '../../../push/push-policy';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { CommunityModule } from '../../community.module';
import { CommunityRoomsService } from '../../rooms/community-rooms.service';
import { CommunityPassModule } from '../community-pass.module';
import { CommunityPassReminderService } from '../community-pass-reminder.service';
import type {
  CommunityPassPurchaseView,
  CommunityPassQuoteView,
  CommunityPassView,
} from '../community-pass-view.type';

/**
 * INBOX-24 (R-63): a private community's monthly pass, on the wallet provider
 * seam with NUVION stood in (`test/payments/nuvion-seam-standin.ts`). The pass
 * is paid as a book transfer into WAWU's operational account; the host's 85%
 * is an earning that travels in their one move of the day. Every account's
 * ledger is compared with the stand-in's balance after the flows. No Nuvion,
 * Fintava or wawuafrica.com host is called (a counter on Fintava's address
 * proves it). NUVION_FEE is a spec value, not a fact about Nuvion.
 */

jest.setTimeout(180_000);

const API = '/api/hub';
const PIN = '5271';
const NUVION_FEE = 2325;
const MOVE_FEE = 1500n;
const PRICE = 200_000; // N2,000, the launch example (I30)
const DAY = 86_400_000;

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `pass-${sub}@test.wawu.dev`,
      phone: '+2348000009924',
      firstName: 'Pass',
      lastName: 'Spec',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '30m' },
  );
}

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

type Envelope<T> = {
  statusCode: number;
  message: string | string[];
  data: T | null;
  reason?: unknown;
};
const body = <T>(res: Response) => res.body as Envelope<T>;
const reasonOf = (res: Response) =>
  (body<unknown>(res).reason as { code?: string } | undefined)?.code;

describe('A private community monthly pass (INBOX-24), Nuvion stood in', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let earnings: EarningSettlementService;
  let payments: WalletPaymentService;
  let holds: WalletHoldService;
  let reminders: CommunityPassReminderService;
  let rooms: CommunityRoomsService;
  const nuvion = new NuvionSeamStandIn();
  const logger = new QuietLogger();
  const users: string[] = [];
  const previous: Record<string, string | undefined> = {};
  const startedAt = new Date();
  const fintavaHits: string[] = [];
  let fintavaCounter: Server;
  let accountSeq = 0;
  let clock = Date.now();
  const later = (ms = 2 * 60_000) => {
    clock = Math.max(clock, Date.now()) + ms;
    return new Date(clock);
  };

  type Person = {
    id: string;
    auth: string;
    account: NuvionAccount | null;
    number: string;
    opened: bigint;
  };

  function mint(): Person {
    const id = randomUUID();
    users.push(id);
    return {
      id,
      auth: `Bearer ${mintToken(id)}`,
      account: null,
      number: '',
      opened: 0n,
    };
  }

  async function openFor(p: Person, kobo: number): Promise<Person> {
    accountSeq += 1;
    const accountNumber = `87${String(Date.now()).slice(-6)}${String(accountSeq).padStart(2, '0')}`;
    p.account = nuvion.openAccount(BigInt(kobo), accountNumber);
    p.opened = BigInt(kobo);
    p.number = accountNumber;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: p.id,
        customerId: p.account.entityId,
        walletId: p.account.accountId,
        accountNumber,
        provider: 'nuvion',
      },
    });
    return p;
  }

  async function person(kobo: number, withPin = true): Promise<Person> {
    const p = await openFor(mint(), kobo);
    if (withPin) {
      const set = await request(app.getHttpServer())
        .post(`${API}/money/pin`)
        .set('Authorization', p.auth)
        .send({ pin: PIN, pinConfirmation: PIN });
      expect(set.status).toBe(201);
    }
    return p;
  }

  /** A private room with a pass at `priceKobo`, hosted by `host`. */
  async function room(host: Person, priceKobo: number | null = PRICE) {
    const c = await prisma.community.create({
      data: {
        name: `Pass room ${randomUUID().slice(0, 8)}`,
        description: 'A private room.',
        hostWawuId: host.id,
        kind: 'private',
        imageUrl: 'https://cdn.example.test/community/image/cover.jpg',
        ...(priceKobo !== null
          ? { passPrice: { create: { priceKobo: BigInt(priceKobo) } } }
          : {}),
      },
    });
    return c.id;
  }

  const get = (p: Person, path: string) =>
    request(app.getHttpServer())
      .get(`${API}${path}`)
      .set('Authorization', p.auth);
  const quoteOf = async (p: Person, communityId: string) => {
    const res = await get(p, `/communities/${communityId}/pass/quote`);
    expect(res.status).toBe(200);
    return body<CommunityPassQuoteView>(res).data!;
  };
  const payBody = (q: CommunityPassQuoteView) => ({
    expectedTotalKobo: q.payment.totalKobo,
    quoteToken: q.payment.quoteToken,
  });
  const buy = (
    p: Person,
    communityId: string,
    q: CommunityPassQuoteView,
    opts: { key?: string; pin?: string | null } = {},
  ) => {
    const req = request(app.getHttpServer())
      .post(`${API}/communities/${communityId}/pass`)
      .set('Authorization', p.auth)
      .set('Idempotency-Key', opts.key ?? randomUUID());
    if (opts.pin !== null) req.set('X-Transaction-Pin', opts.pin ?? PIN);
    return req.send(payBody(q));
  };
  /** Pays for a pass with Nuvion answering at once; returns the purchase. */
  async function pay(p: Person, communityId: string) {
    nuvion.mode = 'successful';
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    const q = await quoteOf(p, communityId);
    const res = await buy(p, communityId, q);
    expect(res.status).toBe(201);
    return body<CommunityPassPurchaseView>(res).data!;
  }
  const available = (p: Person) =>
    nuvion.accounts.get(p.account!.accountId)!.availableKobo;
  const sendsFrom = (p: Person) => nuvion.sendsFrom(p.account!.accountId);
  const passRows = (communityId: string, p: Person) =>
    prisma.communityPass.findMany({
      where: { communityId, userWawuId: p.id },
      orderBy: { endsAt: 'asc' },
    });
  const messages = (p: Person, communityId: string) =>
    get(p, `/communities/${communityId}/messages`);
  const membership = async (p: Person, communityId: string) =>
    body<Record<string, unknown> | null>(
      await get(p, `/communities/${communityId}/membership`),
    ).data;
  /** Moves a person's passes in a room into the past, as if the month had gone by. */
  const endPass = (communityId: string, p: Person, daysAgo = 1) =>
    prisma.communityPass.updateMany({
      where: { communityId, userWawuId: p.id },
      data: {
        startsAt: new Date(Date.now() - (daysAgo + 30) * DAY),
        endsAt: new Date(Date.now() - daysAgo * DAY),
      },
    });

  /** Every account's ledger, summed, equals the stand-in's balance, WAWU's included. */
  async function expectLedgerMatchesNuvion(people: Person[]) {
    for (const p of people) {
      const rows = await prisma.fintavaLedgerEntry.findMany({
        where: {
          accountNumber: p.number,
          status: 'completed',
        },
      });
      const net = rows.reduce(
        (sum, r) =>
          r.direction === 'in' ? sum + r.totalKobo : sum - r.totalKobo,
        0n,
      );
      expect({ who: p.id, balance: p.opened + net }).toEqual({
        who: p.id,
        balance: available(p),
      });
      const hub = await get(p, '/money/wallet/balance');
      expect(
        body<{ availableKobo: number }>(hub).data!.availableKobo,
      ).toBeDefined();
    }
  }

  beforeAll(async () => {
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
      FINTAVA_API_KEY: 'live_test_i24_nuvion_0123456789FAKEKEY',
      FEE_QUOTE_KEY: 'i24-nuvion-fee-quote-key-0123456789abcdef01',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: `0:${NUVION_FEE}`,
      NUVION_FEE_BANK_PAYOUT: `0:${NUVION_FEE}`,
      NUVION_FEE_INFLOW: `0:${NUVION_FEE}`,
      WAWU_LIMIT_PURCHASE_DAILY_KOBO: '100000000',
      PIN_LOCK_MINUTES: '',
      IDEMPOTENCY_KEY_HOURS: '',
      PAYMENT_REVIEW_AFTER_HOURS: '',
    };
    for (const [k, v] of Object.entries(env)) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
        CommunityModule,
        CommunityPassModule,
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
    earnings = moduleRef.get(EarningSettlementService);
    payments = moduleRef.get(WalletPaymentService);
    holds = moduleRef.get(WalletHoldService);
    reminders = moduleRef.get(CommunityPassReminderService);
    rooms = moduleRef.get(CommunityRoomsService);
    // WAWU's own money beyond what is held (its shares and fees).
    nuvion.operational.availableKobo = 5_000_000n;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.notification.deleteMany({
        where: { userWawuId: { in: users } },
      });
      await prisma.creditsState.deleteMany({
        where: { userWawuId: { in: users } },
      });
      // Passes, memberships, prices and messages go with their community (Cascade).
      await prisma.community.deleteMany({
        where: { hostWawuId: { in: users } },
      });
      const rows = await prisma.walletPayment.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: users } },
            { payeeWawuUserId: { in: users } },
          ],
        },
        select: { id: true, customerReference: true },
      });
      const ids = rows.map((r) => r.id);
      const heldRows = await prisma.walletHold.findMany({
        where: { paymentId: { in: ids } },
        select: { customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: {
          OR: [
            { customerReference: { in: rows.map((r) => r.customerReference) } },
            {
              customerReference: {
                in: heldRows.flatMap((h) =>
                  h.customerReference ? [h.customerReference] : [],
                ),
              },
            },
            { customerReference: { startsWith: 'wawu-earn-' } },
          ],
        },
      });
      await prisma.earningSettlement.deleteMany({
        where: { paymentId: { in: ids } },
      });
      await prisma.earningMove.deleteMany({
        where: { payeeWawuUserId: { in: users } },
      });
      await prisma.walletHold.deleteMany({ where: { paymentId: { in: ids } } });
      await prisma.walletPayment.deleteMany({ where: { id: { in: ids } } });
      await prisma.moneyIdempotencyKey.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.transactionPin.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.earningSettlement.deleteMany({
        where: { createdAt: { gte: startedAt }, paymentId: null },
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
    nuvion.mode = 'successful';
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
  });

  it('a member pays N2,000 from the wallet: it drops once, access lasts 30 days, and the host earns N1,700 in the one move of the day', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    const q = await quoteOf(member, id);
    expect(q).toMatchObject({
      priceKobo: PRICE,
      periodDays: 30,
      passUntil: null,
      payment: {
        kind: 'community_pass',
        priceKobo: PRICE,
        totalKobo: PRICE + NUVION_FEE,
        fee: { providerFeeKobo: NUVION_FEE, wawuFeeKobo: 0 },
      },
    });
    expect(q.payment.payee?.wawuUserId).toBe(host.id);
    const before = Date.now();
    nuvion.mode = 'successful';
    const res = await buy(member, id, q);
    expect(res.status).toBe(201);
    const got = body<CommunityPassPurchaseView>(res).data!;
    expect(got).toMatchObject({ status: 'paid', priceKobo: PRICE });
    // The wallet dropped once, by the price and Nuvion's charge, into WAWU's account.
    expect(sendsFrom(member)).toHaveLength(1);
    expect(sendsFrom(member)[0]).toMatchObject({
      amountKobo: BigInt(PRICE),
      feeKobo: BigInt(NUVION_FEE),
      toAccountId: nuvion.operational.accountId,
    });
    expect(available(member)).toBe(BigInt(5_000_000 - PRICE - NUVION_FEE));
    // 30 days, from now.
    const until = new Date(got.passUntil!).getTime();
    expect(until).toBeGreaterThan(before + 30 * DAY - 60_000);
    expect(until).toBeLessThan(Date.now() + 30 * DAY + 1);
    const mem = await membership(member, id);
    expect(mem).toMatchObject({
      status: 'joined',
      passUntil: got.passUntil,
      canRenew: true,
    });
    expect((await messages(member, id)).status).toBe(200);
    expect(
      body<CommunityPassView>(await get(member, `/communities/${id}/pass`))
        .data,
    ).toMatchObject({
      sellsPass: true,
      priceKobo: PRICE,
      active: true,
      canRenew: true,
      canBuy: true,
      isHost: false,
    });

    // The host's 85% is an earning (R-5, R-55); a day under N200 waits, this one is over.
    nuvion.mode = 'pending';
    nuvion.feeKobo = () => MOVE_FEE;
    await earnings.sweep(later());
    const earning = await prisma.earningSettlement.findUniqueOrThrow({
      where: { paymentId: got.id },
    });
    expect(earning).toMatchObject({
      kind: 'community_pass',
      payeeWawuUserId: host.id,
      amountKobo: BigInt(Math.floor((PRICE * 85) / 100)),
    });
    expect(earning.amountKobo).toBe(170_000n);
    const move = await prisma.earningMove.findFirstOrThrow({
      where: { payeeWawuUserId: host.id },
    });
    nuvion.settle(move.customerReference, 'successful');
    await earnings.sweep(later(10 * 60_000));
    expect(available(host)).toBe(170_000n);
    expect(
      (
        await prisma.earningSettlement.findUniqueOrThrow({
          where: { paymentId: got.id },
        })
      ).status,
    ).toBe('landed');
    await expectLedgerMatchesNuvion([member, host]);
    expect(fintavaHits).toEqual([]);
  });

  it('the same request twice, even at once, debits once and gives one pass; a lost answer then a retry does the same', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    const q = await quoteOf(member, id);
    const key = randomUUID();
    const [a, b] = await Promise.all([
      buy(member, id, q, { key }),
      buy(member, id, q, { key }),
    ]);
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(
      true,
    );
    const again = await buy(member, id, q, { key, pin: '0000' });
    expect(again.status).toBe(201);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(sendsFrom(member)).toHaveLength(1);
    expect(await passRows(id, member)).toHaveLength(1);

    // A lost answer: Nuvion takes the transfer and never answers. The retry with
    // the same key asks the provider about the first try and never sends again.
    const lost = await person(5_000_000);
    const q2 = await quoteOf(lost, id);
    nuvion.mode = 'timeout';
    const key2 = randomUUID();
    const first = await buy(lost, id, q2, { key: key2 });
    expect(first.status).toBe(201);
    expect(body<CommunityPassPurchaseView>(first).data!.status).toBe('pending');
    expect(await passRows(id, lost)).toHaveLength(0);
    const retry = await buy(lost, id, q2, { key: key2 });
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(sendsFrom(lost)).toHaveLength(1);
    nuvion.settle(
      body<CommunityPassPurchaseView>(first).data!.payment.reference,
      'successful',
    );
    nuvion.mode = 'successful';
    for (let i = 0; i < 4; i += 1) {
      await payments.sweep(later());
      if ((await passRows(id, lost)).length === 1) break;
    }
    expect(await passRows(id, lost)).toHaveLength(1);
    expect(sendsFrom(lost)).toHaveLength(1);
    expect(available(lost)).toBe(BigInt(5_000_000 - PRICE - NUVION_FEE));
    expect(
      body<CommunityPassPurchaseView>(
        await get(
          lost,
          `/communities/${id}/pass/${body<CommunityPassPurchaseView>(first).data!.id}`,
        ),
      ).data,
    ).toMatchObject({ status: 'paid' });
    await expectLedgerMatchesNuvion([member, lost]);
  });

  it('a wrong PIN moves nothing and gives no pass, five of them lock; a short balance is 402 with nothing moved', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    const q = await quoteOf(member, id);
    const wrong = await buy(member, id, q, { pin: '0000' });
    expect(wrong.status).toBe(403);
    expect(reasonOf(wrong)).toBe('pin_incorrect');
    for (let i = 0; i < 4; i += 1) await buy(member, id, q, { pin: '0000' });
    const locked = await buy(member, id, q, { pin: PIN });
    expect(locked.status).toBe(423);
    expect(reasonOf(locked)).toBe('pin_locked');
    expect(sendsFrom(member)).toHaveLength(0);
    expect(await passRows(id, member)).toHaveLength(0);
    expect(available(member)).toBe(5_000_000n);

    const poor = await person(PRICE - 1);
    const qp = await quoteOf(poor, id);
    expect(qp.payment.shortfallKobo).toBe(PRICE + NUVION_FEE - (PRICE - 1));
    const short = await buy(poor, id, qp);
    expect(short.status).toBe(402);
    expect(reasonOf(short)).toBe('insufficient_funds');
    expect(sendsFrom(poor)).toHaveLength(0);
    expect(await passRows(id, poor)).toHaveLength(0);
    expect((await messages(poor, id)).status).toBe(403);
    await expectLedgerMatchesNuvion([member, poor]);
  });

  it('paying before the end extends from the current end date; after it ends, from today; a person with no wallet is told so', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    const first = await pay(member, id);
    const second = await pay(member, id);
    expect(new Date(second.passUntil!).getTime()).toBe(
      new Date(first.passUntil!).getTime() + 30 * DAY,
    );
    expect(sendsFrom(member)).toHaveLength(2);
    expect(
      new Date((await membership(member, id))!.passUntil as string).getTime(),
    ).toBe(new Date(second.passUntil!).getTime());

    await endPass(id, member, 5);
    expect((await messages(member, id)).status).toBe(403);
    const q = await quoteOf(member, id);
    expect(q.passUntil).toBeNull();
    const third = await pay(member, id);
    const fromToday = new Date(third.passUntil!).getTime() - Date.now();
    expect(fromToday).toBeGreaterThan(30 * DAY - 60_000);
    expect(fromToday).toBeLessThan(30 * DAY + 1);

    const noWallet = mint();
    const res = await get(noWallet, `/communities/${id}/pass/quote`);
    expect(res.status).toBe(409);
    expect(reasonOf(res)).toBe('wallet_not_open');
    const own = await get(host, `/communities/${id}/pass`);
    expect(body<CommunityPassView>(own).data).toMatchObject({
      isHost: true,
      canBuy: false,
    });
  });

  it('the pass ends at the month: a member without one loses the room, reading and posting, until they renew', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    await prisma.creditsState.create({
      data: { userWawuId: member.id, creditBalance: 10 },
    });
    await prisma.communityMessage.create({
      data: {
        communityId: id,
        senderWawuId: host.id,
        text: 'Welcome in',
        costInCredits: 0,
      },
    });
    // Before paying: a room that sells a pass is not joined by a request.
    const join = await request(app.getHttpServer())
      .post(`${API}/communities/${id}/join`)
      .set('Authorization', member.auth);
    expect(join.status).toBe(409);
    expect((await messages(member, id)).status).toBe(403);

    await pay(member, id);
    const read = await messages(member, id);
    expect(read.status).toBe(200);
    const mine = await get(member, '/communities/mine');
    expect(
      body<Array<{ id: string; lastMessage: unknown }>>(mine).data!.find(
        (c) => c.id === id,
      )!.lastMessage,
    ).not.toBeNull();
    const post = await request(app.getHttpServer())
      .post(`${API}/communities/${id}/messages`)
      .set('Authorization', member.auth)
      .send({ text: 'Hello all' });
    expect(post.status).toBe(201);

    await endPass(id, member);
    const lost = await messages(member, id);
    expect(lost.status).toBe(403);
    expect(String(body<unknown>(lost).message)).toMatch(/pass.*ended/i);
    const noPost = await request(app.getHttpServer())
      .post(`${API}/communities/${id}/messages`)
      .set('Authorization', member.auth)
      .send({ text: 'Still here?' });
    expect(noPost.status).toBe(403);
    expect(
      (
        await request(app.getHttpServer())
          .post(`${API}/communities/${id}/read`)
          .set('Authorization', member.auth)
      ).status,
    ).toBe(403);
    const room1 = body<{ role: string }>(
      await get(member, `/communities/${id}/room`),
    );
    expect(room1.data!.role).toBe('none');
    // The room stays listed so it can be renewed, with no message and no unread count.
    const lapsedList = body<
      Array<{ id: string; lastMessage: unknown; unreadCount: number }>
    >(await get(member, '/communities/mine')).data!.find((c) => c.id === id)!;
    expect(lapsedList).toMatchObject({ lastMessage: null, unreadCount: 0 });
    const mem = await membership(member, id);
    expect(mem).toMatchObject({ status: 'joined', canRenew: true });
    expect(new Date(mem!.passUntil as string).getTime()).toBeLessThan(
      Date.now(),
    );
    // The host is never locked out.
    expect((await messages(host, id)).status).toBe(200);

    await pay(member, id);
    expect((await messages(member, id)).status).toBe(200);
  });

  it('a room with no pass is untouched: the older request flow, and the membership answer keeps its keys', async () => {
    const host = await person(0, false);
    const member = await person(0, false);
    const noPrice = await room(host, null);
    const join = await request(app.getHttpServer())
      .post(`${API}/communities/${noPrice}/join`)
      .set('Authorization', member.auth);
    expect(join.status).toBe(200);
    expect(body<{ status: string }>(join).data!.status).toBe('pending');
    expect(Object.keys((await membership(member, noPrice))!).sort()).toEqual([
      'communityId',
      'id',
      'joinedAt',
      'requestedAt',
      'status',
      'userWawuId',
    ]);
    const res = await get(member, `/communities/${noPrice}/pass`);
    expect(body<CommunityPassView>(res).data).toMatchObject({
      sellsPass: false,
      priceKobo: null,
      canBuy: false,
    });
    const buyer = await person(5_000_000);
    const notSold = await get(buyer, `/communities/${noPrice}/pass/quote`);
    expect(notSold.status).toBe(409);
    expect(reasonOf(notSold)).toBe('target_not_payable');
  });

  it('someone who left with time on their pass comes back without paying again', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    await pay(member, id);
    await request(app.getHttpServer())
      .delete(`${API}/communities/${id}/join`)
      .set('Authorization', member.auth);
    expect((await messages(member, id)).status).toBe(403);
    const back = await request(app.getHttpServer())
      .post(`${API}/communities/${id}/join`)
      .set('Authorization', member.auth);
    expect(back.status).toBe(200);
    expect(body<{ status: string }>(back).data!.status).toBe('joined');
    expect((await messages(member, id)).status).toBe(200);
    expect(sendsFrom(member)).toHaveLength(1);
  });

  it('the reminder: one notice 3 days before the end, never for a renewed pass, never a debit', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const renewed = await person(5_000_000);
    const far = await person(5_000_000);
    const id = await room(host);
    await pay(member, id);
    await pay(renewed, id);
    await pay(far, id);
    expect(await reminders.run()).toBe(0);
    // Two days to the end for `member` and `renewed`; `far` has 29.
    await prisma.communityPass.updateMany({
      where: { communityId: id, userWawuId: { in: [member.id, renewed.id] } },
      data: {
        startsAt: new Date(Date.now() - 28 * DAY),
        endsAt: new Date(Date.now() + 2 * DAY),
      },
    });
    await pay(renewed, id);
    const sent = await reminders.run();
    expect(sent).toBe(1);
    expect(await reminders.run()).toBe(0);
    const notes = await prisma.notification.findMany({
      where: { kind: 'community_pass_ending', userWawuId: { in: users } },
    });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      userWawuId: member.id,
      actionHref: `/communities/${id}/renew`,
    });
    expect(notes[0].body).not.toContain('—');
    expect(isPushed('community_pass_ending')).toBe(true);
    // Nothing was debited by the reminder or by time.
    expect(sendsFrom(member)).toHaveLength(1);
    await payments.sweep(later());
    await earnings.sweep(later());
    expect(sendsFrom(member)).toHaveLength(1);
    expect(sendsFrom(far)).toHaveLength(1);
    // The renew tap: one more payment, from the end date.
    const renew = await pay(member, id);
    expect(new Date(renew.passUntil!).getTime()).toBeGreaterThan(
      Date.now() + 31 * DAY,
    );
  });

  it('a pass that cannot be given is paid back in full, the charge included, and the host earns nothing', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    const q = await quoteOf(member, id);
    // Nuvion takes the transfer but has not settled it: the pass is not given yet.
    nuvion.mode = 'pending';
    const res = await buy(member, id, q);
    const pending = body<CommunityPassPurchaseView>(res).data!;
    expect(pending.status).toBe('pending');
    // The room stops selling a pass before the debit settles.
    await prisma.communityPassPrice.deleteMany({ where: { communityId: id } });
    nuvion.settle(pending.payment.reference, 'successful');
    nuvion.mode = 'successful';
    nuvion.feeKobo = () => BigInt(NUVION_FEE);
    for (let i = 0; i < 4; i += 1) {
      await payments.sweep(later());
      await holds.sweep(later());
      if (available(member) === 5_000_000n) break;
    }
    expect(await passRows(id, member)).toHaveLength(0);
    // Every naira is back: the price and Nuvion's charge. WAWU bears the refund's own charge.
    expect(available(member)).toBe(5_000_000n);
    const view = body<CommunityPassPurchaseView>(
      await get(member, `/communities/${id}/pass/${pending.id}`),
    ).data!;
    expect(view.status).toBe('refunded');
    expect(view.passUntil).toBeNull();
    await earnings.sweep(later());
    expect(
      await prisma.earningSettlement.count({
        where: { paymentId: pending.id },
      }),
    ).toBe(0);
    expect((await messages(member, id)).status).toBe(403);
    await expectLedgerMatchesNuvion([member]);
  });

  it('the host types the price when the room is made: private only, inside the bounds, stored with the room', async () => {
    const host = await person(0, false);
    const base = {
      name: 'Aba tailors circle',
      description: 'Tailors of Aba.',
      imageUrl: 'https://cdn.example.test/community/image/cover.jpg',
    };
    const made = await rooms.createRoom(host.id, {
      ...base,
      kind: 'private',
      passPriceKobo: PRICE,
    });
    const price = await prisma.communityPassPrice.findUniqueOrThrow({
      where: { communityId: made.id },
    });
    expect(price.priceKobo).toBe(BigInt(PRICE));
    await expect(
      rooms.createRoom(host.id, {
        ...base,
        kind: 'open',
        passPriceKobo: PRICE,
      }),
    ).rejects.toThrow(/Only a private room/);
    await expect(
      rooms.createRoom(host.id, { ...base, kind: 'private', passPriceKobo: 5 }),
    ).rejects.toThrow(/at least/);
    const plain = await rooms.createRoom(host.id, { ...base, kind: 'private' });
    expect(
      await prisma.communityPassPrice.count({
        where: { communityId: plain.id },
      }),
    ).toBe(0);
  });

  it('came out clean: no Fintava call, and the ledger agrees with the stand-in for WAWU as well', async () => {
    expect(fintavaHits).toEqual([]);
    const rows = await prisma.fintavaLedgerEntry.findMany({
      where: {
        walletKind: 'merchant',
        provider: 'nuvion',
        status: 'completed',
        createdAt: { gte: startedAt },
      },
    });
    expect(rows.length).toBeGreaterThan(0);
    const net = rows.reduce(
      (sum, r) =>
        r.direction === 'in' ? sum + r.totalKobo : sum - r.totalKobo,
      0n,
    );
    expect(5_000_000n + net).toBe(nuvion.operational.availableKobo);
  });
});
