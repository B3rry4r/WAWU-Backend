/* eslint-disable */
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
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import { AccountService } from '../account.service';
import { WAWU_ID_ACCOUNT_GATEWAY, type WawuIdAccountGateway } from '../wawu-id-account.gateway';

type W = { balanceKobo: number; frozen: boolean };
type Step = { jitter?: number; answer?: number; fail?: 'before' | 'lost'; gate?: Promise<void> };
type Plan = { freeze: Step[]; unfreeze: Step[]; balance: Step[] };
type Ev = { op: string; n: number; recv: number; apply: number | null };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const mulberry32 = (a: number) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

describe('SETTINGS-06 round 4: a deletion in force keeps a frozen wallet, a cancelled or abandoned one ends unfrozen', () => {
  jest.setTimeout(600000);
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
  const extra: INestApplication[] = [];
  let app: INestApplication;
  let prisma: PrismaService;
  let accounts: AccountService;
  let sweep: AccountDeletionSweepService;
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
  const calls = (w: string, op: string) => (events.get(w) ?? []).filter((e) => e.op === op).length;

  async function makeApp() {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, WawuAuthModule, AccountModule],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .compile();
    const a = moduleRef.createNestApplication();
    a.setGlobalPrefix('api/hub');
    a.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
    a.useGlobalFilters(new AllExceptionsFilter());
    a.useGlobalInterceptors(new ResponseInterceptor());
    await a.init();
    return {
      app: a,
      prisma: moduleRef.get(PrismaService),
      accounts: moduleRef.get(AccountService),
      sweep: moduleRef.get(AccountDeletionSweepService),
    };
  }

  async function person(balanceKobo = 0) {
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
  }
  async function piece(creator: string) {
    const id = randomUUID();
    return prisma.contentPiece.create({
      data: {
        id, slug: `v3-${id.slice(0, 8)}-ada`, creatorWawuId: creator, contentType: 'video',
        title: 'Ada Okafor makeup class', description: 'Ada Okafor teaches contouring.', category: 'beauty',
        tags: ['ada-okafor'], accessType: 'free', price: 0,
        previewAssetUrl: 'https://storage.test/ada-okafor-preview.mp4',
        fullAssetUrl: 'https://storage.test/ada-okafor-full.mp4', status: 'live',
      },
    });
  }
  const status = (e: unknown) => (e as { getStatus?: () => number }).getStatus?.() ?? -1;
  async function del(a: AccountService, id: string) {
    try { return { ok: true as const, r: await a.deleteAccount(id) }; }
    catch (e) { return { ok: false as const, status: status(e), msg: (e as Error).message }; }
  }
  async function can(a: AccountService, id: string) {
    try { return { ok: true as const, r: await a.cancelDeletion(id) }; }
    catch (e) { return { ok: false as const, status: status(e), msg: (e as Error).message }; }
  }
  const row = (id: string) => prisma.accountDeletion.findUnique({ where: { wawuUserId: id } });
  const frozen = (w: string) => wallets.get(w)!.frozen;
  const pieceStatus = async (pid: string) => (await prisma.contentPiece.findUnique({ where: { id: pid } }))!.status;
  const backdate = (id: string, minutes = 11) =>
    prisma.$executeRawUnsafe(`UPDATE "AccountDeletion" SET "updatedAt" = now() - interval '${minutes} minutes' WHERE "wawuUserId" = '${id}'`);
  /** a stale freezing row of a request that died after the freeze */
  async function strand(minutes = 11, provider: string | null = 'fintava', withWallet = true) {
    const p = await person(0);
    wallets.get(p.walletId)!.frozen = true;
    await prisma.accountDeletion.create({
      data: {
        wawuUserId: p.id, status: 'freezing', scheduledAt: new Date(), purgeAfter: new Date(Date.now() + 30 * 86400000),
        walletId: withWallet ? p.walletId : null, walletProvider: provider,
      },
    });
    await backdate(p.id, minutes);
    return p;
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
      FINTAVA_BASE_URL: double.baseUrl, FINTAVA_API_KEY: 'live_test_s06v3_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: '5000', FINTAVA_MONEY_TIMEOUT_MS: '5000', FINTAVA_CHECK_TIMEOUT_MS: '5000',
    };
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    const a = await makeApp();
    app = a.app; prisma = a.prisma; accounts = a.accounts; sweep = a.sweep;
  });

  beforeEach(() => {
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
    for (const e of extra) await e.close();
    await app?.close();
    await double.stop();
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });


  const IN_FLIGHT = 'Your request is already being processed. Try again in a moment.';
  const inForceOk = async (id: string, walletId: string, pid?: string) => ({
    row: (await row(id))?.status,
    frozen: frozen(walletId),
    ...(pid ? { piece: await pieceStatus(pid) } : {}),
  });

  // ------------------------------------------------------------ R3-1 (T9a, T9b)
  it('R3-1 T9a: a second DELETE while the first is still freezing is told to try again and unfreezes nothing', async () => {
    const { id, walletId } = await person(0);
    const pc = await piece(id);
    const a = { answer: 100 };
    plans.set(walletId, { freeze: [a], unfreeze: [a, a], balance: [a, a, a, a] });
    const d1 = del(accounts, id);
    while (!(events.get(walletId) ?? []).some((e) => e.op === 'freeze' && e.apply != null)) await sleep(2);
    await sleep(30);
    const d2 = del(accounts, id);
    const [r1, r2] = await Promise.all([d1, d2]);
    expect(r1.ok).toBe(true);
    // the second one did not touch the first one's wallet
    expect(calls(walletId, 'unfreeze')).toBe(0);
    if (!r2.ok) {
      expect(r2).toMatchObject({ status: 503, msg: IN_FLIGHT });
      expect((await del(accounts, id)).ok).toBe(true);
    }
    expect(await inForceOk(id, walletId, pc.id)).toEqual({ row: 'scheduled', frozen: true, piece: 'removed' });
  });

  it('R3-1 T9b: double submit with random latencies, second DELETE 0-400 ms after the first: always scheduled and frozen, no wrong answers', async () => {
    const rnd = mulberry32(99);
    const r = (n: number) => Math.floor(rnd() * n);
    const bad: string[] = [];
    for (let i = 0; i < 40; i++) {
      const { id, walletId } = await person(0);
      const pc = await piece(id);
      const mk = () => Array.from({ length: 6 }, () => ({ answer: 20 + r(101) }));
      plans.set(walletId, { freeze: mk(), unfreeze: mk(), balance: mk() });
      const gap = r(400);
      const d1 = del(accounts, id);
      await sleep(gap);
      const d2 = del(accounts, id);
      const [r1, r2] = await Promise.all([d1, d2]);
      const e = await inForceOk(id, walletId, pc.id);
      const answers = [r1, r2].every((x) => x.ok || (x.status === 503 && x.msg === IN_FLIGHT));
      if (e.row !== 'scheduled' || !e.frozen || e.piece !== 'removed' || !(r1.ok || r2.ok) || !answers || calls(walletId, 'unfreeze') > 0) {
        bad.push(`gap${gap}:${JSON.stringify(e)}/${r1.ok}/${r2.ok}/unfreeze${calls(walletId, 'unfreeze')}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('R3-1: a repeat DELETE on a scheduled deletion freezes the wallet again (a late unfreeze had undone it)', async () => {
    const { id, walletId } = await person(0);
    const pc = await piece(id);
    expect((await del(accounts, id)).ok).toBe(true);
    wallets.get(walletId)!.frozen = false; // a late unfreeze of a request that gave up
    const before = calls(walletId, 'freeze');
    expect((await del(accounts, id)).ok).toBe(true);
    // Round 5: the freeze asserted again, and the reconcile that ends the
    // request freezes it once more (idempotent).
    expect(calls(walletId, 'freeze')).toBe(before + 2);
    expect(await inForceOk(id, walletId, pc.id)).toEqual({ row: 'scheduled', frozen: true, piece: 'removed' });
  });

  it('R3-1: two requests that both found no row: only one owns it, the other is told to wait and unfreezes nothing', async () => {
    const { id, walletId } = await person(0);
    const pc = await piece(id);
    const g0 = gate();
    const g1 = gate();
    plans.set(walletId, { freeze: [{ answer: 400 }], unfreeze: [], balance: [{ gate: g0.p }, { gate: g1.p }] });
    const d1 = del(accounts, id);
    while (calls(walletId, 'balance') < 1) await sleep(5);
    const d2 = del(accounts, id);
    while (calls(walletId, 'balance') < 2) await sleep(5); // both read "no row" before either recorded
    g0.open();
    while (calls(walletId, 'freeze') < 1) await sleep(5); // D1 owns the row and is freezing
    g1.open();
    const [r1, r2] = await Promise.all([d1, d2]);
    expect(r1.ok).toBe(true);
    expect(r2).toMatchObject({ ok: false, status: 503, msg: IN_FLIGHT });
    expect(calls(walletId, 'unfreeze')).toBe(0);
    expect(await inForceOk(id, walletId, pc.id)).toEqual({ row: 'scheduled', frozen: true, piece: 'removed' });
  });

  it('R3-1: a young freezing row is left alone by a DELETE; an old one is let go and the DELETE goes through', async () => {
    const young = await strand(1);
    const y = await del(accounts, young.id);
    expect(y).toMatchObject({ ok: false, status: 503, msg: IN_FLIGHT });
    expect(calls(young.walletId, 'unfreeze')).toBe(0);
    expect((await row(young.id))!.status).toBe('freezing');
    expect(frozen(young.walletId)).toBe(true);
    const old = await strand(11);
    await piece(old.id);
    expect((await del(accounts, old.id)).ok).toBe(true);
    expect(calls(old.walletId, 'unfreeze')).toBe(1);
    expect(await inForceOk(old.id, old.walletId)).toEqual({ row: 'scheduled', frozen: true });
  });

  // ------------------------------------------------------------ R3-2 (T10, T3b)
  it('R3-2 T10: D1 gives up and its unfreeze lands after a deletion came into force: the wallet is frozen again', async () => {
    const { id, walletId } = await person(0);
    const pc = await piece(id);
    const gU = gate();
    plans.set(walletId, { freeze: [{ fail: 'lost' }], unfreeze: [{ gate: gU.p }], balance: [] });
    const d1 = del(accounts, id);
    for (let k = 0; k < 600 && calls(walletId, 'unfreeze') < 1; k++) await sleep(5);
    expect(calls(walletId, 'unfreeze')).toBe(1); // D1 is giving up: its unfreeze is held at the provider
    expect((await row(id))!.status).toBe('freezing'); // and its row is still there (R3-3)
    // a deletion comes into force meanwhile (a request that took the row over after a cancel, say)
    await prisma.accountDeletion.update({ where: { wawuUserId: id }, data: { status: 'scheduled', walletFrozenAt: new Date() } });
    await prisma.contentPiece.update({ where: { id: pc.id }, data: { status: 'removed' } });
    gU.open(); // D1's unfreeze lands late
    const r1 = await d1;
    expect(r1.ok).toBe(false);
    expect(await inForceOk(id, walletId, pc.id)).toEqual({ row: 'scheduled', frozen: true, piece: 'removed' });
  });

  it('R3-2 T3b: a sweep unfreeze that lands after a deletion got in is followed by a freeze; a DELETE during the sweep is told to try again', async () => {
    const p = await strand();
    await piece(p.id);
    const g = gate();
    plans.set(p.walletId, { freeze: [], unfreeze: [{ gate: g.p }], balance: [] });
    const sw = sweep.runOnce(new Date(), 100);
    while (calls(p.walletId, 'unfreeze') < 1) await sleep(10);
    // a DELETE now meets the row the sweep holds: told to wait, nothing undone
    expect(await del(accounts, p.id)).toMatchObject({ ok: false, status: 503, msg: IN_FLIGHT });
    // a deletion comes into force some other way while the unfreeze is in the air
    await prisma.accountDeletion.update({ where: { wawuUserId: p.id }, data: { status: 'scheduled', walletFrozenAt: new Date() } });
    g.open();
    await sw;
    expect(await inForceOk(p.id, p.walletId)).toEqual({ row: 'scheduled', frozen: true });
    // and the sweep still lets a plain stranded wallet go, then a retry schedules it
    const q = await strand();
    await piece(q.id);
    const r = await sweep.runOnce(new Date(), 100);
    expect(r.unfrozen).toBe(1);
    expect(await inForceOk(q.id, q.walletId)).toEqual({ row: undefined, frozen: false });
    expect((await del(accounts, q.id)).ok).toBe(true);
    expect(await inForceOk(q.id, q.walletId)).toEqual({ row: 'scheduled', frozen: true });
  });

  // ------------------------------------------------------------ R3-3 (T10b)
  it('R3-3 T10b: while an abandoned request unfreezes, its row is still there for the sweep; afterwards both are gone', async () => {
    const { id, walletId } = await person(300000);
    const g = gate();
    plans.set(walletId, { freeze: [], unfreeze: [{ gate: g.p }], balance: [] });
    const w = wallets.get(walletId)!;
    Object.defineProperty(w, 'balanceKobo', { get: () => (w.frozen ? 500000 : 0), set: () => {}, configurable: true });
    const d1 = del(accounts, id);
    for (let k = 0; k < 600 && calls(walletId, 'unfreeze') < 1; k++) await sleep(5);
    expect(await inForceOk(id, walletId)).toEqual({ row: 'freezing', frozen: true });
    g.open();
    const r1 = await d1;
    expect(r1).toMatchObject({ ok: false, status: 409 });
    expect(await inForceOk(id, walletId)).toEqual({ row: undefined, frozen: false });
  });

  it('R3-4: a repeat DELETE freezes the wallet again while a cancel is in flight: the cancel still ends with the wallet unfrozen', async () => {
    const { id, walletId } = await person(0);
    const pc = await piece(id);
    plans.set(walletId, { freeze: [{}, {}], unfreeze: [{ answer: 700 }, {}], balance: [] });
    expect((await del(accounts, id)).ok).toBe(true);
    const cp = can(accounts, id); // reads a scheduled row; its unfreeze is applied at once, its answer is slow
    while (!(events.get(walletId) ?? []).some((e) => e.op === 'unfreeze' && e.apply != null)) await sleep(5);
    const again = await del(accounts, id); // freezes again after the cancel's unfreeze was applied
    expect(again.ok).toBe(true);
    expect(frozen(walletId)).toBe(true);
    const c = await cp;
    expect(c.ok).toBe(true);
    expect(await inForceOk(id, walletId, pc.id)).toEqual({ row: 'cancelled', frozen: false, piece: 'live' });
  });

  // ------------------------------------------------------------ R3-4 (T8)
  it('R3-4 T8: a cancel that unfroze before the DELETE froze ends with the wallet unfrozen', async () => {
    const { id, walletId } = await person(0);
    const pc = await piece(id);
    const g = gate();
    plans.set(walletId, { freeze: [{ gate: g.p }], unfreeze: [{ answer: 700 }], balance: [] });
    const dp = del(accounts, id);
    while (calls(walletId, 'freeze') < 1) await sleep(5);
    const cp = can(accounts, id);
    while (!(events.get(walletId) ?? []).some((e) => e.op === 'unfreeze' && e.apply != null)) await sleep(5);
    g.open(); // the DELETE's freeze is applied after the cancel's unfreeze
    await dp;
    const c = await cp;
    expect(c.ok).toBe(true);
    expect(await inForceOk(id, walletId, pc.id)).toEqual({ row: 'cancelled', frozen: false, piece: 'live' });
  });

  type Req = { type: 'delete' | 'cancel'; at: number };
  async function round(seed: number, Jmax: number, Dmax: number, unfreezeFails: boolean) {
    const rnd = mulberry32(seed);
    const r = (n: number) => Math.floor(rnd() * n);
    const { id, walletId } = await person(0);
    const pc = await piece(id);
    const mk = (kind: 'freeze' | 'unfreeze' | 'balance'): Step[] =>
      Array.from({ length: 6 }, () => {
        const x = rnd();
        let fail: Step['fail'];
        if (kind === 'freeze') fail = x < 0.2 ? 'before' : x < 0.3 ? 'lost' : undefined;
        if (kind === 'unfreeze') fail = unfreezeFails && x < 0.2 ? 'before' : undefined;
        if (kind === 'balance') fail = x < 0.08 ? 'before' : undefined;
        return { jitter: Jmax ? r(Jmax + 1) : 0, answer: r(Dmax + 1), fail };
      });
    plans.set(walletId, { freeze: mk('freeze'), unfreeze: mk('unfreeze'), balance: mk('balance') });
    const reqs: Req[] = [];
    const nDel = 1 + r(3);
    const nCan = r(3);
    for (let i = 0; i < nDel; i++) reqs.push({ type: 'delete', at: r(200) });
    for (let i = 0; i < nCan; i++) reqs.push({ type: 'cancel', at: r(260) });
    const t0 = performance.now();
    const res = await Promise.all(
      reqs.map(async (q) => {
        await sleep(q.at);
        const s0 = Math.round(performance.now() - t0);
        const rr = q.type === 'delete' ? await del(accounts, id) : await can(accounts, id);
        return { q, res: rr, span: `${s0}-${Math.round(performance.now() - t0)}` };
      }),
    );
    const d = await row(id);
    const fr = frozen(walletId);
    const ps = await pieceStatus(pc.id);
    const evs = events.get(walletId) ?? [];
    const reorder = evs.some((a) => evs.some((b) => a.recv < b.recv && a.apply != null && b.apply != null && a.apply > b.apply));
    const v: string[] = [];
    const st = d?.status ?? 'none';
    if (st === 'scheduled' && !(fr && ps === 'removed')) v.push(`scheduled but frozen=${fr} piece=${ps}`);
    // Round 5 (R4-5): a cancel whose last unfreeze the provider refused stands
    // (it answered walletUnfrozen false) with a frozen wallet; the hourly pass
    // lets it go. Same as a stranded `freezing` row below: healed by the sweep.
    const strandedCancel = unfreezeFails && st === 'cancelled' && fr && ps === 'live';
    if (strandedCancel) v.push('stranded cancelled, wallet frozen');
    else if ((st === 'none' || st === 'cancelled') && (fr || ps !== 'live')) v.push(`${st} but frozen=${fr} piece=${ps}`);
    if (st === 'freezing') v.push(`stranded freezing frozen=${fr}`);
    const anyDelOk = res.some((x) => x.q.type === 'delete' && x.res.ok);
    if (!reqs.some((q) => q.type === 'cancel') && anyDelOk && st !== 'scheduled') v.push(`delete answered ok but ${st}`);
    // a stranded row must be healed by the sweep
    let healed = true;
    if (st === 'freezing' || strandedCancel) {
      plans.set(walletId, { freeze: [], unfreeze: [], balance: [] });
      counts.set(walletId, { freeze: 0, unfreeze: 0, balance: 0 });
      await backdate(id);
      await sweep.runOnce(new Date(), 200);
      const after = await row(id);
      healed = (after === null || after.status === 'cancelled') && !frozen(walletId);
    }
    const plan = plans.get(walletId);
    const tl = evs.map((e) => `${e.op}#${e.n}@${Math.round(e.recv - t0)}/${e.apply == null ? '-' : Math.round(e.apply - t0)}`).join(' ');
    return { seed, v, reorder, healed, reqs: res.map((x) => `${x.q.type}[${x.span}]:${x.res.ok ? JSON.stringify((x.res as any).r).slice(0, 60) : (x.res as any).status}`), fr, st, ps, tl, plan: JSON.stringify(plan, (k, val) => (k === 'gate' ? undefined : val)) };
  }

  // ------------------------------------------------------------ T6, T6b, T7, T11 over many seeds
  for (const [name, Jmax, Dmax, uf, n, base] of [
    ['T6 FIFO provider, healthy unfreeze', 0, 300, false, 70, 5000],
    ['T6 FIFO provider, healthy unfreeze (second seed set)', 0, 300, false, 70, 9000],
    ['T6 FIFO provider, healthy unfreeze (the verifier seeds)', 0, 300, false, 70, 1000],
    ['T6b FIFO provider, unfreeze may fail', 0, 300, true, 60, 5000],
    ['T6b FIFO provider, unfreeze may fail (the verifier seeds)', 0, 300, true, 50, 1000],
    ['T7 transit jitter up to 40 ms, healthy unfreeze', 40, 300, false, 70, 5000],
    ['T7 transit jitter up to 40 ms (second seed set)', 40, 300, false, 70, 9000],
  ] as const) {
    it(`${name}`, async () => {
      const out: Awaited<ReturnType<typeof round>>[] = [];
      for (let i = 0; i < n; i++) out.push(await round(base + i * (base === 1000 ? 7 : 13) + Jmax, Jmax, Dmax, uf));
      const viol = out.filter((o) => o.v.length > 0);
      // With a failing unfreeze a `freezing` row left behind is by design (the
      // sweep, a cancel or a retry lets it go); `healed` below proves the sweep does.
      const logic = viol.filter((o) => !o.reorder && (!uf || o.v.some((x) => !x.startsWith('stranded'))));
      console.log(`${name}: rounds ${n}, violations ${viol.length}, without provider reordering ${logic.length}; stranded not healed ${out.filter((o) => !o.healed).length}`);
      expect(out.filter((o) => !o.healed).map((o) => o.seed)).toEqual([]);
      expect(logic.map((o) => ({ seed: o.seed, v: o.v, reqs: o.reqs, tl: o.tl, plan: o.plan }))).toEqual([]);
    });
  }

  it('T11 DELETE then a cancel 0-500 ms later, 120 rounds: always consistent', async () => {
    const rnd = mulberry32(31);
    const r = (n: number) => Math.floor(rnd() * n);
    const bad: string[] = [];
    for (let i = 0; i < 120; i++) {
      const { id, walletId } = await person(0);
      const pc = await piece(id);
      const mk = () => Array.from({ length: 6 }, () => ({ answer: 20 + r(101) }));
      plans.set(walletId, { freeze: mk(), unfreeze: mk(), balance: mk() });
      const gap = r(500);
      const d = del(accounts, id);
      await sleep(gap);
      await can(accounts, id);
      await d;
      const st = (await row(id))?.status ?? 'none';
      const fr = frozen(walletId);
      const ps = await pieceStatus(pc.id);
      const consistent = (st === 'scheduled' && fr && ps === 'removed') || ((st === 'none' || st === 'cancelled') && !fr && ps === 'live');
      if (!consistent) bad.push(`gap${gap}:${st}/frozen=${fr}/piece=${ps}`);
    }
    expect(bad).toEqual([]);
  });
});
