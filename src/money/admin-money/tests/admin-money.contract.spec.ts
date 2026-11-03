/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- response bodies are read loosely, as the other contract specs do */
import { randomUUID } from 'node:crypto';
import { type INestApplication, Module, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  AdminRole,
  type StoreProductKind,
} from '../../../../generated/prisma/enums';
import { AdminAuthModule } from '../../../admin/auth/admin-auth.module';
import { AdminTokenService } from '../../../admin/auth/admin-token.service';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { loadPlansConfig, PLANS_CONFIG } from '../../../plans/plans-config';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import { AdminMoneyController } from '../admin-money.controller';
import { AdminMoneyRevenueService } from '../admin-money-revenue.service';
import { AdminMoneyWalletsService } from '../admin-money-wallets.service';

/**
 * The dashboard's views of the app's money (DASH-B-HUB). A real database and
 * the real guards; the wallet provider is a double that answers the figures
 * set for it (a balance the double holds is never a sum of rows), and counts
 * what it was asked. Every seeded row carries a token of its own, and the
 * revenue windows sit in years nothing else writes, so the suite shares a
 * database with the rest.
 */

const RUN = randomUUID().slice(0, 8);
const BASE = '/api/hub/admin/money';

/** The provider double: balances by wallet id, errors by wallet id, a counter. */
const balances = new Map<string, bigint>();
const failing = new Set<string>();
const slow = new Set<string>();
const asked: string[] = [];
let platform: { available: bigint; booked: bigint } | 'down' = {
  available: 0n,
  booked: 0n,
};
const providerDouble = {
  name: 'nuvion' as const,
  label: 'Nuvion',
  getBalance: ({ walletId }: { walletId: string }) => {
    asked.push(walletId);
    if (slow.has(walletId)) return new Promise(() => undefined);
    if (failing.has(walletId)) return Promise.reject(new Error('timeout'));
    const v = balances.get(walletId);
    if (v === undefined) return Promise.reject(new Error('unknown wallet'));
    return Promise.resolve({ availableKobo: v, bookedKobo: v + 500n });
  },
  getPlatformAccount: () =>
    platform === 'down'
      ? Promise.reject(new Error('down'))
      : Promise.resolve({
          availableKobo: platform.available,
          bookedKobo: platform.booked,
          accountNumber: '9000000123',
          accountName: 'WAWU Operations',
        }),
};

@Module({
  imports: [AdminAuthModule],
  controllers: [AdminMoneyController],
  providers: [
    AdminMoneyWalletsService,
    AdminMoneyRevenueService,
    { provide: WALLET_PROVIDER, useValue: providerDouble },
    { provide: PLANS_CONFIG, useFactory: () => loadPlansConfig() },
  ],
})
class UnderTestModule {}

interface Json {
  data: any;
}

