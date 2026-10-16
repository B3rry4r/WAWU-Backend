/* eslint-disable */
/**
 * The rig the SETTINGS-06 round 5 specs share (copied from the verifier's
 * round 4 attack specs, zz-v4-*: same provider double with per-call delays,
 * transit jitter and the two faults "fail before" and "applied, answer
 * lost", same helpers). Call `useHarness()` inside a `describe`.
 */
import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { FintavaDouble, FREEZE_200, WALLET_BALANCE } from '../../../test/fintava/fintava-double';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountModule } from '../account.module';
import { AccountDeletionMoneyService } from '../account-deletion-money.service';
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import { AccountService } from '../account.service';
import { WAWU_ID_ACCOUNT_GATEWAY, type WawuIdAccountGateway } from '../wawu-id-account.gateway';

export type W = { balanceKobo: number; frozen: boolean };
export type Step = { jitter?: number; answer?: number; fail?: 'before' | 'lost'; gate?: Promise<void> };
export type Plan = { freeze: Step[]; unfreeze: Step[]; balance: Step[] };
export type Ev = { op: string; n: number; recv: number; apply: number | null };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const mulberry32 = (a: number) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

export function useHarness() {
  const double = new FintavaDouble();
  const wallets = new Map<string, W>();
  const plans = new Map<string, Plan>();
  const counts = new Map<string, { freeze: number; unfreeze: number; balance: number }>();
  const events = new Map<string, Ev[]>();
  const gateway: jest.Mocked<WawuIdAccountGateway> = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  const people: string[] = [];
  const prev: Record<string, string | undefined> = {};
  let app: INestApplication;
  let prisma: PrismaService;
  let accounts: AccountService;
  let sweep: AccountDeletionSweepService;
  let money: AccountDeletionMoneyService;
  const walletOf = (path: string) => decodeURIComponent(path.split('/').filter(Boolean)[2] ?? '');

  function step(walletId: string, op: 'freeze' | 'unfreeze' | 'balance'): { s: Step; n: number } {
    const c = counts.get(walletId) ?? { freeze: 0, unfreeze: 0, balance: 0 };
    counts.set(walletId, c);
    const n = c[op]++;
    return { s: plans.get(walletId)?.[op][n] ?? {}, n };
  }
  const ev = (w: string, op: string, n: number): Ev => {
    const e: Ev = { op, n, recv: performance.now(), apply: null };
    (events.get(w) ?? events.set(w, []).get(w)!).push(e);
    return e;
  };

  const h = {
    double,
    wallets,
    plans,
    counts,
    events,
    gateway,
    people,
    get app() { return app; },
    get prisma() { return prisma; },
    get accounts() { return accounts; },
    get sweep() { return sweep; },
    get money() { return money; },
    calls: (w: string, op: string) => (events.get(w) ?? []).filter((e) => e.op === op).length,
    async person(balanceKobo = 0) {
      const id = randomUUID();
      people.push(id);
      const walletId = `w-${id}`;
      wallets.set(walletId, { balanceKobo, frozen: false });
      await prisma.fintavaWallet.create({
        data: {
          wawuUserId: id, customerId: `c-${id}`, walletId,
          accountNumber: `9${Math.floor(Math.random() * 1e9).toString().padStart(9, '0')}`,
        },
      });
      return { id, walletId };
    },
    async piece(creator: string) {
      const id = randomUUID();
      return prisma.contentPiece.create({
        data: {
          id, slug: `r5-${id.slice(0, 8)}-ada`, creatorWawuId: creator, contentType: 'video',
          title: 'Ada Okafor makeup class', description: 'Ada Okafor teaches contouring.', category: 'beauty',
          tags: ['ada-okafor'], accessType: 'free', price: 0,
          previewAssetUrl: 'https://storage.test/ada-okafor-preview.mp4',
          fullAssetUrl: 'https://storage.test/ada-okafor-full.mp4', status: 'live',
        },
      });
    },
    async del(a: AccountService, id: string) {
      try { return { ok: true as const, r: await a.deleteAccount(id) }; }
      catch (e) { return { ok: false as const, status: statusOf(e), msg: (e as Error).message }; }
    },
    async can(a: AccountService, id: string) {
      try { return { ok: true as const, r: await a.cancelDeletion(id) }; }
      catch (e) { return { ok: false as const, status: statusOf(e), msg: (e as Error).message }; }
    },
    row: (id: string) => prisma.accountDeletion.findUnique({ where: { wawuUserId: id } }),
    frozen: (w: string) => wallets.get(w)!.frozen,
    pieceState: async (pid: string) =>
      (await prisma.contentPiece.findUnique({ where: { id: pid } }))?.status ?? 'gone',
    backdate: (id: string, minutes = 11) =>
      prisma.$executeRawUnsafe(`UPDATE "AccountDeletion" SET "updatedAt" = now() - interval '${minutes} minutes' WHERE "wawuUserId" = '${id}'`),
    healthy(walletId: string) {
      plans.set(walletId, { freeze: [], unfreeze: [], balance: [] });
      counts.set(walletId, { freeze: 0, unfreeze: 0, balance: 0 });
    },
    /** a plan for the next calls on a wallet; the counters restart */
    plan(walletId: string, p: Partial<Plan>) {
      plans.set(walletId, { freeze: [], unfreeze: [], balance: [], ...p });
      counts.set(walletId, { freeze: 0, unfreeze: 0, balance: 0 });
    },
    dueNow: (id: string) =>
      prisma.$executeRawUnsafe(
        `UPDATE "AccountDeletion" SET "purgeAfter" = now() - interval '1 second', "scheduledAt" = now() - interval '31 days' WHERE "wawuUserId" = '${id}' AND status = 'scheduled'`,
      ),
    /**
     * The hourly pass also looks at every row changed in the last 24 hours, so
     * rows earlier tests left are moved out of that window: a pass then works
     * on the rows of the test that runs it (and a long run does not slow down
     * with every round).
     */
    isolate: () =>
      prisma.$executeRaw`UPDATE "AccountDeletion" SET "updatedAt" = now() - interval '2 days' WHERE "updatedAt" > now() - interval '2 days'`,
    /** a stale freezing row of a request that died after the freeze */
    async strand(minutes = 11, provider: string | null = 'fintava', withWallet = true) {
      const p = await h.person(0);
      wallets.get(p.walletId)!.frozen = true;
      await prisma.accountDeletion.create({
        data: {
          wawuUserId: p.id, status: 'freezing', scheduledAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86400000),
          walletId: withWallet ? p.walletId : null, walletProvider: provider,
        },
      });
      await h.backdate(p.id, minutes);
      return p;
    },
  };
  function statusOf(e: unknown) {
    return (e as { getStatus?: () => number }).getStatus?.() ?? -1;
  }

  beforeAll(async () => {
    await double.start();
    double.on('GET', /^\/customer\/wallet\/balance\//, async (req) => {
      const wid = decodeURIComponent(req.path.split('/').pop()!);
      const { s, n } = step(wid, 'balance');
      const e = ev(wid, 'balance', n);
      if (s.jitter) await sleep(s.jitter);
      if (s.gate) await s.gate;
      e.apply = performance.now();
      const w = wallets.get(wid);
      if (!w) return { status: 404, body: { status: 404, message: ['No wallet'] } };
      if (s.fail) return { status: 500, body: { message: 'boom' } };
      return {
        status: 200, delayMs: s.answer || undefined,
        body: { ...WALLET_BALANCE, data: { ...WALLET_BALANCE.data, balance: { bookedBalance: w.balanceKobo / 100, availableBalance: w.balanceKobo / 100 } } },
      };
    });
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/freeze$/, async (req) => {
      const wid = walletOf(req.path);
      const { s, n } = step(wid, 'freeze');
      const e = ev(wid, 'freeze', n);
      if (s.jitter) await sleep(s.jitter);
      if (s.gate) await s.gate;
      e.apply = performance.now();
      if (s.fail === 'before') return { status: 500, delayMs: s.answer || undefined, body: { message: 'provider hiccup' } };
      const w = wallets.get(wid);
      if (w) w.frozen = true;
      if (s.fail === 'lost') return { status: 500, delayMs: s.answer || undefined, body: { message: 'gateway timeout' } };
      return { status: 200, delayMs: s.answer || undefined, body: FREEZE_200 };
    });
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/unfreeze$/, async (req) => {
      const wid = walletOf(req.path);
      const { s, n } = step(wid, 'unfreeze');
      const e = ev(wid, 'unfreeze', n);
      if (s.jitter) await sleep(s.jitter);
      if (s.gate) await s.gate;
      e.apply = performance.now();
      if (s.fail === 'before') return { status: 500, delayMs: s.answer || undefined, body: { message: 'boom' } };
      const w = wallets.get(wid);
      if (w) w.frozen = false;
      if (s.fail === 'lost') return { status: 500, delayMs: s.answer || undefined, body: { message: 'gateway timeout' } };
      return {
        status: 200, delayMs: s.answer || undefined,
        body: { ...FREEZE_200, data: { ...FREEZE_200.data, isFrozen: false }, message: 'Wallet unfrozen successfully' },
      };
    });
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: double.baseUrl, FINTAVA_API_KEY: 'live_test_s06r5_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: '5000', FINTAVA_MONEY_TIMEOUT_MS: '5000', FINTAVA_CHECK_TIMEOUT_MS: '5000',
    };
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, AccountModule],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/hub');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    await app.init();
    prisma = moduleRef.get(PrismaService);
    accounts = moduleRef.get(AccountService);
    sweep = moduleRef.get(AccountDeletionSweepService);
    money = moduleRef.get(AccountDeletionMoneyService);
  });

  beforeEach(async () => {
    await h.isolate();
    gateway.scheduleAccountDeletion.mockReset().mockResolvedValue({ scheduled: true });
    gateway.finalizeAccountDeletion.mockReset().mockResolvedValue({ finalized: true });
  });
  afterEach(async () => {
    await prisma.accountDeletion.updateMany({
      where: { wawuUserId: { in: people }, status: { in: ['scheduled', 'freezing', 'purging'] } },
      data: { status: 'cancelled' },
    });
  });
  afterAll(async () => {
    if (prisma) {
      await prisma.contentPiece.deleteMany({ where: { creatorWawuId: { in: people } } });
      await prisma.accountDeletionContent.deleteMany({ where: { wawuUserId: { in: people } } });
      await prisma.accountDeletion.deleteMany({ where: { wawuUserId: { in: people } } });
      await prisma.pushStoppedAccount.deleteMany({ where: { userWawuId: { in: people } } });
      await prisma.fintavaWallet.deleteMany({ where: { wawuUserId: { in: people } } });
    }
    await app?.close();
    await double.stop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  return h;
}
