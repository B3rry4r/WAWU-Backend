import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  LoggerService,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import * as jwt from 'jsonwebtoken';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { WawuIdClient } from '../../../common/auth/wawu-id.client';
import { WawuJwtStrategy } from '../../../common/auth/wawu-jwt.strategy';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { MoneyErrorReason } from '../../dto/money-error.dto';
import {
  NO_WALLET_MESSAGE,
  WALLET_OPENING_MESSAGE,
} from '../../gate/wallet-gate';
import type { LedgerMovementInput } from '../../ledger/ledger.interface';
import { LedgerService } from '../../ledger/ledger.service';
import { MoneyModule } from '../../money.module';
import type {
  MonthlySummaryView,
  TransactionPage,
  TransactionView,
} from '../../money-view.type';

/**
 * The wallet history over HTTP (task MONEY-15): the real MoneyModule, a real
 * database, real RS256 tokens checked against the stand-in WAWU ID's JWKS
 * (WAWU_ID_JWKS_URL), and rows written by the ledger's own writer
 * (LedgerService.record and applyReversal, MONEY-10 and MONEY-08), so what a
 * test reads is what the ledger stores. Every person is a brand-new
 * wawuUserId with a brand-new wallet; afterAll deletes their rows.
 *
 * The server listens on 127.0.0.1 after init (FIX-02): one test sends
 * requests at once.
 */

const BASE = '/api/hub/money/transactions';