describe('Admin: the app’s money (DASH-B-HUB)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const previous: Record<string, string | undefined> = {};
  const adminIds: string[] = [];
  const tokens: Partial<Record<AdminRole, string>> = {};
  const users: string[] = [];
  const paymentIds: string[] = [];
  const productIds: string[] = [];
  const registrationIds: string[] = [];
  let accountSeq = 0;

  const get = (path: string, role: AdminRole = AdminRole.finance) =>
    request(app.getHttpServer())
      .get(path)
      .set('Authorization', `Bearer ${tokens[role]}`);

  /** A wallet of `provider` with a handle that contains this run's token. */
  async function wallet(
    tag: string,
    opts: {
      provider?: string | null;
      balance?: bigint;
      at?: Date;
      accountName?: string;
    } = {},
  ) {
    const id = randomUUID();
    users.push(id);
    const walletId = randomUUID();
    accountSeq += 1;
    await prisma.userProfile.create({
      data: {
        wawuUserId: id,
        accountType: 'user',
        handle: `${tag}${RUN}${accountSeq}`.toLowerCase(),
      },
    });
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: randomUUID(),
        walletId,
        accountNumber: `70${RUN.replace(/\D/g, '1').padEnd(4, '1').slice(0, 4)}${String(accountSeq).padStart(4, '0')}`,
        accountName: opts.accountName ?? null,
        provider: opts.provider === undefined ? 'nuvion' : opts.provider,
        createdAt: opts.at,
      },
    });
    if (opts.balance !== undefined) balances.set(walletId, opts.balance);
    return { id, walletId, handle: `${tag}${RUN}${accountSeq}`.toLowerCase() };
  }

  async function payment(
    kind: string,
    o: {
      price: bigint;
      payee?: bigint;
      wawu?: bigint;
      completedAt: Date;
      status?: string;
      provider?: string;
      payer?: string | null;
    },
  ) {
    const id = randomUUID();
    paymentIds.push(id);
    const payeeShare = o.payee ?? (o.price * 85n) / 100n;
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: o.payer ?? null,
        kind,
        targetId: randomUUID(),
        title: `dashb ${RUN}`,
        priceKobo: o.price,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: o.price,
        payeeShareKobo: payeeShare,
        wawuShareKobo: o.wawu ?? o.price - payeeShare,
        customerReference: `dashb-${RUN}-${id}`,
        merchantAccountNumber: '9000000123',
        provider: o.provider ?? 'nuvion',
        status: o.status ?? 'completed',
        completedAt: o.completedAt,
      },
    });
    return id;
  }

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      ADMIN_JWT_SECRET: 'dashb-admin-access-secret-0123456789abcdef',
      ADMIN_JWT_REFRESH_SECRET: 'dashb-admin-refresh-secret-0123456789abcdef',
    })) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        UnderTestModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    const issuer = moduleRef.get(AdminTokenService);
    for (const role of [
      AdminRole.superadmin,
      AdminRole.finance,
      AdminRole.support,
      AdminRole.reviewer,
    ]) {
      const id = randomUUID();
      adminIds.push(id);
      const admin = await prisma.adminUser.create({
        data: {
          id,
          email: `dashb-${role}-${id}@admin.test.wawu.dev`,
          passwordHash: 'not-a-real-hash',
          name: `DASH-B ${role}`,
          role,
        },
      });
      tokens[role] = issuer.issuePair(admin).accessToken;
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.walletHold.deleteMany({
        where: { paymentId: { in: paymentIds } },
      });
      await prisma.walletPayment.deleteMany({
        where: { id: { in: paymentIds } },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.userProfile.deleteMany({
        where: { wawuUserId: { in: users } },
      });
      await prisma.storePurchase.deleteMany({
        where: { productId: { in: productIds } },
      });
      await prisma.storeProduct.deleteMany({
        where: { id: { in: productIds } },
      });
      await prisma.waitlistRegistration.deleteMany({
        where: { id: { in: registrationIds } },
      });
      await prisma.adminUser.deleteMany({ where: { id: { in: adminIds } } });
    }
    if (app) await app.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  beforeEach(() => {
    asked.length = 0;
    failing.clear();
    slow.clear();
  });

  describe('who may read', () => {
    const paths = [
      `${BASE}/wallets`,
      `${BASE}/wallets/someone`,
      `${BASE}/merchant`,
      `${BASE}/revenue`,
    ];
    it.each(paths)('%s: no token is 401', async (p) => {
      await request(app.getHttpServer()).get(p).expect(401);
    });
    it.each(
      paths.flatMap((p) =>
        [AdminRole.support, AdminRole.reviewer].map((role) => ({ p, role })),
      ),
    )(
      '$p: $role is refused with 403 and the provider is never asked',
      async ({ p, role }) => {
        await get(p, role).expect(403);
        expect(asked).toEqual([]);
      },
    );
    it.each(
      [`${BASE}/wallets`, `${BASE}/merchant`, `${BASE}/revenue`].flatMap((p) =>
        [AdminRole.finance, AdminRole.superadmin].map((role) => ({ p, role })),
      ),
    )('$p: $role reads', async ({ p, role }) => {
      await get(p, role).expect(200);
    });
  });

  describe('wallets', () => {
    it('lists only the running provider’s wallets, last four digits only, no balance unless asked', async () => {
      const mine = await wallet('lista');
      const other = await wallet('lista', { provider: 'fintava' });
      const legacy = await wallet('lista', { provider: null });
      const res = await get(`${BASE}/wallets?q=lista${RUN}`).expect(200);
      const items = (res.body as Json).data.items as any[];
      expect(items.map((i) => i.wawuId)).toEqual([mine.id]);
      expect(items.map((i) => i.wawuId)).not.toContain(other.id);
      expect(items.map((i) => i.wawuId)).not.toContain(legacy.id);
      const row = items[0];
      expect(row.handle).toBe(mine.handle);
      expect(row.provider).toBe('nuvion');
      expect(row.accountLast4).toMatch(/^\d{4}$/);
      expect(row.status).toBe('open');
      expect(JSON.stringify(row)).not.toMatch(/"accountNumber"/);
      expect(row).not.toHaveProperty('balance');
      expect(row).not.toHaveProperty('balanceUnavailable');
      expect(asked).toEqual([]);
    });

    it('finds by handle, by WAWU id, by account name and by last digits', async () => {
      const w = await wallet('findb', { accountName: `Ada ${RUN} Okoro` });
      const a = await get(`${BASE}/wallets?q=@FINDB${RUN}`).expect(200);
      expect((a.body as Json).data.items.map((i: any) => i.wawuId)).toEqual([
        w.id,
      ]);
      const b = await get(`${BASE}/wallets?q=${w.id}`).expect(200);
      expect((b.body as Json).data.items.map((i: any) => i.wawuId)).toEqual([
        w.id,
      ]);
      const c = await get(
        `${BASE}/wallets?q=${encodeURIComponent(`ada ${RUN} okoro`)}`,
      ).expect(200);
      expect((c.body as Json).data.items[0].displayName).toBe(
        `Ada ${RUN} Okoro`,
      );
    });

    it('pages by cursor, newest first', async () => {
      const t = Date.now() - 3_000_000;
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        ids.push((await wallet('pagec', { at: new Date(t + i * 1000) })).id);
      }
      const p1 = await get(`${BASE}/wallets?q=pagec${RUN}&limit=2`).expect(200);
      const d1 = (p1.body as Json).data;
      expect(d1.items.map((i: any) => i.wawuId)).toEqual([ids[2], ids[1]]);
      expect(d1.nextCursor).toEqual(expect.any(String));
      const p2 = await get(
        `${BASE}/wallets?q=pagec${RUN}&limit=2&cursor=${d1.nextCursor}`,
      ).expect(200);
      expect((p2.body as Json).data.items.map((i: any) => i.wawuId)).toEqual([
        ids[0],
      ]);
      expect((p2.body as Json).data.nextCursor).toBeNull();
      await get(`${BASE}/wallets?cursor=garbage`).expect(400);
    });

    it('withBalance: every figure is the provider’s answer, not a sum of our rows', async () => {
      const w = await wallet('balsum', { balance: 777_00n });
      // Our records say something else entirely: they must not be what is shown.
      for (const amountKobo of [10_000n, 20_000n, 30_000n]) {
        await prisma.fintavaLedgerEntry.create({
          data: {
            walletKind: 'user',
            wawuUserId: w.id,
            accountNumber: '7000000000',
            direction: 'in',
            status: 'completed',
            category: 'top_up',
            amountKobo,
            totalKobo: amountKobo,
            source: 'webhook',
            occurredAt: new Date(),
            provider: 'nuvion',
          },
        });
      }
      const res = await get(
        `${BASE}/wallets?q=balsum${RUN}&withBalance=true`,
      ).expect(200);
      const row = (res.body as Json).data.items[0];
      expect(row.balance.availableKobo).toBe(77_700);
      expect(row.balance.bookedKobo).toBe(78_200);
      expect(row.balance.source).toBe('provider');
      expect(row.balance.availableKobo).not.toBe(60_000);
      expect(asked).toEqual([w.walletId]);
    });

    it('withBalance: a provider error gives a reason for that row, no figure, and the page still answers', async () => {
      const good = await wallet('balerr', {
        balance: 5_000n,
        at: new Date(Date.now() - 1000),
      });
      const bad = await wallet('balerr', { balance: 9_999n });
      failing.add(bad.walletId);
      const res = await get(
        `${BASE}/wallets?q=balerr${RUN}&withBalance=true`,
      ).expect(200);
      const items = (res.body as Json).data.items as any[];
      const byId = Object.fromEntries(items.map((i) => [i.wawuId, i]));
      expect(byId[good.id].balance.availableKobo).toBe(5_000);
      expect(byId[good.id]).not.toHaveProperty('balanceUnavailable');
      expect(byId[bad.id]).not.toHaveProperty('balance');
      expect(byId[bad.id].balanceUnavailable).toMatch(/did not answer/);
      expect(byId[bad.id].balanceUnavailable).not.toMatch(/—/);
    });

    it('withBalance: a row still waiting at the page deadline gets a reason and no figure', async () => {
      const fast = await wallet('slowp', {
        balance: 4_200n,
        at: new Date(Date.now() - 1000),
      });
      const stuck = await wallet('slowp', { balance: 9_900n });
      slow.add(stuck.walletId);
      const svc = moduleRef.get(AdminMoneyWalletsService);
      svc.balanceDeadlineMs = 300;
      const t0 = Date.now();
      const res = await get(
        `${BASE}/wallets?q=slowp${RUN}&withBalance=true`,
      ).expect(200);
      svc.balanceDeadlineMs = 20_000;
      expect(Date.now() - t0).toBeLessThan(3_000);
      const byId = Object.fromEntries(
        (res.body as Json).data.items.map((i: any) => [i.wawuId, i]),
      );
      expect(byId[fast.id].balance.availableKobo).toBe(4_200);
      expect(byId[stuck.id]).not.toHaveProperty('balance');
      expect(byId[stuck.id].balanceUnavailable).toBe(
        'Nuvion did not answer in time',
      );
    });

    it('withBalance caps the page at 25', async () => {
      for (let i = 0; i < 27; i++) await wallet('capped', { balance: 1_00n });
      const res = await get(
        `${BASE}/wallets?q=capped${RUN}&limit=50&withBalance=true`,
      ).expect(200);
      const d = (res.body as Json).data;
      expect(d.items).toHaveLength(25);
      expect(d.nextCursor).toEqual(expect.any(String));
      expect(asked).toHaveLength(25);
      asked.length = 0;
      const plain = await get(`${BASE}/wallets?q=capped${RUN}&limit=50`).expect(
        200,
      );
      expect((plain.body as Json).data.items).toHaveLength(27);
      expect(asked).toEqual([]);
    });
  });

  describe('one wallet', () => {
    it('gives the provider’s balance and the ledger rows as records, newest first, cursor paged', async () => {
      const w = await wallet('onew', { balance: 123_456n });
      const base = Date.now() - 600_000;
      for (let i = 0; i < 3; i++) {
        await prisma.fintavaLedgerEntry.create({
          data: {
            walletKind: 'user',
            wawuUserId: w.id,
            accountNumber: '7000000000',
            direction: i === 1 ? 'out' : 'in',
            status: 'completed',
            category: i === 1 ? 'transfer' : 'top_up',
            amountKobo: BigInt((i + 1) * 100),
            feeKobo: i === 1 ? 65n : 0n,
            totalKobo: BigInt((i + 1) * 100 + (i === 1 ? 65 : 0)),
            source: 'webhook',
            occurredAt: new Date(base + i * 1000),
            provider: 'nuvion',
            customerReference: `dashb-${RUN}-${i}`,
          },
        });
      }
      // A merchant row and another provider's row never appear on a person's page.
      await prisma.fintavaLedgerEntry.create({
        data: {
          walletKind: 'user',
          wawuUserId: w.id,
          accountNumber: '7000000000',
          direction: 'in',
          status: 'completed',
          category: 'top_up',
          amountKobo: 999n,
          totalKobo: 999n,
          source: 'webhook',
          occurredAt: new Date(base + 9000),
          provider: 'fintava',
        },
      });
      const res = await get(`${BASE}/wallets/${w.id}?limit=2`).expect(200);
      const d = (res.body as Json).data;
      expect(d.wallet.balance.availableKobo).toBe(123_456);
      expect(d.wallet.handle).toBe(w.handle);
      expect(d.recordsNote).toMatch(/not a balance/);
      expect(d.records.map((r: any) => r.amountKobo)).toEqual([300, 200]);
      expect(d.records[1]).toMatchObject({
        direction: 'out',
        feeKobo: 65,
        totalKobo: 265,
      });
      const p2 = await get(
        `${BASE}/wallets/${w.id}?limit=2&cursor=${d.nextCursor}`,
      ).expect(200);
      expect(
        (p2.body as Json).data.records.map((r: any) => r.amountKobo),
      ).toEqual([100]);
      expect((p2.body as Json).data.nextCursor).toBeNull();
    });

    it('a provider that does not answer gives a reason and no figure; the records still show', async () => {
      const w = await wallet('oneerr', { balance: 1n });
      failing.add(w.walletId);
      const res = await get(`${BASE}/wallets/${w.id}`).expect(200);
      expect((res.body as Json).data.wallet).not.toHaveProperty('balance');
      expect((res.body as Json).data.wallet.balanceUnavailable).toMatch(
        /did not answer/,
      );
    });

    it('another provider’s wallet and an unknown person are 404, and nothing is asked', async () => {
      const other = await wallet('oneoth', {
        provider: 'fintava',
        balance: 5n,
      });
      await get(`${BASE}/wallets/${other.id}`).expect(404);
      await get(`${BASE}/wallets/${randomUUID()}`).expect(404);
      expect(asked).toEqual([]);
    });
  });

  describe('merchant', () => {
    it('shows the provider’s balance for WAWU’s wallet and held money as records', async () => {
      platform = { available: 4_200_000n, booked: 4_300_000n };
      const payer = await wallet('mpayer');
      const old = new Date('2001-05-05T10:00:00Z');
      const kind = `dashb_${RUN}`;
      const mk = async (price: bigint, status: string, heldAt: Date) => {
        const pid = await payment('paid_dm', {
          price,
          completedAt: heldAt,
          payer: payer.id,
        });
        await prisma.walletHold.create({
          data: {
            paymentId: pid,
            payerWawuUserId: payer.id,
            payeeWawuUserId: null,
            kind,
            targetId: randomUUID(),
            title: 'A question',
            releaseCondition: 'dm_answered',
            amountKobo: price,
            payeeShareKobo: (price * 85n) / 100n,
            wawuShareKobo: price - (price * 85n) / 100n,
            merchantAccountNumber: '9000000123',
            provider: 'nuvion',
            status,
            action: status === 'released' ? 'release' : null,
            settledAt: status === 'released' ? heldAt : null,
            transferKobo: status === 'released' ? (price * 85n) / 100n : null,
            heldAt,
          },
        });
        return pid;
      };
      await mk(10_000n, 'held', old);
      await mk(20_000n, 'held', new Date(old.getTime() + 1000));
      await mk(40_000n, 'released', new Date(old.getTime() + 2000));
      const res = await get(`${BASE}/merchant?limit=2`).expect(200);
      const d = (res.body as Json).data;
      expect(d.account.balance).toMatchObject({
        availableKobo: 4_200_000,
        bookedKobo: 4_300_000,
        source: 'provider',
      });
      expect(d.account.accountLast4).toBe('0123');
      expect(d.recordsNote).toMatch(/not a balance/);
      const group = d.heldByKind.find((g: any) => g.kind === kind);
      expect(group).toMatchObject({
        count: 2,
        heldKobo: 30_000,
        payeeShareKobo: 25_500,
        wawuShareKobo: 4_500,
      });
      const mine = d.holds.filter((h: any) => h.kind === kind);
      expect(mine.map((h: any) => h.amountKobo)).toEqual([10_000, 20_000]);
      expect(mine[0]).toMatchObject({
        payerHandle: payer.handle,
        payeeWawuId: null,
      });
    });

    it('a provider that does not answer gives a reason, no figure, and the records still show', async () => {
      platform = 'down';
      const res = await get(`${BASE}/merchant`).expect(200);
      const d = (res.body as Json).data;
      expect(d.account).toBeNull();
      expect(d.balanceUnavailable).toMatch(/did not answer/);
      expect(Array.isArray(d.heldByKind)).toBe(true);
    });
  });

  describe('revenue', () => {
    const FROM = '2019-03-01T00:00:00.000Z';
    const TO = '2019-04-01T00:00:00.000Z';

    it('sums each stream from its seeded rows and respects both window edges', async () => {
      const inside = new Date('2019-03-15T12:00:00Z');
      // Content unlocks: three count (one on the first instant, one on the last millisecond), others do not.
      await payment('content_unlock', {
        price: 10_000n,
        completedAt: new Date(FROM),
      });
      await payment('content_unlock', { price: 20_000n, completedAt: inside });
      await payment('content_unlock', {
        price: 30_000n,
        completedAt: new Date('2019-03-31T23:59:59.999Z'),
      });
      await payment('content_unlock', {
        price: 99_000n,
        completedAt: new Date(TO),
      });
      await payment('content_unlock', {
        price: 98_000n,
        completedAt: new Date('2019-02-28T23:59:59.999Z'),
      });
      await payment('content_unlock', {
        price: 97_000n,
        completedAt: inside,
        status: 'failed',
      });
      await payment('content_unlock', {
        price: 96_000n,
        completedAt: inside,
        provider: 'fintava',
      });
      // A tip with a stored split; a bill that is all WAWU's.
      await payment('tip', { price: 5_000n, completedAt: inside });
      await payment('bill', { price: 7_000n, payee: 0n, completedAt: inside });
      await payment('paid_dm', { price: 10_000n, completedAt: inside });
      // A paid DM that was refunded: counted when paid, the refund shown beside it.
      const dm = await payment('paid_dm', {
        price: 15_000n,
        completedAt: inside,
      });
      await prisma.walletHold.create({
        data: {
          paymentId: dm,
          kind: 'paid_dm',
          targetId: randomUUID(),
          title: 'q',
          releaseCondition: 'dm_answered',
          amountKobo: 15_000n,
          payeeShareKobo: 12_750n,
          wawuShareKobo: 2_250n,
          merchantAccountNumber: '9000000123',
          provider: 'nuvion',
          status: 'refunded',
          action: 'refund',
          settledAt: inside,
          transferKobo: 15_000n,
          refundedKobo: 15_000n,
          heldAt: inside,
        },
      });

      // Store sales: a product per platform.
      const mkProduct = async (
        platformName: 'ios' | 'android',
        kind: StoreProductKind,
        grants: object = {},
      ) => {
        const p = await prisma.storeProduct.create({
          data: {
            platform: platformName,
            storeProductId: `dashb.${RUN}.${platformName}.${kind}.${randomUUID().slice(0, 6)}`,
            kind,
            title: 'dashb',
            grants,
          },
        });
        productIds.push(p.id);
        return p;
      };
      const sale = async (
        p: {
          id: string;
          platform: 'ios' | 'android';
          kind: StoreProductKind;
          storeProductId: string;
        },
        o: {
          ref: number | null;
          at: Date;
          status?: 'granted' | 'refunded';
          micros?: bigint;
          currency?: string;
        },
      ) =>
        prisma.storePurchase.create({
          data: {
            platform: p.platform,
            storeTransactionId: `dashb-${RUN}-${randomUUID()}`,
            productId: p.id,
            storeProductId: p.storeProductId,
            kind: p.kind,
            status: o.status ?? 'granted',
            environment: 'sandbox',
            grant: {},
            referenceKobo: o.ref,
            priceMicros: o.micros ?? null,
            currency: o.currency ?? null,
            storeFeeBps: 1500,
            purchasedAt: o.at,
          },
        });
      const iosBuy = await mkProduct('ios', 'buy');
      const iosTier = await mkProduct('ios', 'tier', { tierId: 'plus' });
      const iosPoints = await mkProduct('ios', 'points', { packId: 's' });
      const iosCredits = await mkProduct('ios', 'credits');
      const andCredits = await mkProduct('android', 'credits');
      // One row of each basis. (a) the store's own naira charge wins over the recorded price.
      await sale(iosBuy, {
        ref: 100_000,
        at: inside,
        micros: 1_500_000_000n,
        currency: 'NGN',
      });
      // (b) the recorded list price.
      await sale(iosBuy, { ref: 200_000, at: new Date(FROM) });
      // (c) today's list price from the live plan (plus 599900) and plan-settings pack s (100000).
      await sale(iosTier, { ref: null, at: inside });
      await sale(iosPoints, { ref: null, at: inside });
      // None can price it.
      await sale(iosCredits, { ref: null, at: inside });
      // A charge in dollars is listed by currency, never added into naira; priced on its recorded list price.
      await sale(iosBuy, {
        ref: 110_000,
        at: inside,
        micros: 5_990_000n,
        currency: 'USD',
      });
      // Refunded later: still taken, shown as refunded.
      await sale(iosBuy, { ref: 800_000, at: inside, status: 'refunded' });
      await sale(iosBuy, { ref: 900_000, at: new Date(TO) });
      await sale(andCredits, { ref: 50_000, at: inside });

      // /join: paid rows by tier; pending and edge rows do not count.
      const reg = async (o: {
        tier: string | null;
        kobo: number;
        at: Date;
        status?: 'paid' | 'pending';
        paidKobo?: number | null;
      }) => {
        const ref = `wawu-join-${randomUUID().replace(/-/g, '')}`;
        const r = await prisma.waitlistRegistration.create({
          data: {
            offerId: `dashb-${RUN}`,
            fullName: 'Test Person',
            phone: `+234${Math.floor(7000000000 + Math.random() * 999999999)}`,
            email: `dashb-${RUN}-${randomUUID()}@test.wawu.dev`,
            consentAt: o.at,
            reference: ref,
            amountKobo: o.kobo,
            paidKobo: o.status === 'pending' ? null : (o.paidKobo ?? o.kobo),
            flutterwaveTxId:
              o.status === 'pending' ? null : `dashb-${RUN}-${randomUUID()}`,
            status: o.status ?? 'paid',
            paidAt: o.status === 'pending' ? null : o.at,
            tier: o.tier,
          },
        });
        registrationIds.push(r.id);
      };
      await reg({ tier: 'verify', kobo: 300_000, at: inside });
      await reg({ tier: 'verify', kobo: 300_000, at: new Date(FROM) });
      await reg({ tier: 'plus', kobo: 600_000, at: inside, paidKobo: 550_000 });
      await reg({ tier: null, kobo: 100_000, at: inside });
      await reg({ tier: 'plus', kobo: 600_000, at: inside, status: 'pending' });
      await reg({ tier: 'plus', kobo: 600_000, at: new Date(TO) });

      const res = await get(`${BASE}/revenue?from=${FROM}&to=${TO}`).expect(
        200,
      );
      const d = (res.body as Json).data;
      expect(d.period).toMatchObject({ from: FROM, to: TO });
      expect(d.split).toEqual({ creatorsPercent: 85, wawuPercent: 15 });
      const s = Object.fromEntries(d.streams.map((x: any) => [x.key, x]));

      expect(s.wallet_content_unlock).toMatchObject({
        label: 'Content unlocks',
        rail: 'Nuvion',
        source: 'WalletPayment',
        statuses: ['completed'],
        count: 3,
        grossKobo: 60_000,
        creatorsKobo: 51_000,
        wawuKobo: 9_000,
        refundedKobo: null,
      });
      expect(s.wallet_tip).toMatchObject({
        count: 1,
        grossKobo: 5_000,
        creatorsKobo: 4_250,
        wawuKobo: 750,
      });
      expect(s.wallet_bill).toMatchObject({
        count: 1,
        grossKobo: 7_000,
        creatorsKobo: 0,
        wawuKobo: 7_000,
        refundedKobo: 0,
      });
      // A refunded held row keeps its gross, shows the refund, and contributes 0 to the shares.
      expect(s.wallet_paid_dm).toMatchObject({
        count: 2,
        grossKobo: 25_000,
        refundedKobo: 15_000,
        keptKobo: 10_000,
        creatorsKobo: 8_500,
        wawuKobo: 1_500,
      });
      expect(s.wallet_tip).toMatchObject({ keptKobo: 5_000 });
      // Streams with nothing in the window are still listed, at zero.
      expect(s.wallet_event_ticket).toMatchObject({ count: 0, grossKobo: 0 });
      expect(s.wallet_credit_pack).toMatchObject({ count: 0, grossKobo: 0 });

      expect(s.store_apple).toMatchObject({
        rail: 'Apple',
        source: 'StorePurchase',
        statuses: ['granted', 'refunded', 'revoked'],
        count: 7,
        // 150000 + 200000 + 599900 + 100000 + 0 + 110000 + 800000
        grossKobo: 1_959_900,
        unpricedCount: 1,
        refundedKobo: 800_000,
        keptKobo: 1_159_900,
        wawuKobo: null,
      });
      expect(s.store_apple.grossBasis).toMatch(/before its cut/);
      expect(s.store_apple.bases).toEqual([
        {
          basis: 'store_charge',
          label: 'As charged by the store, before its cut',
          count: 1,
          grossKobo: 150_000,
        },
        expect.objectContaining({
          basis: 'recorded_list_price',
          count: 3,
          grossKobo: 1_110_000,
        }),
        expect.objectContaining({
          basis: 'todays_list_price',
          label: 'Today’s list price',
          count: 2,
          grossKobo: 699_900,
        }),
        expect.objectContaining({ basis: 'unpriced', count: 1, grossKobo: 0 }),
      ]);
      // The dollar charge is listed by currency and is in no naira figure.
      expect(s.store_apple.foreignCharges).toEqual([
        { currency: 'USD', count: 1, amountMinor: 599 },
      ]);
      expect(s.store_apple.breakdown).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'buy',
            count: 4,
            grossKobo: 1_260_000,
          }),
          expect.objectContaining({
            key: 'tier',
            count: 1,
            grossKobo: 599_900,
          }),
          expect.objectContaining({
            key: 'points',
            count: 1,
            grossKobo: 100_000,
          }),
          expect.objectContaining({
            key: 'credits',
            count: 1,
            unpricedCount: 1,
          }),
        ]),
      );
      expect(s.store_google).toMatchObject({
        rail: 'Google',
        count: 1,
        grossKobo: 50_000,
        refundedKobo: 0,
        keptKobo: 50_000,
      });
      expect(d.note).toMatch(/refunded or revoked later/);

      expect(s.join_web).toMatchObject({
        rail: 'Flutterwave',
        source: 'WaitlistRegistration',
        statuses: ['paid'],
        count: 4,
        grossKobo: 1_250_000,
      });
      expect(s.join_web.breakdown).toEqual([
        expect.objectContaining({
          key: 'untiered',
          count: 1,
          grossKobo: 100_000,
        }),
        expect.objectContaining({ key: 'plus', count: 1, grossKobo: 550_000 }),
        expect.objectContaining({
          key: 'verify',
          count: 2,
          grossKobo: 600_000,
        }),
      ]);
      // No Shop stream (R-2).
      expect(d.streams.map((x: any) => x.key).join(',')).not.toMatch(/shop/i);
    });

    it('shares on the money kept are never negative and never above what was kept', async () => {
      // Real flows copy the payment's own price and shares onto its hold in the
      // same transaction (wallet-payment.service.ts, walletHold.create) and a
      // refund is always the whole price (WalletHold_outcome_check). Rows that
      // do not look like that still must not push a share below zero.
      const f = '2018-05-01T00:00:00.000Z';
      const t = '2018-06-01T00:00:00.000Z';
      const at = new Date('2018-05-10T10:00:00Z');
      const refundedHold = async (
        paymentId: string,
        o: { kind: string; price: bigint; payee: bigint; wawu: bigint },
      ) =>
        prisma.walletHold.create({
          data: {
            paymentId,
            kind: o.kind,
            targetId: randomUUID(),
            title: 'q',
            releaseCondition: 'dm_answered',
            amountKobo: o.price,
            payeeShareKobo: o.payee,
            wawuShareKobo: o.wawu,
            merchantAccountNumber: '9000000123',
            provider: 'nuvion',
            status: 'refunded',
            action: 'refund',
            settledAt: at,
            transferKobo: o.price,
            refundedKobo: o.price,
            heldAt: at,
          },
        });
      // 1. As a real flow writes it: the hold copies the payment's shares.
      const a = await payment('paid_dm', { price: 30_000n, completedAt: at });
      await refundedHold(a, {
        kind: 'paid_dm',
        price: 30_000n,
        payee: 25_500n,
        wawu: 4_500n,
      });
      // 2. A payment whose shares were never stored, with a real hold on it (the database
      //    makes a hold's shares add up to its price, so a hold cannot be the one without).
      const b = await payment('paid_dm', {
        price: 20_000n,
        payee: 0n,
        wawu: 0n,
        completedAt: at,
      });
      await refundedHold(b, {
        kind: 'paid_dm',
        price: 20_000n,
        payee: 17_000n,
        wawu: 3_000n,
      });
      // 3. A hold that carries shares its payment does not, under another kind.
      const c = await payment('paid_dm', {
        price: 40_000n,
        payee: 0n,
        wawu: 0n,
        completedAt: at,
      });
      await refundedHold(c, {
        kind: 'tip',
        price: 40_000n,
        payee: 34_000n,
        wawu: 6_000n,
      });
      // 4. One that was never refunded.
      await payment('paid_dm', { price: 10_000n, completedAt: at });

      const res = await get(`${BASE}/revenue?from=${f}&to=${t}`).expect(200);
      const streams = (res.body as Json).data.streams as any[];
      const dm = streams.find((x) => x.key === 'wallet_paid_dm');
      expect(dm).toMatchObject({
        count: 4,
        grossKobo: 100_000,
        refundedKobo: 90_000,
        keptKobo: 10_000,
        creatorsKobo: 8_500,
        wawuKobo: 1_500,
      });
      for (const x of streams.filter((y) => y.creatorsKobo !== null)) {
        expect(x.creatorsKobo).toBeGreaterThanOrEqual(0);
        expect(x.wawuKobo).toBeGreaterThanOrEqual(0);
        expect(x.creatorsKobo + x.wawuKobo).toBeLessThanOrEqual(x.keptKobo);
      }
      expect(streams.find((x) => x.key === 'wallet_tip')).toMatchObject({
        creatorsKobo: 0,
        wawuKobo: 0,
        keptKobo: 0,
      });
    });

    it('rejects a window that runs backwards and answers the current month with no bounds', async () => {
      await get(`${BASE}/revenue?from=${TO}&to=${FROM}`).expect(400);
      const res = await get(`${BASE}/revenue`).expect(200);
      const { from, to } = (res.body as Json).data.period;
      expect(new Date(from).getUTCDate()).toBe(1);
      expect(new Date(to).getUTCDate()).toBe(1);
    });
  });
});
