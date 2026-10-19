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
import { MoneyModule } from '../../../money/money.module';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { CommunityModule } from '../../community.module';
import { CommunityService } from '../../community.service';
import { CommunityPassModule } from '../community-pass.module';
import { CommunityPassRefundService } from '../community-pass-refund.service';
import type {
  CommunityPassPurchaseView,
  CommunityPassQuoteView,
  CommunityPassView,
} from '../community-pass-view.type';

/**
 * INBOX-25 (owner ruling Q-43, R-71): a member the host removes gets the
 * unused days of their paid monthly pass back, on the wallet provider seam
 * with NUVION stood in (`test/payments/nuvion-seam-standin.ts`). WAWU pays the
 * refund from its operational account to the member's wallet; the host's 85%
 * of those days is taken back from the host's earnings (their next daily
 * move), never from their wallet. Every account's ledger is compared with the
 * stand-in's balance after the flows. No Nuvion, Fintava or wawuafrica.com
 * host is called (a counter on Fintava's address proves it). NUVION_FEE is a
 * spec value, not a fact about Nuvion.
 */

jest.setTimeout(180_000);

const API = '/api/hub';
const PIN = '5271';
const NUVION_FEE = 2325;
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

describe('A removed member gets the unused days of their pass back (INBOX-25), Nuvion stood in', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let earnings: EarningSettlementService;
  let refunds: CommunityPassRefundService;
  let communities: CommunityService;
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
  const passRows = (communityId: string, p: Person) =>
    prisma.communityPass.findMany({
      where: { communityId, userWawuId: p.id },
      orderBy: { endsAt: 'asc' },
    });
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
    refunds = moduleRef.get(CommunityPassRefundService);
    communities = moduleRef.get(CommunityService);
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
      const refundRows = await prisma.communityPassRefund.findMany({
        where: {
          OR: [{ userWawuId: { in: users } }, { hostWawuId: { in: users } }],
        },
        select: { id: true, customerReference: true },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { customerReference: { startsWith: 'wawu-pref-' } },
      });
      await prisma.earningDeductionTake.deleteMany({
        where: { deduction: { payeeWawuUserId: { in: users } } },
      });
      await prisma.earningDeduction.deleteMany({
        where: { payeeWawuUserId: { in: users } },
      });
      await prisma.communityPassRefund.deleteMany({
        where: { id: { in: refundRows.map((r) => r.id) } },
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

  const NOTE_TITLE = 'Your pass was refunded';
  const HOUR = 3_600_000;

  /** The pass runs 30 days; this puts it where `unused` whole days are left (a started day counts as used). */
  const setUnused = (communityId: string, p: Person, unused: number) => {
    const used = 30 - unused;
    const startsAt = new Date(Date.now() - (used - 0.5) * DAY);
    return prisma.communityPass.updateMany({
      where: { communityId, userWawuId: p.id },
      data: { startsAt, endsAt: new Date(startsAt.getTime() + 30 * DAY) },
    });
  };
  const refundsOf = (communityId: string, p: Person) =>
    prisma.communityPassRefund.findMany({
      where: { communityId, userWawuId: p.id },
      orderBy: { createdAt: 'asc' },
    });
  /** Waits for the removal's own, immediate try to have gone as far as it goes. */
  async function reached(
    refundId: string,
    done: (r: Awaited<ReturnType<typeof refundRow>>) => boolean,
  ) {
    for (let i = 0; i < 100; i += 1) {
      const r = await refundRow(refundId);
      if (done(r)) return r;
      await new Promise((res) => setTimeout(res, 100));
    }
    return refundRow(refundId);
  }
  const refundRow = (id: string) =>
    prisma.communityPassRefund.findUniqueOrThrow({ where: { id } });
  const settled = (r: { status: string }) => r.status === 'refunded';
  const tried = (r: {
    status: string;
    sentAt: Date | null;
    waiting: string | null;
  }) => r.status !== 'pending' || r.sentAt !== null || r.waiting !== null;
  const refundNotes = (p: Person) =>
    prisma.notification.findMany({
      where: { kind: 'community_pass_refunded', userWawuId: p.id },
    });
  /** What the stand-in recorded WAWU sending to this person's account (the refunds). */
  const refundsReceived = (p: Person) =>
    nuvion.transfers.filter(
      (t) =>
        t.fromAccountId === nuvion.operational.accountId &&
        t.toAccountId === p.account!.accountId,
    );
  const hubBalance = async (p: Person) =>
    body<{ availableKobo: number }>(await get(p, '/money/wallet/balance')).data!
      .availableKobo;
  const passFor = async (communityId: string, p: Person) =>
    body<CommunityPassView>(await get(p, `/communities/${communityId}/pass`))
      .data!;

  it.each([
    [1, 6_666n, 5_666n],
    [15, 100_000n, 85_000n],
    [29, 193_333n, 164_333n],
  ])(
    'a host removing a member with %i unused days pays back the price pro rata, floored to the kobo, once, from WAWU to the wallet',
    async (unused, expected, hostShare) => {
      const host = await person(0, false);
      const member = await person(5_000_000);
      const id = await room(host);
      await pay(member, id);
      const afterBuy = available(member);
      expect(afterBuy).toBe(BigInt(5_000_000 - PRICE - NUVION_FEE));
      await setUnused(id, member, unused);

      // The host's remove sheet asks the Hub; the app never figures it.
      const quote = await communities.removalQuote(id, host.id, member.id);
      expect(quote).toMatchObject({
        refundKobo: Number(expected),
        unusedDays: unused,
      });

      expect(await communities.removeMember(id, host.id, member.id)).toEqual({
        removed: true,
      });
      const [row] = await refundsOf(id, member);
      expect(row).toMatchObject({
        amountKobo: expected,
        unusedDays: unused,
        hostShareKobo: hostShare,
        hostWawuId: host.id,
        merchantAccountNumber: nuvion.operational.nuvionBan,
      });
      const done = await reached(row.id, settled);
      expect(done.status).toBe('refunded');
      expect(done.customerReference).toBe(`wawu-pref-${row.id}`);

      // The wallet rose by exactly the refund, once; WAWU paid the provider's charge.
      expect(available(member)).toBe(afterBuy + expected);
      expect(await hubBalance(member)).toBe(Number(afterBuy + expected));
      const sent = refundsReceived(member);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        amountKobo: expected,
        feeKobo: BigInt(NUVION_FEE),
        status: 'successful',
      });
      // One wallet row (the ledger's `in` entry) and one notification.
      const rows = await prisma.fintavaLedgerEntry.findMany({
        where: { customerReference: row.customerReference, direction: 'in' },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        category: 'refund',
        accountNumber: member.number,
      });
      expect(rows[0].totalKobo).toBe(expected);
      const notes = await refundNotes(member);
      expect(notes).toHaveLength(1);
      expect(notes[0].title).toBe(NOTE_TITLE);
      expect(notes[0].body).not.toMatch(/[—–]/);
      // The pass ended with the removal and cannot be bought back; it is marked paid back.
      const [pass] = await passRows(id, member);
      expect(pass.refundId).toBe(row.id);
      expect(pass.endsAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect(await passFor(id, member)).toMatchObject({
        active: false,
        canBuy: false,
        canRenew: false,
      });
      // The host's 85% of those days is owed back from their earnings, not their wallet.
      expect(
        await prisma.earningDeduction.findUniqueOrThrow({
          where: { passRefundId: row.id },
        }),
      ).toMatchObject({ payeeWawuUserId: host.id, amountKobo: hostShare });
      await expectLedgerMatchesNuvion([member]);
      expect(fintavaHits).toEqual([]);
    },
  );

  it('0 unused days gives nothing back: a pass that has ended, and a pass whose last day has started', async () => {
    const host = await person(0, false);
    const ended = await person(5_000_000);
    const lastDay = await person(5_000_000);
    const id = await room(host);
    await pay(ended, id);
    await pay(lastDay, id);
    await endPass(id, ended, 2);
    await setUnused(id, lastDay, 0);
    for (const p of [ended, lastDay]) {
      const before = available(p);
      expect(await communities.removalQuote(id, host.id, p.id)).toMatchObject({
        refundKobo: 0,
        unusedDays: 0,
      });
      expect(await communities.removeMember(id, host.id, p.id)).toEqual({
        removed: true,
      });
      expect(await refundsOf(id, p)).toHaveLength(0);
      expect(available(p)).toBe(before);
      expect(refundsReceived(p)).toHaveLength(0);
      expect(await refundNotes(p)).toHaveLength(0);
      expect((await passRows(id, p))[0].refundId).toBeNull();
    }
    expect(
      await prisma.earningDeduction.count({
        where: { payeeWawuUserId: host.id },
      }),
    ).toBe(0);
  });

  it('a member who LEAVES gets nothing back, and a removal that finds them gone gives nothing either', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    await pay(member, id);
    await setUnused(id, member, 15);
    const before = available(member);
    const left = await request(app.getHttpServer())
      .delete(`${API}/communities/${id}/join`)
      .set('Authorization', member.auth);
    expect(left.status).toBe(200);
    expect(await refundsOf(id, member)).toHaveLength(0);
    // The host's removal of someone who is no longer in the room moves nobody and pays nothing.
    expect(
      await communities.removalQuote(id, host.id, member.id),
    ).toMatchObject({
      refundKobo: 0,
    });
    expect(await communities.removeMember(id, host.id, member.id)).toEqual({
      removed: true,
    });
    expect(await refundsOf(id, member)).toHaveLength(0);
    expect(available(member)).toBe(before);
    expect(refundsReceived(member)).toHaveLength(0);
    expect((await passRows(id, member))[0].refundId).toBeNull();
  });

  it('one removal, one refund, ever: a double tap at once, a retry, two drivers, and a removal after the host let them back', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    await pay(member, id);
    const afterBuy = available(member);
    await setUnused(id, member, 15);

    const answers = await Promise.all([
      communities.removeMember(id, host.id, member.id),
      communities.removeMember(id, host.id, member.id),
      communities.removeMember(id, host.id, member.id),
    ]);
    expect(answers).toEqual([
      { removed: true },
      { removed: true },
      { removed: true },
    ]);
    const rows = await refundsOf(id, member);
    expect(rows).toHaveLength(1);
    const refundId = rows[0].id;
    // Two servers driving the same refund at the same moment send it once.
    await Promise.all([
      refunds.drive(refundId),
      refunds.drive(refundId),
      refunds.sweep(later()),
    ]);
    await reached(refundId, settled);
    expect(available(member)).toBe(afterBuy + 100_000n);
    expect(refundsReceived(member)).toHaveLength(1);
    expect(
      nuvion.calls.filter(
        (c) =>
          c.method === 'walletToWallet' &&
          (c.args as { reference: string }).reference ===
            `wawu-pref-${refundId}`,
      ),
    ).toHaveLength(1);

    // A retry of the same removal.
    await communities.removeMember(id, host.id, member.id);
    // The host lets them back; they have no pass, so a new removal has nothing to give.
    const back = await communities.approveJoinRequest(id, host.id, member.id);
    expect(back.status).toBe('joined');
    await communities.removeMember(id, host.id, member.id);
    await refunds.sweep(later());
    expect(await refundsOf(id, member)).toHaveLength(1);
    expect(available(member)).toBe(afterBuy + 100_000n);
    expect(refundsReceived(member)).toHaveLength(1);
    expect(await refundNotes(member)).toHaveLength(1);
    expect(
      await prisma.earningDeduction.count({
        where: { payeeWawuUserId: host.id },
      }),
    ).toBe(1);
    await expectLedgerMatchesNuvion([member]);
  });

  it('a refusal that moved nothing waits and is sent again under the SAME reference; the member is paid once', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    await pay(member, id);
    const afterBuy = available(member);
    await setUnused(id, member, 15);
    nuvion.mode = 'insufficient';
    await communities.removeMember(id, host.id, member.id);
    const [row] = await refundsOf(id, member);
    const waiting = await reached(row.id, tried);
    expect(waiting).toMatchObject({ status: 'pending', waiting: 'funds' });
    expect(available(member)).toBe(afterBuy);
    nuvion.mode = 'successful';
    await refunds.sweep(later(10 * 60_000));
    const done = await refundRow(row.id);
    expect(done).toMatchObject({ status: 'refunded', attempt: 1 });
    expect(available(member)).toBe(afterBuy + 100_000n);
    expect(refundsReceived(member)).toHaveLength(1);
    expect(await refundNotes(member)).toHaveLength(1);
    await expectLedgerMatchesNuvion([member]);
  });

  it('a confirmed failure starts ONE new try under a new reference, never two in flight; the member is paid once', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    await pay(member, id);
    const afterBuy = available(member);
    await setUnused(id, member, 15);
    // Nuvion accepts the book transfer and does not finish it: nothing is known.
    nuvion.mode = 'processing';
    await communities.removeMember(id, host.id, member.id);
    const [row] = await refundsOf(id, member);
    const sent = await reached(row.id, tried);
    expect(sent).toMatchObject({ status: 'pending', attempt: 1 });
    expect(sent.sentAt).not.toBeNull();
    const calls = () =>
      nuvion.calls.filter(
        (c) =>
          c.method === 'walletToWallet' &&
          String((c.args as { reference: string }).reference).startsWith(
            `wawu-pref-${row.id}`,
          ),
      );
    expect(calls()).toHaveLength(1);
    // Still unknown: asked about, never sent again.
    await refunds.sweep(later(10 * 60_000));
    expect(calls()).toHaveLength(1);
    expect(available(member)).toBe(afterBuy);
    // Nuvion's own record says it failed: the money went back to WAWU.
    nuvion.settle(row.customerReference, 'failed');
    await refunds.sweep(later(10 * 60_000));
    const retried = await refundRow(row.id);
    expect(retried).toMatchObject({ status: 'pending', attempt: 2 });
    expect(retried.customerReference).toBe(`wawu-pref-${row.id}-2`);
    expect(retried.sentAt).toBeNull();
    expect(calls()).toHaveLength(1);
    nuvion.mode = 'successful';
    await refunds.sweep(later(30 * 60_000));
    const done = await refundRow(row.id);
    expect(done).toMatchObject({ status: 'refunded', attempt: 2 });
    expect(calls()).toHaveLength(2);
    // One success of the two; the member is paid once.
    expect(
      refundsReceived(member).filter((t) => t.status === 'successful'),
    ).toHaveLength(1);
    expect(available(member)).toBe(afterBuy + 100_000n);
    expect(await refundNotes(member)).toHaveLength(1);
    await expectLedgerMatchesNuvion([member]);
  });

  it('an unknown answer is asked about and never sent again; when Nuvion answers the refund is settled once', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    await pay(member, id);
    const afterBuy = available(member);
    await setUnused(id, member, 29);
    // Nuvion takes the transfer and the answer never reaches us.
    nuvion.mode = 'timeout';
    await communities.removeMember(id, host.id, member.id);
    const [row] = await refundsOf(id, member);
    const unknown = await reached(row.id, tried);
    expect(unknown.status).toBe('pending');
    expect(unknown.sentAt).not.toBeNull();
    const sends = () =>
      nuvion.calls.filter(
        (c) =>
          c.method === 'walletToWallet' &&
          (c.args as { reference: string }).reference === row.customerReference,
      );
    expect(sends()).toHaveLength(1);
    // Nuvion finishes the transfer it took; the next look finds it.
    nuvion.settle(row.customerReference, 'successful');
    nuvion.mode = 'successful';
    await refunds.sweep(later(10 * 60_000));
    const done = await refundRow(row.id);
    expect(done.status).toBe('refunded');
    expect(sends()).toHaveLength(1);
    expect(refundsReceived(member)).toHaveLength(1);
    expect(available(member)).toBe(afterBuy + 193_333n);
    expect(await refundNotes(member)).toHaveLength(1);
    await expectLedgerMatchesNuvion([member]);
  });

  it("a member with no wallet: the refund waits in WAWU's account and lands the moment they open one (R-11)", async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const id = await room(host);
    await pay(member, id);
    await setUnused(id, member, 15);
    await prisma.fintavaWallet.delete({ where: { wawuUserId: member.id } });
    await communities.removeMember(id, host.id, member.id);
    const [row] = await refundsOf(id, member);
    const waiting = await reached(row.id, tried);
    expect(waiting).toMatchObject({
      status: 'pending',
      waiting: 'member_wallet',
    });
    expect(
      nuvion.calls.filter(
        (c) =>
          c.method === 'walletToWallet' &&
          (c.args as { reference: string }).reference === row.customerReference,
      ),
    ).toHaveLength(0);
    expect(await refundNotes(member)).toHaveLength(0);
    // Still waiting a while later; then the wallet opens and the next pass pays it.
    await refunds.sweep(later());
    expect((await refundRow(row.id)).status).toBe('pending');
    await openFor(member, 0);
    await refunds.sweep(later());
    expect((await refundRow(row.id)).status).toBe('refunded');
    expect(available(member)).toBe(100_000n);
    expect(await refundNotes(member)).toHaveLength(1);
    await expectLedgerMatchesNuvion([member]);
  });

  it("the host's 85% of the refunded days comes out of their earnings not yet moved, and what is short is owed to the next move, never their wallet", async () => {
    // Enough unmoved earnings: N1,700 earned, N850 taken back, N850 moves.
    const host = await person(0, false);
    const a = await person(5_000_000);
    const id = await room(host);
    await pay(a, id);
    await setUnused(id, a, 15);
    await communities.removeMember(id, host.id, a.id);
    const [rowA] = await refundsOf(id, a);
    await reached(rowA.id, settled);
    await earnings.sweep(later());
    const move = await prisma.earningMove.findFirstOrThrow({
      where: { payeeWawuUserId: host.id },
    });
    expect(move).toMatchObject({
      amountKobo: 170_000n - 85_000n,
      status: 'landed',
    });
    expect(
      await prisma.earningDeductionTake.findMany({
        where: { moveId: move.id },
      }),
    ).toMatchObject([{ amountKobo: 85_000n }]);
    expect(available(host)).toBe(85_000n);

    // Short: N1,700 earned, N1,643.33 to take back, but a move stays at the N200 floor.
    const host2 = await person(0, false);
    const b = await person(5_000_000);
    const c = await person(5_000_000);
    const id2 = await room(host2);
    await pay(b, id2);
    await setUnused(id2, b, 29);
    await communities.removeMember(id2, host2.id, b.id);
    const [rowB] = await refundsOf(id2, b);
    await reached(rowB.id, settled);
    expect(rowB.hostShareKobo).toBe(164_333n);
    await earnings.sweep(later());
    const first = await prisma.earningMove.findFirstOrThrow({
      where: { payeeWawuUserId: host2.id },
    });
    expect(first.amountKobo).toBe(20_000n);
    expect(available(host2)).toBe(20_000n);
    const deduction = await prisma.earningDeduction.findUniqueOrThrow({
      where: { passRefundId: rowB.id },
      include: { takes: true },
    });
    const takenSoFar = deduction.takes.reduce((s, t) => s + t.amountKobo, 0n);
    expect(takenSoFar).toBe(150_000n);
    expect(deduction.amountKobo - takenSoFar).toBe(14_333n);

    // The next day's earnings pay what is still owed, and the move is smaller by exactly that.
    await pay(c, id2);
    await earnings.sweep(new Date(Date.now() + 26 * HOUR));
    const second = await prisma.earningMove.findFirstOrThrow({
      where: { payeeWawuUserId: host2.id, id: { not: first.id } },
    });
    expect(second.amountKobo).toBe(170_000n - 14_333n);
    const after = await prisma.earningDeduction.findUniqueOrThrow({
      where: { passRefundId: rowB.id },
      include: { takes: true },
    });
    expect(after.takes.reduce((s, t) => s + t.amountKobo, 0n)).toBe(164_333n);
    expect(available(host2)).toBe(340_000n - 164_333n);
    // Never taken from either host's wallet: nothing left a host account.
    expect(nuvion.sendsFrom(host.account!.accountId)).toHaveLength(0);
    expect(nuvion.sendsFrom(host2.account!.accountId)).toHaveLength(0);
    await expectLedgerMatchesNuvion([a, b, c, host, host2]);
  });

  it('only the host asks what a removal gives back, and an open room or an older private room is removed exactly as before', async () => {
    const host = await person(0, false);
    const member = await person(5_000_000);
    const other = await person(0, false);
    const id = await room(host);
    await pay(member, id);
    await expect(
      communities.removalQuote(id, other.id, member.id),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      communities.removalQuote(id, host.id, host.id),
    ).rejects.toMatchObject({ status: 400 });
    // An older private room (no price): the row goes, nothing is refunded.
    const noPrice = await room(host, null);
    await prisma.communityMembership.create({
      data: {
        userWawuId: other.id,
        communityId: noPrice,
        status: 'joined',
        joinedAt: new Date(),
      },
    });
    expect(await communities.removeMember(noPrice, host.id, other.id)).toEqual({
      removed: true,
    });
    expect(
      await prisma.communityMembership.count({
        where: { communityId: noPrice, userWawuId: other.id },
      }),
    ).toBe(0);
    expect(
      await prisma.communityPassRefund.count({
        where: { userWawuId: other.id },
      }),
    ).toBe(0);
    expect(fintavaHits).toEqual([]);
  });
});