function mintToken(sub: string): string {
  const privateKey = readFileSync(
    join(__dirname, '../../../../mock-wawu-id/private.pem'),
    'utf8',
  );
  return jwt.sign(
    {
      sub,
      email: `history-${sub}@test.wawu.dev`,
      phone: '+2348000009997',
      firstName: 'History',
      lastName: 'Tester',
      country: 'Nigeria',
      verificationTier: 'basic',
      trustScore: 0,
      status: 'active',
    },
    privateKey,
    { algorithm: 'RS256', keyid: 'mock-wawu-id-key-1', expiresIn: '15m' },
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
  reason?: MoneyErrorReason;
};
const body = <T>(res: Response): Envelope<T> => res.body as Envelope<T>;
const page = (res: Response) => body<TransactionPage>(res).data!;

/** A NUBAN no other test run holds. */
let accountSeq = 0;
function nuban(): string {
  accountSeq += 1;
  return `9${String(Date.now()).slice(-6)}${String(accountSeq).padStart(3, '0')}`;
}

describe('GET /money/transactions, /summary, /{id} (MONEY-15) over HTTP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let ledger: LedgerService;
  const logger = new QuietLogger();
  const users: string[] = [];
  const accounts: string[] = [];

  type Person = { id: string; auth: string; account: string | null };

  function newUser(): Person {
    const id = randomUUID();
    users.push(id);
    return { id, auth: `Bearer ${mintToken(id)}`, account: null };
  }

  async function withWallet(
    accountName: string | null = null,
  ): Promise<Person & { account: string }> {
    const user = newUser();
    const account = nuban();
    accounts.push(account);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: user.id,
        customerId: randomUUID(),
        walletId: randomUUID(),
        accountNumber: account,
        accountName,
      },
    });
    return { ...user, account };
  }

  type Move = Omit<LedgerMovementInput, 'wallet' | 'references' | 'source'> & {
    ref?: string;
    source?: LedgerMovementInput['source'];
  };

  /** One side of one movement on this person's wallet, through the ledger's writer. */
  async function record(p: { id: string; account: string }, m: Move) {
    const { ref, source, ...rest } = m;
    const r = await ledger.record({
      ...rest,
      wallet: { kind: 'user', wawuUserId: p.id, accountNumber: p.account },
      references: { customerReference: ref ?? `M15-${randomUUID()}` },
      source: source ?? 'send',
    });
    return r.entryId;
  }

  function get(auth: string | undefined, path: string) {
    const req = request(app.getHttpServer()).get(path);
    return auth ? req.set('Authorization', auth) : req;
  }

  /** Every page of a list, following nextCursor. */
  async function all(auth: string, query: string, limit = 7) {
    const items: TransactionView[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = new URLSearchParams(query);
      q.set('limit', String(limit));
      if (cursor) q.set('cursor', cursor);
      const res = await get(auth, `${BASE}?${q.toString()}`).expect(200);
      const p = page(res);
      items.push(...p.items);
      cursor = p.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(100);
    } while (cursor);
    return { items, pages };
  }

  const at = (iso: string) => new Date(iso);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PassportModule.register({ defaultStrategy: 'wawu-jwt' }),
        PrismaModule,
        MoneyModule,
      ],
      providers: [WawuJwtStrategy, WawuIdClient],
    }).compile();
    app = moduleRef.createNestApplication({ logger });
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
    ledger = moduleRef.get(LedgerService);
  });

  afterAll(async () => {
    await prisma.fintavaLedgerEntry.deleteMany({
      where: { accountNumber: { in: accounts } },
    });
    await prisma.userProfile.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await prisma.fintavaWalletOpening.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await prisma.fintavaWallet.deleteMany({
      where: { wawuUserId: { in: users } },
    });
    await app.close();
  });

  describe('who can read', () => {
    it('without a token every route is 401', async () => {
      for (const path of [
        BASE,
        `${BASE}/summary?month=2026-09`,
        `${BASE}/${randomUUID()}`,
      ]) {
        await get(undefined, path).expect(401);
      }
    });

    it('a person with no wallet gets wallet_not_open from every route (R-6), never a 500 or an empty list', async () => {
      const u = newUser();
      for (const path of [
        BASE,
        `${BASE}/summary?month=2026-09`,
        `${BASE}/${randomUUID()}`,
      ]) {
        const res = await get(u.auth, path).expect(409);
        expect(body(res).reason).toEqual({
          code: 'wallet_not_open',
          message: NO_WALLET_MESSAGE,
        });
        expect(body(res).data).toBeNull();
      }
    });

    it('a person whose wallet is being opened gets wallet_opening', async () => {
      const u = newUser();
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: u.id,
          state: 'opening',
          bvnHash: `m15-${u.id}`,
          bvnVerifiedAt: new Date(),
          phone: `+23480${String(Date.now()).slice(-8)}`,
        },
      });
      for (const path of [
        BASE,
        `${BASE}/summary?month=2026-09`,
        `${BASE}/${randomUUID()}`,
      ]) {
        const res = await get(u.auth, path).expect(409);
        expect(body(res).reason).toEqual({
          code: 'wallet_opening',
          message: WALLET_OPENING_MESSAGE,
        });
      }
    });

    it("someone else's transaction is the same 404 as one that does not exist", async () => {
      const a = await withWallet();
      const b = await withWallet();
      const mine = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
      });
      const res = await get(b.auth, `${BASE}/${mine}`).expect(404);
      expect(body(res).reason).toEqual({
        code: 'not_found',
        message: 'We could not find that transaction.',
      });
      const none = await get(b.auth, `${BASE}/${randomUUID()}`).expect(404);
      expect(body(none).reason).toEqual(body(res).reason);
      expect(page(await get(b.auth, BASE).expect(200)).items).toEqual([]);
      await get(a.auth, `${BASE}/${mine}`).expect(200);
    });

    it('only rows on the caller’s own wallet, under the caller, as a person’s wallet, are read', async () => {
      const a = await withWallet();
      const b = await withWallet();
      const mine = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
      });
      // Each of these breaks exactly one of the three: the account number is
      // a's but the person is b; the person is a but the account is another;
      // the row is a merchant-wallet row that names a.
      const otherAccount = nuban();
      accounts.push(otherAccount);
      await ledger.record({
        wallet: { kind: 'user', wawuUserId: b.id, accountNumber: a.account },
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 2000,
        references: { customerReference: `M15-X1-${randomUUID()}` },
        source: 'send',
      });
      await ledger.record({
        wallet: { kind: 'user', wawuUserId: a.id, accountNumber: otherAccount },
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 3000,
        references: { customerReference: `M15-X2-${randomUUID()}` },
        source: 'send',
      });
      await prisma.fintavaLedgerEntry.create({
        data: {
          walletKind: 'merchant',
          wawuUserId: a.id,
          accountNumber: a.account,
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 4000n,
          totalKobo: 4000n,
          source: 'send',
          occurredAt: new Date(),
        },
      });
      expect(
        page(await get(a.auth, BASE).expect(200)).items.map((i) => i.id),
      ).toEqual([mine]);
      expect(
        body<MonthlySummaryView>(
          await get(
            a.auth,
            `${BASE}/summary?month=${new Date(Date.now() + 3_600_000).toISOString().slice(0, 7)}`,
          ).expect(200),
        ).data!.inKobo,
      ).toBe(1000);
      expect(page(await get(b.auth, BASE).expect(200)).items).toEqual([]);
    });

    it('a row on WAWU’s merchant wallet is never in anyone’s history', async () => {
      const a = await withWallet();
      const ref = `M15-MERCH-${randomUUID()}`;
      await ledger.record({
        wallet: { kind: 'merchant', accountNumber: a.account },
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 5000,
        references: { customerReference: ref },
        source: 'send',
      });
      expect(page(await get(a.auth, BASE).expect(200)).items).toEqual([]);
    });
  });

  describe('capability: searching a recipient’s name finds their transfers', () => {
    it('finds every transfer to Chidinma Okoro and nothing else, by any part of her name, any case', async () => {
      const a = await withWallet();
      const chidinma = randomUUID();
      users.push(chidinma);
      await prisma.userProfile.create({
        data: {
          wawuUserId: chidinma,
          accountType: 'creator',
          handle: `chioko${String(Date.now()).slice(-6)}`,
          avatarUrl: 'https://cdn.test.wawu.dev/chidinma.jpg',
        },
      });
      const toHerBank = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 2_500_000,
        feeKobo: 6500,
        providerFeeKobo: 4000,
        wawuFeeKobo: 2500,
        counterparty: {
          kind: 'bank_account',
          name: 'Chidinma Okoro',
          accountNumber: '0123456789',
          bankCode: '000013',
          bankName: 'GTBank',
        },
        occurredAt: at('2026-09-25T10:02:00.000Z'),
      });
      const toHerWallet = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 50_000,
        feeKobo: 2325,
        counterparty: {
          kind: 'wawu_user',
          name: 'Chidinma Okoro',
          wawuUserId: chidinma,
          accountNumber: nuban(),
        },
        occurredAt: at('2026-09-20T08:00:00.000Z'),
      });
      const fromHer = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 70_000,
        counterparty: {
          kind: 'wawu_user',
          name: 'Chidinma Okoro',
          wawuUserId: chidinma,
        },
        occurredAt: at('2026-09-18T08:00:00.000Z'),
      });
      await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 30_000,
        counterparty: {
          kind: 'bank_account',
          name: 'Chinedu Okafor',
          accountNumber: '0987654321',
          bankName: 'Access Bank',
        },
        occurredAt: at('2026-09-19T08:00:00.000Z'),
      });
      await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amountKobo: 200_000,
        counterparty: {
          kind: 'wawu_user',
          name: 'Amaka Nwosu',
          wawuUserId: randomUUID(),
        },
        link: {
          kind: 'tip',
          targetId: a.id,
          title: 'How I light a night shoot',
        },
        occurredAt: at('2026-09-26T09:24:00.000Z'),
      });

      for (const q of ['Chidinma', 'chidinma okoro', 'OKORO', 'dinma O']) {
        const { items } = await all(a.auth, `q=${encodeURIComponent(q)}`);
        expect({ q, ids: items.map((i) => i.id) }).toEqual({
          q,
          ids: [toHerBank, toHerWallet, fromHer],
        });
      }
      // Her handle finds the transfers that name her account on WAWU.
      const profile = await prisma.userProfile.findUniqueOrThrow({
        where: { wawuUserId: chidinma },
      });
      const byHandle = await all(a.auth, `q=${profile.handle}`);
      expect(byHandle.items.map((i) => i.id)).toEqual([toHerWallet, fromHer]);

      // Search and a chip together: only her money out.
      const out = await all(a.auth, 'q=chidinma&filter=money_out');
      expect(out.items.map((i) => i.id)).toEqual([toHerBank, toHerWallet]);

      // The row she is on, as W26 and W27 show it.
      const row = out.items[0];
      expect(row).toMatchObject({
        direction: 'out',
        category: 'transfer',
        status: 'completed',
        amountKobo: 2_500_000,
        fee: { providerFeeKobo: 4000, wawuFeeKobo: 2500, totalFeeKobo: 6500 },
        totalKobo: 2_506_500,
        description: 'Transfer · GTBank',
        counterparty: {
          kind: 'bank_account',
          name: 'Chidinma Okoro',
          avatarUrl: null,
          wawuUserId: null,
          bankName: 'GTBank',
          accountNumberLast4: '6789',
        },
        group: null,
        createdAt: '2026-09-25T10:02:00.000Z',
      });
      const wallet = out.items[1];
      expect(wallet.counterparty).toEqual({
        kind: 'wawu_user',
        name: 'Chidinma Okoro',
        avatarUrl: 'https://cdn.test.wawu.dev/chidinma.jpg',
        wawuUserId: chidinma,
        bankName: null,
        accountNumberLast4: null,
      });
    });

    it('a row a Fintava delivery wrote names the other person by their wallet’s account name, so search finds it', async () => {
      const a = await withWallet();
      const bayo = await withWallet('Bayo Sandbox');
      const handleOnly = newUser();
      await prisma.userProfile.create({
        data: {
          wawuUserId: handleOnly.id,
          accountType: 'user',
          handle: `tolu${String(Date.now()).slice(-6)}`,
        },
      });
      const nobody = randomUUID();
      // As the ledger's consumer writes a wallet-to-wallet delivery: the
      // other side by id and account number, no name.
      const fromBayo = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        counterparty: {
          kind: 'wawu_user',
          name: null,
          wawuUserId: bayo.id,
          accountNumber: bayo.account,
        },
        source: 'webhook',
      });
      const fromTolu = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        counterparty: {
          kind: 'wawu_user',
          name: null,
          wawuUserId: handleOnly.id,
        },
        source: 'webhook',
      });
      const fromNobody = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        counterparty: { kind: 'wawu_user', name: null, wawuUserId: nobody },
        source: 'webhook',
      });
      const rows = new Map(
        (await all(a.auth, '')).items.map((i) => [i.id, i.counterparty?.name]),
      );
      const handle = (
        await prisma.userProfile.findUniqueOrThrow({
          where: { wawuUserId: handleOnly.id },
        })
      ).handle;
      expect(rows.get(fromBayo)).toBe('Bayo Sandbox');
      expect(rows.get(fromTolu)).toBe(`@${handle}`);
      expect(rows.get(fromNobody)).toBe('Someone on Who Made This');
      expect((await all(a.auth, 'q=bayo')).items.map((i) => i.id)).toEqual([
        fromBayo,
      ]);
      // The name the movement recorded wins over the wallet's.
      const named = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        counterparty: {
          kind: 'wawu_user',
          name: 'Bayo S.',
          wawuUserId: bayo.id,
        },
      });
      const v = body<TransactionView>(
        await get(a.auth, `${BASE}/${named}`).expect(200),
      ).data!;
      expect(v.counterparty?.name).toBe('Bayo S.');
    });

    it('a name that is nobody’s finds nothing, and search characters are only characters', async () => {
      const a = await withWallet();
      await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        counterparty: {
          kind: 'bank_account',
          name: 'Ada_Obi 100%',
          accountNumber: '0123456789',
          bankName: 'GTBank',
        },
        note: 'back\\slash',
      });
      await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        counterparty: {
          kind: 'bank_account',
          name: 'AdaXObi 1000',
          accountNumber: '0123456780',
          bankName: 'GTBank',
        },
      });
      expect((await all(a.auth, 'q=Bolanle')).items).toEqual([]);
      expect(
        (await all(a.auth, `q=${encodeURIComponent('%%')}`)).items,
      ).toEqual([]);
      expect(
        (await all(a.auth, `q=${encodeURIComponent('a_O')}`)).items.map(
          (i) => i.counterparty?.name,
        ),
      ).toEqual(['Ada_Obi 100%']);
      expect(
        (await all(a.auth, `q=${encodeURIComponent('0%')}`)).items.map(
          (i) => i.counterparty?.name,
        ),
      ).toEqual(['Ada_Obi 100%']);
      expect(
        (await all(a.auth, `q=${encodeURIComponent('k\\s')}`)).items.length,
      ).toBe(1);
      // Spaces around the words are not part of the search.
      expect(
        (await all(a.auth, `q=${encodeURIComponent('  adaxobi  ')}`)).items
          .length,
      ).toBe(1);
    });

    it('the note, the reference and the description are searched too', async () => {
      const a = await withWallet();
      const ref = `WAW-${randomUUID().slice(0, 8).toUpperCase()}`;
      const byRef = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        counterparty: {
          kind: 'bank_account',
          name: 'Bisi Ade',
          accountNumber: '0123456789',
          bankName: 'Zenith Bank',
        },
        ref,
      });
      const byNote = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        counterparty: {
          kind: 'bank_account',
          name: 'Tunde Bello',
          accountNumber: '0123456781',
          bankName: 'Kuda',
        },
        note: 'September rent',
      });
      const tip = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amountKobo: 1000,
        counterparty: {
          kind: 'wawu_user',
          name: 'Amaka Nwosu',
          wawuUserId: randomUUID(),
        },
        link: {
          kind: 'tip',
          targetId: a.id,
          title: 'How I light a night shoot',
        },
      });
      expect(
        (await all(a.auth, `q=${ref.toLowerCase()}`)).items.map((i) => i.id),
      ).toEqual([byRef]);
      expect((await all(a.auth, 'q=rent')).items.map((i) => i.id)).toEqual([
        byNote,
      ]);
      expect((await all(a.auth, 'q=zenith')).items.map((i) => i.id)).toEqual([
        byRef,
      ]);
      expect(
        (await all(a.auth, 'q=night shoot')).items.map((i) => i.id),
      ).toEqual([tip]);
      expect((await all(a.auth, 'q=tip')).items.map((i) => i.id)).toEqual([
        tip,
      ]);
      const detail = body<TransactionView>(
        await get(a.auth, `${BASE}/${byRef}`).expect(200),
      ).data!;
      expect(detail.reference).toBe(ref);
    });

    it('a search shorter than 2 or longer than 60 characters is refused', async () => {
      const a = await withWallet();
      await get(a.auth, `${BASE}?q=a`).expect(400);
      await get(a.auth, `${BASE}?q=${'x'.repeat(61)}`).expect(400);
      await get(a.auth, `${BASE}?q=${'x'.repeat(60)}`).expect(200);
    });
  });

  describe('capability: monthly totals equal the sum of that month’s rows', () => {
    it('In and Out for September are the sums of September’s completed rows, by Africa/Lagos time', async () => {
      const a = await withWallet();
      const sept: Move[] = [
        // 00:30 on 1 September in Lagos (still 31 August in UTC): September.
        {
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 10_000_000,
          occurredAt: at('2026-08-31T23:30:00.000Z'),
        },
        {
          direction: 'in',
          status: 'completed',
          category: 'earning',
          amountKobo: 200_000,
          occurredAt: at('2026-09-26T09:24:00.000Z'),
          link: { kind: 'tip', targetId: 'x', title: 'Night shoot' },
        },
        {
          direction: 'out',
          status: 'completed',
          category: 'bill',
          amountKobo: 1_050_000,
          feeKobo: 10_000,
          occurredAt: at('2026-09-25T17:40:00.000Z'),
        },
        {
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: 2_500_000,
          feeKobo: 6_500,
          occurredAt: at('2026-09-25T10:02:00.000Z'),
        },
        {
          direction: 'out',
          status: 'completed',
          category: 'bill',
          amountKobo: 200_000,
          occurredAt: at('2026-09-26T07:15:00.000Z'),
        },
        {
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: 1,
          feeKobo: 1_575,
          occurredAt: at('2026-09-30T22:59:59.999Z'),
        },
      ];
      // Not in September's figures: not completed, or another month in Lagos.
      const notCounted: Move[] = [
        {
          direction: 'out',
          status: 'pending',
          category: 'transfer',
          amountKobo: 999_900,
          occurredAt: at('2026-09-10T10:00:00.000Z'),
        },
        {
          direction: 'out',
          status: 'failed',
          category: 'transfer',
          amountKobo: 888_800,
          occurredAt: at('2026-09-11T10:00:00.000Z'),
        },
        {
          direction: 'in',
          status: 'pending',
          category: 'top_up',
          amountKobo: 777_700,
          occurredAt: at('2026-09-12T10:00:00.000Z'),
        },
        // 00:00 on 1 October in Lagos.
        {
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 123_400,
          occurredAt: at('2026-09-30T23:00:00.000Z'),
        },
        {
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: 5_000,
          occurredAt: at('2026-08-31T22:59:59.999Z'),
        },
      ];
      for (const m of [...sept, ...notCounted]) await record(a, m);
      // A send that failed and came back: reversed, so not money out.
      const reversedRef = `M15-REV-${randomUUID()}`;
      await record(a, {
        direction: 'out',
        status: 'failed',
        category: 'transfer',
        amountKobo: 400_000,
        feeKobo: 4_000,
        occurredAt: at('2026-09-15T10:00:00.000Z'),
        ref: reversedRef,
      });
      const rev = await ledger.applyReversal({
        references: [reversedRef],
        reversalReference: `REV-${reversedRef}`,
        amountKobo: 400_000,
        chargesKobo: 4_000,
        totalKobo: 404_000,
        at: at('2026-09-15T11:00:00.000Z'),
      });
      expect(rev.state).toBe('applied');

      const summary = body<MonthlySummaryView>(
        await get(a.auth, `${BASE}/summary?month=2026-09`).expect(200),
      ).data!;

      // The rows of that month, read through the history itself.
      const { items } = await all(a.auth, 'month=2026-09', 3);
      const completed = items.filter((i) => i.status === 'completed');
      const sumOf = (d: 'in' | 'out') =>
        completed
          .filter((i) => i.direction === d)
          .reduce((s, i) => s + i.totalKobo, 0);
      expect(summary).toEqual({
        month: '2026-09',
        inKobo: sumOf('in'),
        outKobo: sumOf('out'),
      });
      expect(summary).toEqual({
        month: '2026-09',
        inKobo: 10_200_000,
        outKobo: 1_060_000 + 2_506_500 + 200_000 + 1_576,
      });
      expect(items.length).toBe(sept.length + 4);
      expect(items.map((i) => i.status).sort()).toEqual(
        [
          ...Array<string>(sept.length).fill('completed'),
          'failed',
          'pending',
          'pending',
          'reversed',
        ].sort(),
      );

      // A month with nothing is zero, never an error; the body has no balance in it.
      const empty = await get(a.auth, `${BASE}/summary?month=2025-01`).expect(
        200,
      );
      expect(body(empty).data).toEqual({
        month: '2025-01',
        inKobo: 0,
        outKobo: 0,
      });
      expect(empty.text).not.toMatch(/balance/i);
    });

    it('a grouped row never changes the month’s totals', async () => {
      const a = await withWallet();
      for (let i = 0; i < 3; i += 1) {
        await record(a, {
          direction: 'in',
          status: 'completed',
          category: 'earning',
          amountKobo: 250_000,
          link: {
            kind: 'content_unlock',
            targetId: 'piece-1',
            title: 'Lighting night shoots',
          },
          occurredAt: at(`2026-09-26T0${7 + i}:02:00.000Z`),
        });
      }
      const s = body<MonthlySummaryView>(
        await get(a.auth, `${BASE}/summary?month=2026-09`).expect(200),
      ).data!;
      const { items } = await all(a.auth, 'month=2026-09');
      expect(items.length).toBe(1);
      expect(s.inKobo).toBe(items[0].totalKobo);
      expect(s.inKobo).toBe(750_000);
    });

    it('a month is YYYY-MM: anything else is a 400', async () => {
      const a = await withWallet();
      for (const m of [
        '2026-9',
        '2026-13',
        '2026-00',
        'September',
        '0000-01',
        '2026-09-01',
      ]) {
        await get(a.auth, `${BASE}/summary?month=${m}`).expect(400);
        await get(a.auth, `${BASE}?month=${m}`).expect(400);
      }
      await get(a.auth, `${BASE}/summary`).expect(400);
    });
  });

  describe('pages, newest first', () => {
    it('45 rows in pages of 20: every row once, newest first, and a row landing mid-scroll shifts nothing', async () => {
      const a = await withWallet();
      const ids: string[] = [];
      const t0 = Date.parse('2026-09-01T00:00:00.000Z');
      for (let i = 0; i < 45; i += 1) {
        // Two rows share each minute, so the id breaks the tie.
        ids.push(
          await record(a, {
            direction: i % 2 ? 'in' : 'out',
            status: 'completed',
            category: 'transfer',
            amountKobo: 100 + i,
            occurredAt: new Date(t0 + Math.floor(i / 2) * 60_000),
          }),
        );
      }
      const first = page(await get(a.auth, `${BASE}?limit=20`).expect(200));
      expect(first.items.length).toBe(20);
      expect(first.nextCursor).toEqual(expect.any(String));
      // A new row arrives while the person scrolls.
      const late = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1,
        occurredAt: new Date(),
      });
      const second = page(
        await get(a.auth, `${BASE}?limit=20&cursor=${first.nextCursor}`).expect(
          200,
        ),
      );
      const third = page(
        await get(
          a.auth,
          `${BASE}?limit=20&cursor=${second.nextCursor}`,
        ).expect(200),
      );
      expect(third.nextCursor).toBeNull();
      const seen = [...first.items, ...second.items, ...third.items];
      expect(seen.length).toBe(45);
      expect(new Set(seen.map((i) => i.id)).size).toBe(45);
      expect(seen.map((i) => i.id)).not.toContain(late);
      const order = seen.map((i) => [Date.parse(i.createdAt), i.id] as const);
      for (let i = 1; i < order.length; i += 1) {
        const [ta, ia] = order[i - 1];
        const [tb, ib] = order[i];
        expect(ta > tb || (ta === tb && ia > ib)).toBe(true);
      }
      expect(new Set(seen.map((i) => i.id))).toEqual(new Set(ids));
      // Refreshed, the new row is first.
      expect(
        page(await get(a.auth, `${BASE}?limit=1`).expect(200)).items[0].id,
      ).toBe(late);
    });

    it('the default page is 20; limit is 1 to 100; a cursor this history did not give is a 400', async () => {
      const a = await withWallet();
      for (let i = 0; i < 21; i += 1) {
        await record(a, {
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 1 + i,
        });
      }
      expect(page(await get(a.auth, BASE).expect(200)).items.length).toBe(20);
      for (const l of ['0', '101', '-1', '1.5', 'x'])
        await get(a.auth, `${BASE}?limit=${l}`).expect(400);
      const valid = page(
        await get(a.auth, `${BASE}?limit=1`).expect(200),
      ).nextCursor!;
      for (const c of [
        'nonsense',
        'c1.',
        `c1.${Buffer.from('["x","y"]').toString('base64url')}`,
        `c1.${Buffer.from('{}').toString('base64url')}`,
        `g1.${valid.slice(3)}`,
        `${valid}=`,
        `c1.${Buffer.from(`["2026-09-01T00:00:00.000Z","${randomUUID()}\\u0000"]`).toString('base64url')}`,
      ]) {
        const res = await get(
          a.auth,
          `${BASE}?cursor=${encodeURIComponent(c)}`,
        ).expect(400);
        expect(body(res).message).toBe('cursor is not one this history gave.');
      }
    });

    it('two people scrolling at once each see only their own rows', async () => {
      const a = await withWallet();
      const b = await withWallet();
      for (let i = 0; i < 5; i += 1) {
        await record(a, {
          direction: 'in',
          status: 'completed',
          category: 'transfer',
          amountKobo: 10 + i,
        });
        await record(b, {
          direction: 'out',
          status: 'completed',
          category: 'transfer',
          amountKobo: 20 + i,
        });
      }
      const res = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          get(i % 2 ? b.auth : a.auth, `${BASE}?limit=100`),
        ),
      );
      res.forEach((r, i) => {
        expect(r.status).toBe(200);
        const items = page(r).items;
        expect(items.length).toBe(5);
        expect(new Set(items.map((x) => x.direction))).toEqual(
          new Set([i % 2 ? 'out' : 'in']),
        );
      });
    });
  });

  describe('filter chips (W26) and an empty month (W28)', () => {
    it('All, Money in, Money out, Bills and Content keep what they say', async () => {
      const a = await withWallet();
      const inTransfer = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'transfer',
        amountKobo: 1000,
        occurredAt: at('2026-09-01T10:00:00.000Z'),
      });
      const bill = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'bill',
        amountKobo: 1000,
        feeKobo: 10_000,
        counterparty: { kind: 'biller', name: 'Ikeja Electric' },
        link: { kind: 'bill', targetId: 'bill-1', title: 'Prepaid' },
        occurredAt: at('2026-10-02T10:00:00.000Z'),
      });
      const heldBill = await record(a, {
        direction: 'out',
        status: 'pending',
        category: 'hold',
        amountKobo: 2000,
        link: { kind: 'bill', targetId: 'bill-2', title: 'DSTV' },
        occurredAt: at('2026-10-02T11:00:00.000Z'),
      });
      const unlockBought = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'purchase',
        amountKobo: 3000,
        link: {
          kind: 'content_unlock',
          targetId: 'p9',
          title: 'Pattern drafting',
        },
        occurredAt: at('2026-10-02T12:00:00.000Z'),
      });
      const tip = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amountKobo: 4000,
        link: { kind: 'tip', targetId: a.id, title: 'Night shoot' },
        occurredAt: at('2026-10-02T13:00:00.000Z'),
      });
      const credits = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'purchase',
        amountKobo: 5000,
        link: {
          kind: 'credit_pack',
          targetId: 'popular',
          title: 'Popular pack',
        },
        occurredAt: at('2026-10-02T14:00:00.000Z'),
      });
      const ids = async (f: string) =>
        (await all(a.auth, `filter=${f}`)).items.map((i) => i.id);
      expect(await ids('all')).toEqual([
        credits,
        tip,
        unlockBought,
        heldBill,
        bill,
        inTransfer,
      ]);
      expect(await ids('money_in')).toEqual([tip, inTransfer]);
      expect(await ids('money_out')).toEqual([
        credits,
        unlockBought,
        heldBill,
        bill,
      ]);
      expect(await ids('bills')).toEqual([heldBill, bill]);
      expect(await ids('content')).toEqual([tip, unlockBought]);
      await get(a.auth, `${BASE}?filter=everything`).expect(400);
      // W28: Bills in September is empty.
      const w28 = page(
        await get(a.auth, `${BASE}?filter=bills&month=2026-09`).expect(200),
      );
      expect(w28).toEqual({ items: [], nextCursor: null });
      // Descriptions as the row shows them.
      const byId = new Map((await all(a.auth, '')).items.map((i) => [i.id, i]));
      expect(byId.get(bill)!.description).toBe('Bill · Prepaid');
      expect(byId.get(heldBill)!.description).toBe('Held payment · DSTV');
      expect(byId.get(unlockBought)!.description).toBe(
        'Unlock · Pattern drafting',
      );
      expect(byId.get(credits)!.description).toBe('Credits · Popular pack');
      expect(byId.get(inTransfer)!.description).toBe('Transfer');
      expect(byId.get(credits)!.link).toEqual({
        kind: 'credit_pack',
        targetId: 'popular',
        title: 'Popular pack',
      });
    });
  });

  describe('grouped unlock earnings (W26, WALLET.md Lead ruling 3)', () => {
    it('three unlocks of one piece on one Lagos day are one row; group=<key> lists them', async () => {
      const a = await withWallet();
      const piece = {
        kind: 'content_unlock' as const,
        targetId: `piece-${randomUUID()}`,
        title: 'Lighting night shoots',
      };
      const unlocks: string[] = [];
      // 23:10 UTC on the 25th is 00:10 on the 26th in Lagos.
      for (const t of [
        '2026-09-25T23:10:00.000Z',
        '2026-09-26T06:00:00.000Z',
        '2026-09-26T08:02:00.000Z',
      ]) {
        unlocks.push(
          await record(a, {
            direction: 'in',
            status: 'completed',
            category: 'earning',
            amountKobo: 250_000,
            link: piece,
            counterparty: {
              kind: 'wawu_user',
              name: `Kemi ${t}`,
              wawuUserId: randomUUID(),
            },
            occurredAt: at(t),
          }),
        );
      }
      // The same piece the day before (22:59 UTC on the 25th is 23:59 in Lagos): its own row.
      const dayBefore = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amountKobo: 250_000,
        link: piece,
        occurredAt: at('2026-09-25T22:59:00.000Z'),
      });
      // Not completed: never grouped.
      const pendingUnlock = await record(a, {
        direction: 'in',
        status: 'pending',
        category: 'earning',
        amountKobo: 250_000,
        link: piece,
        occurredAt: at('2026-09-26T09:00:00.000Z'),
      });
      // Another piece the same day, and a tip on the same piece: their own rows.
      const other = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amountKobo: 100_000,
        link: { ...piece, targetId: `piece-${randomUUID()}`, title: 'Other' },
        occurredAt: at('2026-09-26T07:00:00.000Z'),
      });
      const tipped = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amountKobo: 50_000,
        link: { kind: 'tip', targetId: piece.targetId, title: piece.title },
        occurredAt: at('2026-09-26T07:30:00.000Z'),
      });

      const { items } = await all(a.auth, '', 2);
      expect(items.map((i) => i.id)).toEqual([
        pendingUnlock,
        unlocks[2],
        tipped,
        other,
        dayBefore,
      ]);
      const g = items[1];
      expect(g).toMatchObject({
        direction: 'in',
        category: 'earning',
        status: 'completed',
        amountKobo: 750_000,
        fee: { providerFeeKobo: 0, wawuFeeKobo: 0, totalFeeKobo: 0 },
        totalKobo: 750_000,
        description: 'Unlock · Lighting night shoots · 3 buyers',
        counterparty: null,
        link: piece,
        note: null,
        transferId: null,
        paymentId: null,
        createdAt: '2026-09-26T08:02:00.000Z',
        group: {
          count: 3,
          firstAt: '2026-09-25T23:10:00.000Z',
          lastAt: '2026-09-26T08:02:00.000Z',
        },
      });
      for (const id of [dayBefore, pendingUnlock, other, tipped]) {
        expect(items.find((i) => i.id === id)!.group).toBeNull();
      }
      // Filters and search see the grouped row.
      expect(
        (await all(a.auth, 'filter=content')).items.map((i) => i.id),
      ).toContain(unlocks[2]);
      expect(
        (await all(a.auth, 'filter=money_in')).items.map((i) => i.id),
      ).toContain(unlocks[2]);
      expect((await all(a.auth, 'filter=money_out')).items).toEqual([]);
      expect((await all(a.auth, 'q=3 buyers')).items.map((i) => i.id)).toEqual([
        unlocks[2],
      ]);
      // A buyer's name is on the movements, not on the grouped row.
      expect((await all(a.auth, 'q=Kemi')).items).toEqual([]);

      const members = await all(
        a.auth,
        `group=${encodeURIComponent(g.group!.key)}`,
        2,
      );
      expect(members.pages).toBe(2);
      expect(members.items.map((i) => i.id)).toEqual([...unlocks].reverse());
      for (const m of members.items) {
        expect(m).toMatchObject({
          amountKobo: 250_000,
          totalKobo: 250_000,
          group: null,
          description: 'Unlock · Lighting night shoots',
        });
        expect(m.counterparty?.name).toMatch(/^Kemi /);
      }
      // Someone else's key lists nothing of the owner's.
      const b = await withWallet();
      expect(
        (await all(b.auth, `group=${encodeURIComponent(g.group!.key)}`)).items,
      ).toEqual([]);
      // A key this history did not give.
      for (const k of [
        'x',
        'g1.',
        `g1.${Buffer.from('["p","2026-13-01"]').toString('base64url')}`,
        `g1.${Buffer.from('["","2026-09-26"]').toString('base64url')}`,
      ]) {
        const res = await get(
          a.auth,
          `${BASE}?group=${encodeURIComponent(k)}`,
        ).expect(400);
        expect(body(res).message).toBe('group is not a key this history gave.');
      }
      // A unlock alone that day is an ordinary row.
      const single = await withWallet();
      const lone = await record(single, {
        direction: 'in',
        status: 'completed',
        category: 'earning',
        amountKobo: 250_000,
        link: piece,
      });
      const only = page(await get(single.auth, BASE).expect(200)).items;
      expect(only.map((i) => [i.id, i.group])).toEqual([[lone, null]]);
    });
  });

  describe('one transaction (W27) and its real state', () => {
    it('shows the ledger’s status as Fintava moves it: pending, then completed; a failed send that came back is reversed', async () => {
      const a = await withWallet();
      const ref = `M15-STATE-${randomUUID()}`;
      const move: Move = {
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 2_500_000,
        feeKobo: 4_000,
        ref,
        counterparty: {
          kind: 'bank_account',
          name: 'Chidinma Okoro',
          accountNumber: '0123456789',
          bankName: 'GTBank',
        },
      };
      const id = await record(a, move);
      const read = async () =>
        body<TransactionView>(await get(a.auth, `${BASE}/${id}`).expect(200))
          .data!;
      expect((await read()).status).toBe('pending');
      // Fintava's webhook says SUCCESS: the ledger merges it into the same row.
      expect(
        await record(a, { ...move, status: 'completed', source: 'webhook' }),
      ).toBe(id);
      expect((await read()).status).toBe('completed');

      const ref2 = `M15-STATE2-${randomUUID()}`;
      const id2 = await record(a, { ...move, ref: ref2, status: 'failed' });
      expect(
        (
          await ledger.applyReversal({
            references: [ref2],
            reversalReference: `REV-${ref2}`,
            amountKobo: 2_500_000,
            chargesKobo: 4_000,
            totalKobo: 2_504_000,
            at: new Date(),
          })
        ).state,
      ).toBe('applied');
      const r2 = body<TransactionView>(
        await get(a.auth, `${BASE}/${id2}`).expect(200),
      ).data!;
      expect(r2.status).toBe('reversed');

      // A sighting that disagrees with the stored figures moves nothing: it stays as stored.
      const ref3 = `M15-STATE3-${randomUUID()}`;
      const id3 = await record(a, { ...move, ref: ref3 });
      const dis = await ledger.record({
        ...move,
        amountKobo: 2_600_000,
        status: 'completed',
        wallet: { kind: 'user', wawuUserId: a.id, accountNumber: a.account },
        references: { customerReference: ref3 },
        source: 'webhook',
      });
      expect(dis.discrepancy).not.toBeNull();
      const r3 = body<TransactionView>(
        await get(a.auth, `${BASE}/${id3}`).expect(200),
      ).data!;
      expect(r3).toMatchObject({ status: 'pending', amountKobo: 2_500_000 });
    });

    it('a debit shows the amount, Fintava’s charge, WAWU’s fee and the total (R-10, W27); the full account number never leaves', async () => {
      const a = await withWallet();
      const transferId = randomUUID();
      const id = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 2_500_000,
        feeKobo: 6_500,
        providerFeeKobo: 4_000,
        wawuFeeKobo: 2_500,
        note: 'Rent',
        transferId,
        counterparty: {
          kind: 'bank_account',
          name: 'Chidinma Okoro',
          accountNumber: '0123456789',
          bankCode: '000013',
          bankName: 'GTBank',
        },
        ref: 'WAW-T1P9-7ZQA',
        occurredAt: at('2026-09-26T09:24:00.000Z'),
      });
      const res = await get(a.auth, `${BASE}/${id}`).expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const v = body<TransactionView>(res).data!;
      expect(v).toEqual({
        id,
        direction: 'out',
        category: 'transfer',
        status: 'completed',
        amountKobo: 2_500_000,
        fee: {
          providerFeeKobo: 4_000,
          wawuFeeKobo: 2_500,
          totalFeeKobo: 6_500,
        },
        totalKobo: 2_506_500,
        description: 'Transfer · GTBank',
        counterparty: {
          kind: 'bank_account',
          name: 'Chidinma Okoro',
          avatarUrl: null,
          wawuUserId: null,
          bankName: 'GTBank',
          accountNumberLast4: '6789',
        },
        link: null,
        note: 'Rent',
        reference: 'WAW-T1P9-7ZQA',
        transferId,
        paymentId: null,
        group: null,
        createdAt: '2026-09-26T09:24:00.000Z',
      });
      expect(res.text).not.toContain('0123456789');
      expect(res.text).not.toContain(a.account);
      expect(res.text).not.toContain('000013');
    });

    it('a quoted split that does not add up to Fintava’s total is not shown: Fintava’s charge is', async () => {
      const a = await withWallet();
      const id = await record(a, {
        direction: 'out',
        status: 'completed',
        category: 'transfer',
        amountKobo: 2_500_000,
        feeKobo: 4_000,
        providerFeeKobo: 4_000,
        wawuFeeKobo: 2_500,
      });
      const v = body<TransactionView>(
        await get(a.auth, `${BASE}/${id}`).expect(200),
      ).data!;
      expect(v.fee).toEqual({
        providerFeeKobo: 4_000,
        wawuFeeKobo: 0,
        totalFeeKobo: 4_000,
      });
      expect(v.totalKobo).toBe(2_504_000);
    });

    it('a money-in row has no fees, and every figure is exact integer kobo up to 2^53 - 1', async () => {
      const a = await withWallet();
      const id = await record(a, {
        direction: 'in',
        status: 'completed',
        category: 'top_up',
        amountKobo: Number.MAX_SAFE_INTEGER,
        counterparty: {
          kind: 'bank_account',
          name: null,
          accountNumber: '12',
          bankName: null,
        },
      });
      const res = await get(a.auth, `${BASE}/${id}`).expect(200);
      const v = body<TransactionView>(res).data!;
      expect(v.amountKobo).toBe(Number.MAX_SAFE_INTEGER);
      expect(v.totalKobo).toBe(Number.MAX_SAFE_INTEGER);
      expect(res.text).toContain('"amountKobo":9007199254740991');
      expect(v.fee).toEqual({
        providerFeeKobo: 0,
        wawuFeeKobo: 0,
        totalFeeKobo: 0,
      });
      expect(v.description).toBe('Top up');
      expect(v.counterparty).toEqual({
        kind: 'bank_account',
        name: 'Bank account',
        avatarUrl: null,
        wawuUserId: null,
        bankName: null,
        accountNumberLast4: null,
      });
      // The reference falls back to the row's own id when Fintava gave none we keep.
      expect(v.reference).toEqual(expect.any(String));
    });

    it('an id that is not a uuid is a 400', async () => {
      const a = await withWallet();
      await get(a.auth, `${BASE}/not-a-uuid`).expect(400);
      await get(a.auth, `${BASE}/${randomUUID()}x`).expect(400);
    });
  });

  it('never answers a balance: no route here names one', async () => {
    const a = await withWallet();
    await record(a, {
      direction: 'in',
      status: 'completed',
      category: 'transfer',
      amountKobo: 1000,
    });
    for (const path of [BASE, `${BASE}/summary?month=2026-10`]) {
      const res = await get(a.auth, path).expect(200);
      expect(res.text).not.toMatch(/balance/i);
    }
  });
});
