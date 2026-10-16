import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  FintavaDouble,
  FREEZE_200,
  WALLET_BALANCE,
} from '../../../test/fintava/fintava-double';
import { AccountPurgeService } from '../../account-purge/account-purge.service';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AllExceptionsFilter } from '../../common/filters/all-exceptions.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AccountModule } from '../account.module';
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import {
  AccountService,
  DELETION_IN_PROGRESS_MESSAGE,
} from '../account.service';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from '../wawu-id-account.gateway';

/**
 * Delete account, round 2 (task SETTINGS-06): the three faults the verifier
 * found, with the answers that must hold. A wallet is never left frozen with
 * no deletion recorded; a cancel is never answered restored once data is
 * deleted; a deletion is marked purged only when the purge fully worked.
 * The real AccountModule over a real database, the real Fintava adapter over
 * a socket to FintavaDouble (state per wallet, with faults on request).
 */
type WalletState = { balanceKobo: number; frozen: boolean };

describe('Delete account, round 2 (SETTINGS-06)', () => {
  const double = new FintavaDouble();
  const wallets = new Map<string, WalletState>();
  const faults = {
    failBalanceWhenFrozen: false,
    lostFreezeAnswer: false,
    failUnfreeze: false,
    freezeDelayMs: 0,
  };
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

  async function person(balanceKobo = 0) {
    const id = randomUUID();
    people.push(id);
    const walletId = `w-${id}`;
    wallets.set(walletId, { balanceKobo, frozen: false });
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

  function piece(creator: string, status: 'live' | 'pending' = 'live') {
    const id = randomUUID();
    return prisma.contentPiece.create({
      data: {
        id,
        slug: `s06r2-${id.slice(0, 8)}-ada-okafor`,
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
        status,
      },
    });
  }

  const status = (e: unknown) =>
    (e as { getStatus?: () => number }).getStatus?.() ?? -1;
  const code = (e: unknown) =>
    (
      (
        e as { getResponse?: () => { reason?: { code?: string } } }
      ).getResponse?.() ?? {}
    ).reason?.code;

  async function attempt(id: string) {
    try {
      return { ok: true as const, r: await accounts.deleteAccount(id) };
    } catch (e) {
      return { ok: false as const, status: status(e), code: code(e) };
    }
  }

  const row = (id: string) =>
    prisma.accountDeletion.findUnique({ where: { wawuUserId: id } });

  async function due(id: string) {
    await prisma.accountDeletion.update({
      where: { wawuUserId: id },
      data: {
        purgeAfter: new Date(Date.now() - 1000),
        scheduledAt: new Date(Date.now() - 31 * 86400000),
      },
    });
  }

  const bound = (owner: object, v: unknown): unknown =>
    typeof v === 'function'
      ? (v as (...a: unknown[]) => unknown).bind(owner)
      : v;
  const scheduleCalls = () => gateway.scheduleAccountDeletion.mock.calls;
  const finalizedIds = () =>
    gateway.finalizeAccountDeletion.mock.calls.map((c) => c[0]);
  const unfreezes = () =>
    double.seen.filter((r) => r.path.endsWith('/unfreeze')).length;

  beforeAll(async () => {
    await double.start();
    double.on('GET', /^\/customer\/wallet\/balance\//, (req) => {
      const w = wallets.get(decodeURIComponent(req.path.split('/').pop()!));
      if (!w)
        return { status: 404, body: { status: 404, message: ['No wallet'] } };
      if (faults.failBalanceWhenFrozen && w.frozen)
        return { status: 500, body: { message: 'boom' } };
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
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/freeze$/, (req) => {
      const w = wallets.get(walletOf(req.path));
      if (w) w.frozen = true;
      if (faults.lostFreezeAnswer)
        return { status: 500, body: { message: 'gateway timeout' } };
      return {
        status: 200,
        delayMs: faults.freezeDelayMs || undefined,
        body: FREEZE_200,
      };
    });
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/unfreeze$/, (req) => {
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
      FINTAVA_API_KEY: 'live_test_s06r2_0123456789FAKEKEY',
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
    faults.failBalanceWhenFrozen = false;
    faults.lostFreezeAnswer = false;
    faults.failUnfreeze = false;
    faults.freezeDelayMs = 0;
    gateway.scheduleAccountDeletion.mockClear();
    gateway.finalizeAccountDeletion.mockReset();
    gateway.finalizeAccountDeletion.mockResolvedValue({ finalized: true });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.purchase.deleteMany({
        where: { creatorWawuId: { in: people } },
      });
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

  describe('a wallet is never left frozen with no deletion recorded', () => {
    it('the balance read fails after the freeze: the wallet is let go, nothing is scheduled, and a retry that finds money leaves it usable', async () => {
      const { id, walletId } = await person(0);
      faults.failBalanceWhenFrozen = true;
      const first = await attempt(id);
      faults.failBalanceWhenFrozen = false;
      expect(first).toMatchObject({ ok: false, status: 503 });
      expect(wallets.get(walletId)!.frozen).toBe(false);
      expect(await row(id)).toBeNull();
      expect((await accounts.cancelDeletion(id)).cancelled).toBe(false);

      wallets.get(walletId)!.balanceKobo = 5000;
      const retry = await attempt(id);
      expect(retry).toMatchObject({
        ok: false,
        status: 409,
        code: 'account_deletion_blocked',
      });
      expect(wallets.get(walletId)!.frozen).toBe(false);
      expect(await row(id)).toBeNull();
    });

    it('the freeze answer is lost after the provider froze it: the wallet is let go again', async () => {
      const { id, walletId } = await person(0);
      faults.lostFreezeAnswer = true;
      const first = await attempt(id);
      faults.lostFreezeAnswer = false;
      expect(first).toMatchObject({ ok: false, status: 503 });
      expect(wallets.get(walletId)!.frozen).toBe(false);
      expect(await row(id)).toBeNull();
    });

    it('the unfreeze fails too: the request stays recorded, and a cancel lets the wallet go once the provider answers', async () => {
      const { id, walletId } = await person(0);
      await piece(id);
      faults.lostFreezeAnswer = true;
      faults.failUnfreeze = true;
      const first = await attempt(id);
      faults.lostFreezeAnswer = false;
      expect(first).toMatchObject({ ok: false, status: 503 });
      expect(wallets.get(walletId)!.frozen).toBe(true);
      const recorded = await row(id);
      expect(recorded).toMatchObject({ status: 'freezing', walletId });

      // The provider still does not answer: the cancel says so and changes nothing.
      await expect(accounts.cancelDeletion(id)).rejects.toMatchObject({
        status: 503,
      });
      expect((await row(id))!.status).toBe('freezing');
      expect(wallets.get(walletId)!.frozen).toBe(true);

      faults.failUnfreeze = false;
      const cancelled = await accounts.cancelDeletion(id);
      expect(cancelled).toMatchObject({
        cancelled: true,
        walletUnfrozen: true,
      });
      expect(wallets.get(walletId)!.frozen).toBe(false);
      expect((await row(id))!.status).toBe('cancelled');
    });

    it('the unfreeze fails too, then the person asks again and has money: the wallet is let go before the refusal', async () => {
      const { id, walletId } = await person(0);
      faults.lostFreezeAnswer = true;
      faults.failUnfreeze = true;
      await attempt(id);
      faults.lostFreezeAnswer = false;
      faults.failUnfreeze = false;
      expect(wallets.get(walletId)!.frozen).toBe(true);

      // Asked again straight away: told to wait, nothing undone.
      expect(await attempt(id)).toMatchObject({ ok: false, status: 503 });
      expect(wallets.get(walletId)!.frozen).toBe(true);
      // Round 4 (R3-1): a young `freezing` row is a request that may still be
      // running, so it is left alone; only an old one is let go by a new request.
      await prisma.$executeRawUnsafe(
        `UPDATE "AccountDeletion" SET "updatedAt" = now() - interval '11 minutes' WHERE "wawuUserId" = '${id}'`,
      );

      wallets.get(walletId)!.balanceKobo = 12_000;
      const retry = await attempt(id);
      expect(retry).toMatchObject({
        ok: false,
        status: 409,
        code: 'account_deletion_blocked',
      });
      expect(wallets.get(walletId)!.frozen).toBe(false);
      expect(await row(id)).toBeNull();
    });

    it('the unfreeze fails too, then the person asks again with an empty wallet: it schedules, frozen, with one date', async () => {
      const { id, walletId } = await person(0);
      faults.lostFreezeAnswer = true;
      faults.failUnfreeze = true;
      await attempt(id);
      faults.lostFreezeAnswer = false;
      faults.failUnfreeze = false;
      // Round 4 (R3-1): a young `freezing` row is a request that may still be
      // running, so it is left alone; only an old one is let go by a new request.
      await prisma.$executeRawUnsafe(
        `UPDATE "AccountDeletion" SET "updatedAt" = now() - interval '11 minutes' WHERE "wawuUserId" = '${id}'`,
      );
      const retry = await attempt(id);
      expect(retry.ok).toBe(true);
      expect(wallets.get(walletId)!.frozen).toBe(true);
      expect(await row(id)).toMatchObject({
        status: 'scheduled',
        walletId,
      });
      expect((await row(id))!.walletFrozenAt).not.toBeNull();
    });

    it('a cancel that lands while the request is freezing wins: nothing is scheduled, nothing hidden, the wallet works', async () => {
      const { id, walletId } = await person(0);
      const kept = await piece(id);
      faults.freezeDelayMs = 900;
      const asking = attempt(id);
      await new Promise((r) => setTimeout(r, 350));
      const cancel = await accounts.cancelDeletion(id);
      const answer = await asking;
      faults.freezeDelayMs = 0;
      expect(cancel.cancelled).toBe(true);
      expect(answer).toMatchObject({ ok: false, status: 503 });
      expect((await row(id))!.status).toBe('cancelled');
      expect(wallets.get(walletId)!.frozen).toBe(false);
      expect(
        (
          await prisma.contentPiece.findUniqueOrThrow({
            where: { id: kept.id },
          })
        ).status,
      ).toBe('live');
      expect(scheduleCalls()).toHaveLength(0);
    });
  });

  describe('a cancel is never answered restored while data is deleted', () => {
    it('a cancel that finishes while the sweep is looking at the money wins: the sweep leaves the account alone', async () => {
      const { id } = await person(0);
      const kept = await piece(id);
      expect((await attempt(id)).ok).toBe(true);
      await due(id);
      // Hold the sweep's money look open by delaying the balance read.
      const original = sweep['money'].check.bind(sweep['money']);
      const spy = jest
        .spyOn(sweep['money'], 'check')
        .mockImplementationOnce(async (who: string) => {
          const r = await original(who);
          await new Promise((res) => setTimeout(res, 700));
          return r;
        });
      const sweeping = sweep.runOnce();
      await new Promise((r) => setTimeout(r, 250));
      const cancelled = await accounts.cancelDeletion(id);
      const result = await sweeping;
      spy.mockRestore();
      expect(cancelled).toMatchObject({ cancelled: true, contentRestored: 1 });
      expect(result.purged).toBe(0);
      expect((await row(id))!.status).toBe('cancelled');
      expect(await prisma.contentPiece.count({ where: { id: kept.id } })).toBe(
        1,
      );
      expect(finalizedIds()).not.toContain(id);
    });

    it('WAWU ID is down at the end: the row stays purging, a cancel is refused with a clear message, and the next pass finishes it', async () => {
      const { id } = await person(0);
      const mine = await piece(id);
      expect((await attempt(id)).ok).toBe(true);
      await due(id);
      gateway.finalizeAccountDeletion.mockRejectedValueOnce(new Error('down'));
      const first = await sweep.runOnce();
      expect(first.identityPending).toBeGreaterThanOrEqual(1);
      expect(await prisma.contentPiece.count({ where: { id: mine.id } })).toBe(
        0,
      );
      expect(await row(id)).toMatchObject({
        status: 'purging',
        purgeBlockedBy: 'identity_service',
      });

      const cancel = await accounts.cancelDeletion(id);
      expect(cancel).toEqual({
        cancelled: false,
        walletUnfrozen: false,
        contentRestored: 0,
        deletionInProgress: true,
        message: DELETION_IN_PROGRESS_MESSAGE,
      });
      expect(DELETION_IN_PROGRESS_MESSAGE).not.toContain('—');
      expect((await row(id))!.status).toBe('purging');

      const second = await sweep.runOnce();
      expect(second.purged).toBeGreaterThanOrEqual(1);
      expect(await row(id)).toMatchObject({
        status: 'purged',
        purgeBlockedBy: null,
      });
      expect(finalizedIds().filter((x) => x === id)).toHaveLength(2);
    });

    it('a cancel that arrives after the sweep claimed the row is refused and leaves the wallet frozen', async () => {
      const { id, walletId } = await person(0);
      expect((await attempt(id)).ok).toBe(true);
      await prisma.accountDeletion.update({
        where: { wawuUserId: id },
        data: { status: 'purging' },
      });
      const cancel = await accounts.cancelDeletion(id);
      expect(cancel).toMatchObject({
        cancelled: false,
        deletionInProgress: true,
      });
      expect(wallets.get(walletId)!.frozen).toBe(true);
      expect(unfreezes()).toBe(0);
    });

    it('asking to delete again once the purge started changes nothing', async () => {
      const { id } = await person(0);
      expect((await attempt(id)).ok).toBe(true);
      const before = await row(id);
      await prisma.accountDeletion.update({
        where: { wawuUserId: id },
        data: { status: 'purging' },
      });
      gateway.scheduleAccountDeletion.mockClear();
      const again = await attempt(id);
      expect(again).toMatchObject({
        ok: true,
        r: { deletionScheduledAt: before!.purgeAfter.toISOString() },
      });
      expect(scheduleCalls()).toHaveLength(0);
      expect((await row(id))!.status).toBe('purging');
    });
  });

  describe('purged means the purge fully worked', () => {
    it('content a buyer paid for is hidden and anonymised, noted on the row, and WAWU ID is asked only after', async () => {
      const { id } = await person(0);
      const sold = await piece(id);
      const unsold = await piece(id);
      await prisma.courseLesson.create({
        data: { contentId: sold.id, title: 'Ada lesson one', order: 1 },
      });
      await prisma.contentFrame.create({
        data: {
          contentId: sold.id,
          position: 0,
          url: 'https://storage.test/ada-frame.jpg',
        },
      });
      await prisma.purchase.create({
        data: {
          contentId: sold.id,
          type: 'content',
          buyerWawuId: randomUUID(),
          creatorWawuId: id,
          amount: 1000,
          commissionRate: '0.1500',
          flutterwaveTxRef: `s06r2-${randomUUID()}`,
          status: 'completed',
        },
      });
      expect((await attempt(id)).ok).toBe(true);
      await due(id);

      let seenAtFinalize: { title: string; status: string } | null = null;
      gateway.finalizeAccountDeletion.mockImplementation(async () => {
        const p = await prisma.contentPiece.findUnique({
          where: { id: sold.id },
        });
        seenAtFinalize = p && { title: p.title, status: p.status };
        return { finalized: true };
      });
      const result = await sweep.runOnce();
      expect(result.purged).toBeGreaterThanOrEqual(1);

      const left = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: sold.id },
      });
      expect(left).toMatchObject({
        status: 'removed',
        title: 'Removed content',
        description: '',
        previewAssetUrl: '',
        fullAssetUrl: null,
        tags: [],
        slug: `removed-${sold.id}`,
      });
      for (const text of [
        left.title,
        left.description,
        left.slug,
        left.previewAssetUrl,
        ...left.tags,
      ]) {
        expect(text.toLowerCase()).not.toContain('ada');
      }
      expect(
        await prisma.courseLesson.count({ where: { contentId: sold.id } }),
      ).toBe(0);
      expect(
        await prisma.contentFrame.count({ where: { contentId: sold.id } }),
      ).toBe(0);
      expect(
        await prisma.contentPiece.count({ where: { id: unsold.id } }),
      ).toBe(0);
      expect(seenAtFinalize).toEqual({
        title: 'Removed content',
        status: 'removed',
      });
      const done = await row(id);
      expect(done?.status).toBe('purged');
      expect(done?.purgeNote).toBe(
        '1 content piece(s) that buyers paid for were kept hidden and anonymised',
      );
    });

    it('a table that would not clear keeps the row purging, WAWU ID is not asked, and the next pass finishes', async () => {
      const { id } = await person(0);
      await piece(id);
      expect((await attempt(id)).ok).toBe(true);
      await due(id);
      const purge = sweep['purgeService'];
      const real = purge.purge.bind(purge);
      const spy = jest
        .spyOn(purge, 'purge')
        .mockImplementationOnce(async (who: string) => {
          const r = await real(who);
          return { ...r, failed: ['Comment.authorWawuId'] };
        });
      const first = await sweep.runOnce();
      spy.mockRestore();
      expect(first.blocked).toBeGreaterThanOrEqual(1);
      expect(finalizedIds()).not.toContain(id);
      expect(await row(id)).toMatchObject({
        status: 'purging',
        purgeBlockedBy: 'purge:Comment.authorWawuId',
      });

      const second = await sweep.runOnce();
      expect(second.purged).toBeGreaterThanOrEqual(1);
      expect(finalizedIds()).toContain(id);
      expect((await row(id))!.status).toBe('purged');
    });

    it('the purge service names the tables it could not clear', async () => {
      const { id } = await person(0);
      await piece(id);
      const failing = new Proxy(prisma, {
        get(target, key, receiver) {
          if (key === 'contentPiece') {
            const delegate: object = Reflect.get(target, key, receiver);
            return new Proxy(delegate, {
              get(d, k) {
                if (k === 'deleteMany')
                  return () => Promise.reject(new Error('locked'));
                return bound(d, Reflect.get(d, k));
              },
            });
          }
          return bound(target, Reflect.get(target, key, receiver));
        },
      });
      const out = await new AccountPurgeService(failing).purge(id);
      expect(out.failed).toContain('ContentPiece.creatorWawuId');
      expect(out.pointsLeft).toBe(false);
      const clean = await new AccountPurgeService(prisma).purge(id);
      expect(clean.failed).toEqual([]);
      expect(clean.keptForBuyers).toBe(0);
    });
  });
});
