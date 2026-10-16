import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FintavaDouble,
  FREEZE_200,
  WALLET_BALANCE,
} from '../../../test/fintava/fintava-double';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountModule } from '../account.module';
import { FREEZING_STALE_MS } from '../account-deletion-config';
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import { AccountService } from '../account.service';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from '../wawu-id-account.gateway';

/**
 * Delete account, round 3 (task SETTINGS-06): a `freezing` row nobody retries
 * no longer keeps a wallet frozen for good (the sweep lets it go), and a
 * request that fails late no longer undoes the freeze of the request that
 * got in after it. The real AccountModule over a real database, the real
 * Fintava adapter over a socket to FintavaDouble (state per wallet, faults on
 * request).
 */
type WalletState = { balanceKobo: number; frozen: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Delete account, round 3 (SETTINGS-06)', () => {
  jest.setTimeout(60000);
  const double = new FintavaDouble();
  const wallets = new Map<string, WalletState>();
  const faults = {
    lostFreezeAnswer: false,
    failUnfreeze: false,
    unfreezeDelayMs: 0,
    /** The first N freeze calls fail after `freezeFailDelayMs`, freezing nothing. */
    freezeFirstN: 0,
    freezeFailDelayMs: 0,
  };
  let freezeCalls = 0;
  let unfreezeCalls = 0;
  const gateway: jest.Mocked<WawuIdAccountGateway> = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  const people: string[] = [];
  const previousEnv: Record<string, string | undefined> = {};
  let app: INestApplication;
  let prisma: PrismaService;
  let accounts: AccountService;
  let sweep: AccountDeletionSweepService;

  const walletOf = (path: string) =>
    decodeURIComponent(path.split('/').filter(Boolean)[2] ?? '');

  async function person() {
    const id = randomUUID();
    people.push(id);
    const walletId = `w-${id}`;
    wallets.set(walletId, { balanceKobo: 0, frozen: false });
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: `c-${id}`,
        walletId,
        accountNumber: `9${Math.floor(Math.random() * 1e9)
          .toString()
          .padStart(9, '0')}`,
      },
    });
    return { id, walletId };
  }

  function piece(creator: string) {
    const id = randomUUID();
    return prisma.contentPiece.create({
      data: {
        id,
        slug: `s06r3-${id.slice(0, 8)}-ada-okafor`,
        creatorWawuId: creator,
        contentType: 'video',
        title: 'Ada Okafor makeup class',
        description: 'Ada Okafor teaches contouring.',
        category: 'beauty',
        tags: ['ada-okafor'],
        accessType: 'free',
        price: 0,
        previewAssetUrl: 'https://storage.test/ada-okafor-preview.mp4',
        fullAssetUrl: 'https://storage.test/ada-okafor-full.mp4',
        status: 'live',
      },
    });
  }

  const status = (e: unknown) =>
    (e as { getStatus?: () => number }).getStatus?.() ?? -1;

  async function attempt(id: string) {
    try {
      return { ok: true as const, r: await accounts.deleteAccount(id) };
    } catch (e) {
      return { ok: false as const, status: status(e) };
    }
  }

  const row = (id: string) =>
    prisma.accountDeletion.findUnique({ where: { wawuUserId: id } });
  const frozen = (walletId: string) => wallets.get(walletId)!.frozen;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000);
  const age = (id: string, minutes: number) =>
    prisma.accountDeletion.update({
      where: { wawuUserId: id },
      data: { updatedAt: minutesAgo(minutes) },
    });

  /** A request whose freeze answer was lost and whose unfreeze failed too. */
  async function strandedFreezingRow() {
    const p = await person();
    await piece(p.id);
    faults.lostFreezeAnswer = true;
    faults.failUnfreeze = true;
    const first = await attempt(p.id);
    faults.lostFreezeAnswer = false;
    faults.failUnfreeze = false;
    expect(first).toMatchObject({ ok: false, status: 503 });
    expect(frozen(p.walletId)).toBe(true);
    expect((await row(p.id))!.status).toBe('freezing');
    return p;
  }

  beforeAll(async () => {
    await double.start();
    double.on('GET', /^\/customer\/wallet\/balance\//, (req) => {
      const w = wallets.get(decodeURIComponent(req.path.split('/').pop()!));
      if (!w)
        return { status: 404, body: { status: 404, message: ['No wallet'] } };
      return {
        status: 200,
        body: {
          ...WALLET_BALANCE,
          data: {
            ...WALLET_BALANCE.data,
            balance: {
              bookedBalance: w.balanceKobo / 100,
              availableBalance: w.balanceKobo / 100,
            },
          },
        },
      };
    });
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/freeze$/, async (req) => {
      freezeCalls += 1;
      if (freezeCalls <= faults.freezeFirstN) {
        if (faults.freezeFailDelayMs) await sleep(faults.freezeFailDelayMs);
        return { status: 500, body: { message: 'provider hiccup' } };
      }
      const w = wallets.get(walletOf(req.path));
      if (w) w.frozen = true;
      if (faults.lostFreezeAnswer)
        return { status: 500, body: { message: 'gateway timeout' } };
      return { status: 200, body: FREEZE_200 };
    });
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/unfreeze$/, async (req) => {
      unfreezeCalls += 1;
      if (faults.unfreezeDelayMs) await sleep(faults.unfreezeDelayMs);
      if (faults.failUnfreeze)
        return { status: 500, body: { message: 'boom' } };
      const w = wallets.get(walletOf(req.path));
      if (w) w.frozen = false;
      return {
        status: 200,
        body: {
          ...FREEZE_200,
          data: { ...FREEZE_200.data, isFrozen: false },
          message: 'Wallet unfrozen successfully',
        },
      };
    });
    const env: Record<string, string> = {
      FINTAVA_BASE_URL: double.baseUrl,
      FINTAVA_API_KEY: 'live_test_s06r3_0123456789FAKEKEY',
      FINTAVA_TIMEOUT_MS: '5000',
      FINTAVA_MONEY_TIMEOUT_MS: '5000',
      FINTAVA_CHECK_TIMEOUT_MS: '5000',
    };
    for (const [k, v] of Object.entries(env)) {
      previousEnv[k] = process.env[k];
      process.env[k] = v;
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        PrismaModule,
        WawuAuthModule,
        AccountModule,
      ],
    })
      .overrideProvider(WAWU_ID_ACCOUNT_GATEWAY)
      .useValue(gateway)
      .compile();
    app = moduleRef.createNestApplication();
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
    prisma = moduleRef.get(PrismaService);
    accounts = moduleRef.get(AccountService);
    sweep = moduleRef.get(AccountDeletionSweepService);
  });

  beforeEach(() => {
    double.seen.length = 0;
    freezeCalls = 0;
    unfreezeCalls = 0;
    faults.lostFreezeAnswer = false;
    faults.failUnfreeze = false;
    faults.unfreezeDelayMs = 0;
    faults.freezeFirstN = 0;
    faults.freezeFailDelayMs = 0;
  });

  afterEach(async () => {
    // A row left in force would be picked up by the next test's sweep.
    await prisma.accountDeletion.updateMany({
      where: {
        wawuUserId: { in: people },
        status: { in: ['scheduled', 'freezing', 'purging'] },
      },
      data: { status: 'cancelled' },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.contentPiece.deleteMany({
        where: { creatorWawuId: { in: people } },
      });
      await prisma.accountDeletionContent.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.accountDeletion.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.pushStoppedAccount.deleteMany({
        where: { userWawuId: { in: people } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
    }
    await app?.close();
    await double.stop();
    for (const [k, v] of Object.entries(previousEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  describe('a freezing row nobody retries (verifier R2-1, attack V1)', () => {
    it('the sweep lets the wallet go and removes the row, days later', async () => {
      const { id, walletId } = await strandedFreezingRow();
      // Days pass, the provider is back, the hourly sweep runs.
      await prisma.accountDeletion.update({
        where: { wawuUserId: id },
        data: { updatedAt: minutesAgo(5 * 24 * 60) },
      });
      const result = await sweep.runOnce(new Date(), 100);
      expect(frozen(walletId)).toBe(false);
      expect(await row(id)).toBeNull();
      expect(result.unfrozen).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.contentPiece.count({
          where: { creatorWawuId: id, status: 'live' },
        }),
      ).toBe(1);
      // Nothing is left to cancel, and a new request schedules normally.
      expect(await accounts.cancelDeletion(id)).toMatchObject({
        cancelled: false,
      });
      const again = await attempt(id);
      expect(again.ok).toBe(true);
      expect((await row(id))!.status).toBe('scheduled');
      expect(frozen(walletId)).toBe(true);
    });

    it('a row younger than the window is left alone (its request may still be running)', async () => {
      const { id, walletId } = await strandedFreezingRow();
      await age(id, Math.floor(FREEZING_STALE_MS / 60000) - 2);
      const before = unfreezeCalls;
      await sweep.runOnce(new Date(), 100);
      expect(unfreezeCalls).toBe(before);
      expect(frozen(walletId)).toBe(true);
      expect((await row(id))!.status).toBe('freezing');
    });

    it('a failed unfreeze leaves the row; the next pass (not the same hour twice) lets it go', async () => {
      const { id, walletId } = await strandedFreezingRow();
      await age(id, 60);
      faults.failUnfreeze = true;
      const before = unfreezeCalls;
      const failed = await sweep.runOnce(new Date(), 100);
      expect(failed.unfrozen).toBe(0);
      expect(unfreezeCalls).toBeGreaterThan(before);
      expect(frozen(walletId)).toBe(true);
      expect((await row(id))!.status).toBe('freezing');

      // Straight away again: the row was just looked at, so it is not asked twice.
      const calls = unfreezeCalls;
      await sweep.runOnce(new Date(), 100);
      expect(unfreezeCalls).toBe(calls);

      // An hour later, the provider answering: done.
      faults.failUnfreeze = false;
      await age(id, 60);
      const healed = await sweep.runOnce(new Date(), 100);
      expect(frozen(walletId)).toBe(false);
      expect(await row(id)).toBeNull();
      expect(healed.unfrozen).toBeGreaterThanOrEqual(1);
    });

    it('a row a new request took over while the sweep waited on the provider is not deleted', async () => {
      const { id } = await strandedFreezingRow();
      await age(id, 60);
      faults.unfreezeDelayMs = 400;
      const pass = sweep.runOnce(new Date(), 100);
      await sleep(150);
      // A request takes the row over (record() rewrites it, which touches it).
      await prisma.accountDeletion.updateMany({
        where: { wawuUserId: id, status: 'freezing' },
        data: { walletFrozenAt: null },
      });
      await pass;
      expect((await row(id))?.status).toBe('freezing');
    });

    it('a row with no wallet is just removed, with nothing asked of the provider', async () => {
      const id = randomUUID();
      people.push(id);
      await prisma.accountDeletion.create({
        data: {
          wawuUserId: id,
          status: 'freezing',
          purgeAfter: new Date(Date.now() + 30 * 86400000),
          updatedAt: minutesAgo(60),
        },
      });
      const before = unfreezeCalls;
      await sweep.runOnce(new Date(), 100);
      expect(unfreezeCalls).toBe(before);
      expect(await row(id)).toBeNull();
    });

    it("a row of another provider's wallet is left exactly as it is", async () => {
      const id = randomUUID();
      people.push(id);
      await prisma.accountDeletion.create({
        data: {
          wawuUserId: id,
          status: 'freezing',
          purgeAfter: new Date(Date.now() + 30 * 86400000),
          walletId: `nuv-${id}`,
          walletProvider: 'nuvion',
          updatedAt: minutesAgo(60),
        },
      });
      const before = unfreezeCalls;
      await sweep.runOnce(new Date(), 100);
      expect(unfreezeCalls).toBe(before);
      expect((await row(id))!.status).toBe('freezing');
    });

    it('a deletion in force is never touched by this step, however old its row', async () => {
      const { id, walletId } = await person();
      await piece(id);
      expect((await attempt(id)).ok).toBe(true);
      await age(id, 60);
      await sweep.runOnce(new Date(), 100);
      expect((await row(id))!.status).toBe('scheduled');
      expect(frozen(walletId)).toBe(true);
    });
  });

  describe('a request that fails late (verifier R2-2, attack V3)', () => {
    it('a request that comes while the first is still setting up is told to wait, and the first one fails alone (round 4, R3-1)', async () => {
      const { id, walletId } = await person();
      faults.freezeFirstN = 1;
      faults.freezeFailDelayMs = 500;
      const a = attempt(id);
      await sleep(150);
      const b = attempt(id);
      const [ra, rb] = await Promise.all([a, b]);
      expect(ra.ok).toBe(false);
      // Before round 4 the second request took the first one's row, which let
      // the first one's unfreeze land on the second one's wallet.
      expect(rb).toMatchObject({ ok: false, status: 503 });
      expect(frozen(walletId)).toBe(false);
      expect(await row(id)).toBeNull();
      // Asked again once the first is done: scheduled, frozen.
      expect((await attempt(id)).ok).toBe(true);
      const r = await row(id);
      expect(r).toMatchObject({ status: 'scheduled' });
      expect(r!.walletFrozenAt).not.toBeNull();
      expect(frozen(walletId)).toBe(true);
    });

    it('still lets the wallet go when nobody else got in, and keeps the row if that fails', async () => {
      const { id, walletId } = await person();
      faults.freezeFirstN = 1;
      const only = await attempt(id);
      expect(only.ok).toBe(false);
      expect(frozen(walletId)).toBe(false);
      expect(await row(id)).toBeNull();

      // The unfreeze fails too: the row is there for the sweep to find.
      const second = await person();
      faults.freezeFirstN = 0;
      faults.lostFreezeAnswer = true;
      faults.failUnfreeze = true;
      const stuck = await attempt(second.id);
      expect(stuck).toMatchObject({ ok: false, status: 503 });
      expect((await row(second.id))!.status).toBe('freezing');
      expect(frozen(second.walletId)).toBe(true);
    });
  });
});
