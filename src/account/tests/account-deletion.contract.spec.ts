import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
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
import { PointsService } from '../../points/points.service';
import { AccountModule } from '../account.module';
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import { AccountService } from '../account.service';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from '../wawu-id-account.gateway';

/**
 * Deleting an account in the Hub (task SETTINGS-06, R-17): empty the wallet
 * first, freeze it for the 30 days, bring everything back on cancel, and
 * delete the Hub's data at the end. The real AccountModule over a real
 * database, with the real Fintava adapter over a socket to FintavaDouble
 * (balances, freeze and unfreeze answer from per-wallet state), real RS256
 * tokens from the local mock WAWU ID for the two routes called over HTTP.
 */
const MOCK_WAWU_ID_BASE_URL =
  process.env.WAWU_ID_BASE_URL_TEST ?? 'http://localhost:4001';
const HTTP_USER_IDENTIFIER = 'user@test.wawu.dev';
const HTTP_USER = '00000000-0000-4000-8000-000000000001';
const DAY_MS = 24 * 60 * 60 * 1000;

type WalletState = { balanceKobo: number; frozen: boolean };

describe('Delete account (SETTINGS-06)', () => {
  const double = new FintavaDouble();
  const wallets = new Map<string, WalletState>();
  /** Reads of a wallet's balance, to make the second read differ. */
  const balanceReads = new Map<string, number[]>();
  const gateway: jest.Mocked<WawuIdAccountGateway> = {
    scheduleAccountDeletion: jest.fn().mockResolvedValue({ scheduled: true }),
    finalizeAccountDeletion: jest.fn().mockResolvedValue({ finalized: true }),
  };
  const previousEnv: Record<string, string | undefined> = {};
  const people: string[] = [];
  let app: INestApplication;
  let prisma: PrismaService;
  let accounts: AccountService;
  let sweep: AccountDeletionSweepService;
  let points: PointsService;
  let accessToken: string;

  /** A person, with a Fintava wallet whose balance the double answers. */
  async function person(
    opts: { wallet?: boolean; balanceKobo?: number; id?: string } = {},
  ): Promise<{ id: string; walletId: string | null }> {
    const id = opts.id ?? randomUUID();
    people.push(id);
    if (opts.wallet === false) return { id, walletId: null };
    const walletId = `w-${id}`;
    wallets.set(walletId, {
      balanceKobo: opts.balanceKobo ?? 0,
      frozen: false,
    });
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

  function piece(creator: string, status: 'live' | 'pending' | 'removed') {
    const id = randomUUID();
    return prisma.contentPiece.create({
      data: {
        id,
        slug: `s06-${id.slice(0, 8)}`,
        creatorWawuId: creator,
        contentType: 'video',
        title: 'FIXTURE: account-deletion.contract.spec.ts',
        description: 'Owned by account-deletion.contract.spec.ts.',
        category: 'beauty',
        tags: [],
        accessType: 'free',
        price: 0,
        previewAssetUrl: 'https://storage.test/fixture-preview.mp4',
        status,
      },
    });
  }

  async function payment(over: {
    payee?: string;
    payer?: string;
    status?: string;
    settled?: boolean;
  }) {
    const id = randomUUID();
    return prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: over.payer ?? null,
        payeeWawuUserId: over.payee ?? null,
        kind: 'tip',
        targetId: id,
        title: 'A tip',
        priceKobo: 10000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 10000n,
        payeeShareKobo: 8500n,
        wawuShareKobo: 1500n,
        payeeSettledAt: over.settled ? new Date() : null,
        customerReference: `s06-${id}`,
        merchantAccountNumber: '1102038668',
        status: over.status ?? 'completed',
      },
    });
  }

  async function hold(paymentId: string, payer: string, payee: string) {
    return prisma.walletHold.create({
      data: {
        paymentId,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'paid_dm',
        targetId: paymentId,
        title: 'A paid DM',
        releaseCondition: 'dm_answered',
        amountKobo: 10000n,
        payeeShareKobo: 8500n,
        wawuShareKobo: 1500n,
        merchantAccountNumber: '1102038668',
        heldAt: new Date(),
      },
    });
  }

  const scheduleCalls = () => gateway.scheduleAccountDeletion.mock.calls;
  const finalizeCalls = () => gateway.finalizeAccountDeletion.mock.calls;
  const frozenCalls = () =>
    double.seen.filter((r) => r.path.endsWith('/freeze')).length;
  const unfrozenCalls = () =>
    double.seen.filter((r) => r.path.endsWith('/unfreeze')).length;

  async function blockedBy(id: string): Promise<{
    status: number;
    code: string;
    blockers: string[];
    balanceKobo?: number;
  }> {
    try {
      await accounts.deleteAccount(id);
    } catch (e) {
      const err = e as {
        getStatus?: () => number;
        getResponse?: () => {
          reason: { code: string; blockers?: string[]; balanceKobo?: number };
        };
      };
      const reason = err.getResponse!().reason;
      return {
        status: err.getStatus!(),
        code: reason.code,
        blockers: reason.blockers ?? [],
        balanceKobo: reason.balanceKobo,
      };
    }
    throw new Error('deleteAccount did not refuse');
  }

  beforeAll(async () => {
    const login = await fetch(`${MOCK_WAWU_ID_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: HTTP_USER_IDENTIFIER }),
    });
    if (!login.ok)
      throw new Error(`mock-wawu-id login failed (${login.status})`);
    accessToken = ((await login.json()) as { accessToken: string }).accessToken;

    await double.start();
    const walletOf = (path: string) =>
      decodeURIComponent(path.split('/').filter(Boolean)[2] ?? '');
    double.on('GET', /^\/customer\/wallet\/balance\//, (req) => {
      const id = decodeURIComponent(req.path.split('/').pop()!);
      const w = wallets.get(id);
      if (!w)
        return { status: 404, body: { status: 404, message: ['No wallet'] } };
      const reads = balanceReads.get(id);
      const kobo = reads && reads.length > 0 ? reads.shift()! : w.balanceKobo;
      return {
        status: 200,
        body: {
          ...WALLET_BALANCE,
          data: {
            ...WALLET_BALANCE.data,
            balance: {
              bookedBalance: kobo / 100,
              availableBalance: kobo / 100,
            },
          },
        },
      };
    });
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/freeze$/, (req) => {
      const w = wallets.get(walletOf(req.path));
      if (w) w.frozen = true;
      return { status: 200, body: FREEZE_200 };
    });
    double.on('PATCH', /^\/customer\/wallet\/[^/]+\/unfreeze$/, (req) => {
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
      FINTAVA_API_KEY: 'live_test_s06_0123456789FAKEKEY',
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
    points = moduleRef.get(PointsService);
    await prisma.accountDeletion.deleteMany({
      where: { wawuUserId: HTTP_USER },
    });
  });

  beforeEach(() => {
    double.seen.length = 0;
    gateway.scheduleAccountDeletion.mockClear();
    gateway.finalizeAccountDeletion.mockClear();
    gateway.finalizeAccountDeletion.mockResolvedValue({ finalized: true });
  });

  afterAll(async () => {
    if (prisma) {
      const payments = await prisma.walletPayment.findMany({
        where: {
          OR: [
            { payerWawuUserId: { in: people } },
            { payeeWawuUserId: { in: people } },
          ],
        },
        select: { id: true },
      });
      const ids = payments.map((p) => p.id);
      await prisma.walletHold.deleteMany({ where: { paymentId: { in: ids } } });
      await prisma.walletPayment.deleteMany({ where: { id: { in: ids } } });
      await prisma.contentPiece.deleteMany({
        where: { creatorWawuId: { in: [...people, HTTP_USER] } },
      });
      await prisma.accountDeletionContent.deleteMany({
        where: { wawuUserId: { in: [...people, HTTP_USER] } },
      });
      await prisma.accountDeletion.deleteMany({
        where: { wawuUserId: { in: [...people, HTTP_USER] } },
      });
      await prisma.pushStoppedAccount.deleteMany({
        where: { userWawuId: { in: [...people, HTTP_USER] } },
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

  describe('money first (Z6, R-11, R-19)', () => {
    it('refuses while the wallet holds money, with the provider balance, and changes nothing', async () => {
      const { id, walletId } = await person({ balanceKobo: 48_525_075 });
      const kept = await piece(id, 'live');
      const refusal = await blockedBy(id);
      expect(refusal.status).toBe(409);
      expect(refusal.code).toBe('account_deletion_blocked');
      expect(refusal.blockers).toEqual(['wallet_balance']);
      expect(refusal.balanceKobo).toBe(48_525_075);
      expect(wallets.get(walletId!)!.frozen).toBe(false);
      expect(frozenCalls()).toBe(0);
      expect(
        await prisma.accountDeletion.count({ where: { wawuUserId: id } }),
      ).toBe(0);
      expect(
        (
          await prisma.contentPiece.findUniqueOrThrow({
            where: { id: kept.id },
          })
        ).status,
      ).toBe('live');
      expect(scheduleCalls()).toHaveLength(0);
    });

    it('answers in the one error shape over HTTP, with no em-dash in the sentence', async () => {
      const { id } = await person({ balanceKobo: 1_000, id: HTTP_USER });
      const res = await request(app.getHttpServer() as Server)
        .delete('/api/hub/account')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409);
      expect(res.body).toMatchObject({
        statusCode: 409,
        data: null,
        reason: {
          code: 'account_deletion_blocked',
          blockers: ['wallet_balance'],
          balanceKobo: 1_000,
          openHolds: 0,
          waitingEarnings: 0,
        },
      });
      const body = res.body as { message: string; reason: { message: string } };
      expect(body.reason.message).not.toContain(String.fromCharCode(0x2014));
      expect(body.message).toBe(body.reason.message);
      await prisma.fintavaWallet.delete({ where: { wawuUserId: id } });
      people.splice(people.indexOf(id), 1);
    });

    it('refuses while a hold is open, for the payee and for the payer', async () => {
      const payee = await person();
      const payer = await person();
      const p = await payment({ payer: payer.id, payee: payee.id });
      await hold(p.id, payer.id, payee.id);
      for (const who of [payee.id, payer.id]) {
        const refusal = await blockedBy(who);
        expect(refusal.blockers).toEqual(['open_hold']);
      }
      expect(frozenCalls()).toBe(0);
    });

    it('allows it once the hold has settled', async () => {
      const payee = await person();
      const payer = await person();
      const p = await payment({
        payer: payer.id,
        payee: payee.id,
        settled: true,
      });
      const h = await hold(p.id, payer.id, payee.id);
      await prisma.walletHold.update({
        where: { id: h.id },
        data: {
          status: 'released',
          action: 'release',
          actionAt: new Date(),
          transferKobo: 8500n,
          settledAt: new Date(),
        },
      });
      const out = await accounts.deleteAccount(payee.id);
      expect(new Date(out.deletionScheduledAt).getTime()).toBeGreaterThan(
        Date.now() + 29 * DAY_MS,
      );
    });

    it('refuses while earnings are waiting to land, and not once they have landed', async () => {
      const creator = await person({ wallet: false });
      await payment({ payee: creator.id });
      const refusal = await blockedBy(creator.id);
      expect(refusal.blockers).toEqual(['waiting_earnings']);
      expect(refusal.balanceKobo).toBeUndefined();

      const settled = await person({ wallet: false });
      await payment({ payee: settled.id, settled: true });
      await accounts.deleteAccount(settled.id);
      expect(
        (
          await prisma.accountDeletion.findUniqueOrThrow({
            where: { wawuUserId: settled.id },
          })
        ).status,
      ).toBe('scheduled');
    });

    it('refuses while a payment of theirs has no final answer', async () => {
      const payer = await person({ wallet: false });
      await payment({
        payer: payer.id,
        payee: randomUUID(),
        status: 'pending',
      });
      expect((await blockedBy(payer.id)).blockers).toEqual([
        'payment_in_progress',
      ]);
    });

    it('names every reason at once', async () => {
      const both = await person({ balanceKobo: 500 });
      await payment({ payee: both.id });
      expect((await blockedBy(both.id)).blockers).toEqual([
        'wallet_balance',
        'waiting_earnings',
      ]);
    });

    it('is 503 and schedules nothing when the provider does not answer, never a guess that it is empty', async () => {
      const { id, walletId } = await person();
      const kept = await piece(id, 'live');
      await double.pause();
      let refusal: { status: number; code: string };
      try {
        refusal = await blockedBy(id);
      } finally {
        await double.resume();
      }
      expect(refusal.status).toBe(503);
      expect(refusal.code).toBe('provider_unreachable');
      expect(wallets.get(walletId!)!.frozen).toBe(false);
      expect(
        await prisma.accountDeletion.count({ where: { wawuUserId: id } }),
      ).toBe(0);
      expect(
        (
          await prisma.contentPiece.findUniqueOrThrow({
            where: { id: kept.id },
          })
        ).status,
      ).toBe('live');
    });

    it('lets the wallet go again when money arrives between the look and the freeze', async () => {
      const { id, walletId } = await person();
      // The first read (the look) says empty; the one after the freeze finds money.
      balanceReads.set(walletId!, [0, 250_000]);
      const refusal = await blockedBy(id);
      expect(refusal.blockers).toEqual(['wallet_balance']);
      expect(refusal.balanceKobo).toBe(250_000);
      expect(frozenCalls()).toBe(1);
      // Round 5: one unfreeze to let the wallet go, and the reconcile every
      // request ends with finds no deletion row and confirms it (idempotent).
      expect(unfrozenCalls()).toBe(2);
      expect(wallets.get(walletId!)!.frozen).toBe(false);
      expect(
        await prisma.accountDeletion.count({ where: { wawuUserId: id } }),
      ).toBe(0);
    });
  });

  describe('scheduling and cancelling', () => {
    it('freezes the wallet, hides the content and stops push, 30 days out', async () => {
      const { id, walletId } = await person();
      const live = await piece(id, 'live');
      const pending = await piece(id, 'pending');
      const gone = await piece(id, 'removed');
      const before = Date.now();
      const out = await accounts.deleteAccount(id);

      const at = new Date(out.deletionScheduledAt).getTime();
      expect(at).toBeGreaterThan(before + 30 * DAY_MS - 60_000);
      expect(at).toBeLessThan(Date.now() + 30 * DAY_MS + 60_000);
      expect(wallets.get(walletId!)!.frozen).toBe(true);
      const row = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row).toMatchObject({
        status: 'scheduled',
        walletId,
        walletProvider: 'fintava',
      });
      expect(row.walletFrozenAt).not.toBeNull();
      expect(row.purgeAfter.toISOString()).toBe(out.deletionScheduledAt);
      for (const p of [live, pending]) {
        expect(
          (await prisma.contentPiece.findUniqueOrThrow({ where: { id: p.id } }))
            .status,
        ).toBe('removed');
      }
      // The piece already removed was not the deletion's doing, so it is not remembered.
      const remembered = await prisma.accountDeletionContent.findMany({
        where: { wawuUserId: id },
      });
      expect(remembered.map((r) => r.contentPieceId).sort()).toEqual(
        [live.id, pending.id].sort(),
      );
      expect(
        remembered.find((r) => r.contentPieceId === gone.id),
      ).toBeUndefined();
      expect(
        await prisma.pushStoppedAccount.count({ where: { userWawuId: id } }),
      ).toBe(1);
      expect(scheduleCalls()).toContainEqual([id]);
    });

    it('asked again, keeps its date, freezes the wallet again (round 4) and tells WAWU ID again', async () => {
      const { id } = await person();
      const first = await accounts.deleteAccount(id);
      const later = await piece(id, 'live');
      double.seen.length = 0;
      gateway.scheduleAccountDeletion.mockClear();
      const second = await accounts.deleteAccount(id);
      expect(second.deletionScheduledAt).toBe(first.deletionScheduledAt);
      // Round 4 (R3-1): a repeat request asserts the freeze again. Round 5:
      // and the reconcile every request ends with freezes it once more
      // (idempotent), so two calls.
      expect(frozenCalls()).toBe(2);
      expect(unfrozenCalls()).toBe(0);
      expect(scheduleCalls()).toHaveLength(1);
      expect(
        (
          await prisma.contentPiece.findUniqueOrThrow({
            where: { id: later.id },
          })
        ).status,
      ).toBe('removed');
    });

    it('a person with no wallet (R-6) is scheduled without a word to the provider', async () => {
      const { id } = await person({ wallet: false });
      await accounts.deleteAccount(id);
      expect(double.seen).toEqual([]);
      const row = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row.walletId).toBeNull();
      expect(row.walletFrozenAt).toBeNull();
    });

    it('cancel unfreezes the wallet, brings back exactly the hidden content and resumes push', async () => {
      const { id, walletId } = await person();
      const live = await piece(id, 'live');
      const pending = await piece(id, 'pending');
      const alreadyGone = await piece(id, 'removed');
      await accounts.deleteAccount(id);
      expect(wallets.get(walletId!)!.frozen).toBe(true);

      const out = await accounts.cancelDeletion(id);
      expect(out).toEqual({
        cancelled: true,
        walletUnfrozen: true,
        contentRestored: 2,
      });
      expect(wallets.get(walletId!)!.frozen).toBe(false);
      const status = async (pid: string) =>
        (await prisma.contentPiece.findUniqueOrThrow({ where: { id: pid } }))
          .status;
      expect(await status(live.id)).toBe('live');
      expect(await status(pending.id)).toBe('pending');
      expect(await status(alreadyGone.id)).toBe('removed');
      expect(
        await prisma.accountDeletionContent.count({
          where: { wawuUserId: id },
        }),
      ).toBe(0);
      expect(
        await prisma.pushStoppedAccount.count({ where: { userWawuId: id } }),
      ).toBe(0);
      const row = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row.status).toBe('cancelled');
      expect(row.cancelledAt).not.toBeNull();
      expect(row.walletFrozenAt).toBeNull();

      // Cancelling again, or with nothing scheduled, changes nothing.
      double.seen.length = 0;
      expect(await accounts.cancelDeletion(id)).toEqual({
        cancelled: false,
        walletUnfrozen: false,
        contentRestored: 0,
      });
      expect(double.seen).toEqual([]);
      expect(await accounts.cancelDeletion(randomUUID())).toMatchObject({
        cancelled: false,
      });

      // And the person can ask to delete again later: a new 30 days.
      const again = await accounts.deleteAccount(id);
      expect(new Date(again.deletionScheduledAt).getTime()).toBeGreaterThan(
        Date.now() + 29 * DAY_MS,
      );
      expect(wallets.get(walletId!)!.frozen).toBe(true);
    });

    it('a cancel the provider cannot finish changes nothing, and can be made again', async () => {
      const { id, walletId } = await person();
      const live = await piece(id, 'live');
      await accounts.deleteAccount(id);
      await double.pause();
      try {
        await expect(accounts.cancelDeletion(id)).rejects.toMatchObject({
          status: 503,
        });
      } finally {
        await double.resume();
      }
      expect(
        (
          await prisma.accountDeletion.findUniqueOrThrow({
            where: { wawuUserId: id },
          })
        ).status,
      ).toBe('scheduled');
      expect(
        (
          await prisma.contentPiece.findUniqueOrThrow({
            where: { id: live.id },
          })
        ).status,
      ).toBe('removed');
      expect(await accounts.cancelDeletion(id)).toMatchObject({
        cancelled: true,
      });
      expect(wallets.get(walletId!)!.frozen).toBe(false);
    });

    it("POST /account/cancel-deletion works over HTTP with the person's own token", async () => {
      await prisma.accountDeletion.deleteMany({
        where: { wawuUserId: HTTP_USER },
      });
      await person({ wallet: false, id: HTTP_USER });
      const live = await piece(HTTP_USER, 'live');
      await request(app.getHttpServer() as Server)
        .delete('/api/hub/account')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      const res = await request(app.getHttpServer() as Server)
        .post('/api/hub/account/cancel-deletion')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);
      expect(res.body).toEqual({
        statusCode: 200,
        message: 'OK',
        data: { cancelled: true, walletUnfrozen: false, contentRestored: 1 },
      });
      expect(
        (
          await prisma.contentPiece.findUniqueOrThrow({
            where: { id: live.id },
          })
        ).status,
      ).toBe('live');
      await request(app.getHttpServer() as Server)
        .post('/api/hub/account/cancel-deletion')
        .expect(401);
    });
  });

  describe('the end of the 30 days', () => {
    async function dueDeletion(id: string): Promise<void> {
      await accounts.deleteAccount(id);
      await prisma.accountDeletion.update({
        where: { wawuUserId: id },
        data: {
          purgeAfter: new Date(Date.now() - 1000),
          scheduledAt: new Date(Date.now() - 31 * DAY_MS),
        },
      });
    }

    it("does nothing before the time, and deletes the Hub's data after it", async () => {
      const gone = await person();
      const kept = await person();
      await accounts.deleteAccount(gone.id);
      await sweep.runOnce();
      expect(finalizeCalls()).not.toContainEqual([gone.id]);
      const mine = await piece(gone.id, 'live');
      expect(await prisma.contentPiece.count({ where: { id: mine.id } })).toBe(
        1,
      );

      await prisma.accountDeletion.update({
        where: { wawuUserId: gone.id },
        data: {
          purgeAfter: new Date(Date.now() - 1000),
          scheduledAt: new Date(Date.now() - 31 * DAY_MS),
        },
      });
      const r = await sweep.runOnce();
      expect(r.purged).toBeGreaterThanOrEqual(1);
      expect(finalizeCalls()).toContainEqual([gone.id]);
      expect(await prisma.contentPiece.count({ where: { id: mine.id } })).toBe(
        0,
      );
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: kept.id } }),
      ).toBe(1);
      const row = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: gone.id },
      });
      expect(row.status).toBe('purged');
      expect(row.purgedAt).not.toBeNull();
    });

    it("leaves no points row of the deleted person and touches nobody else's (POINTS-01)", async () => {
      const gone = await person({ wallet: false });
      const other = await person({ wallet: false });
      const end = new Date(Date.now() + 90 * DAY_MS);
      for (const [who, n] of [
        [gone.id, 10],
        [other.id, 7],
      ] as const) {
        await points.grant({
          wawuUserId: who,
          source: 'pack',
          sourceRef: `s06-${who}`,
          points: n,
          expiresAt: end,
        });
      }
      // A job in flight when the 30 days end: its hold is released, never left to fail the purge.
      await points.hold({
        wawuUserId: gone.id,
        purpose: 'ai_job',
        reference: `s06-job-${gone.id}`,
        points: 4,
      });
      await points.hold({
        wawuUserId: other.id,
        purpose: 'ai_job',
        reference: `s06-job-${other.id}`,
        points: 2,
      });
      const countFor = async (who: string) => ({
        lots: await prisma.pointLot.count({ where: { wawuUserId: who } }),
        holds: await prisma.pointHold.count({ where: { wawuUserId: who } }),
        ledger: await prisma.pointLedger.count({ where: { wawuUserId: who } }),
      });
      const otherBefore = await countFor(other.id);
      expect(
        otherBefore.lots + otherBefore.holds + otherBefore.ledger,
      ).toBeGreaterThan(0);

      await dueDeletion(gone.id);
      await sweep.runOnce();

      expect(await countFor(gone.id)).toEqual({ lots: 0, holds: 0, ledger: 0 });
      expect(await countFor(other.id)).toEqual(otherBefore);
      expect(
        (
          await prisma.accountDeletion.findUniqueOrThrow({
            where: { wawuUserId: gone.id },
          })
        ).status,
      ).toBe('purged');
    });

    it('keeps the account while money is still there, and says why', async () => {
      const { id, walletId } = await person();
      const mine = await piece(id, 'live');
      await dueDeletion(id);
      wallets.get(walletId!)!.balanceKobo = 90_000;
      const r = await sweep.runOnce();
      expect(r.blocked).toBeGreaterThanOrEqual(1);
      expect(finalizeCalls()).not.toContainEqual([id]);
      expect(await prisma.contentPiece.count({ where: { id: mine.id } })).toBe(
        1,
      );
      const row = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      expect(row).toMatchObject({
        status: 'scheduled',
        purgeBlockedBy: 'wallet_balance',
      });
      expect(row.purgeBlockedAt).not.toBeNull();
      expect(row.purgeAttempts).toBe(1);

      // When the money is gone the next pass deletes it.
      wallets.get(walletId!)!.balanceKobo = 0;
      await sweep.runOnce();
      expect(await prisma.contentPiece.count({ where: { id: mine.id } })).toBe(
        0,
      );
      expect(
        (
          await prisma.accountDeletion.findUniqueOrThrow({
            where: { wawuUserId: id },
          })
        ).status,
      ).toBe('purged');
    });

    it("asks WAWU ID again next pass when it did not answer, with the Hub's data already gone", async () => {
      const { id } = await person({ wallet: false });
      const mine = await piece(id, 'live');
      await dueDeletion(id);
      gateway.finalizeAccountDeletion.mockRejectedValueOnce(new Error('down'));
      const first = await sweep.runOnce();
      expect(first.identityPending).toBeGreaterThanOrEqual(1);
      expect(await prisma.contentPiece.count({ where: { id: mine.id } })).toBe(
        0,
      );
      expect(
        (
          await prisma.accountDeletion.findUniqueOrThrow({
            where: { wawuUserId: id },
          })
        ).status,
      ).toBe('purging'); // claimed: data is gone, so no cancel; the next pass finishes it
      const second = await sweep.runOnce();
      expect(second.purged).toBeGreaterThanOrEqual(1);
      expect(
        (
          await prisma.accountDeletion.findUniqueOrThrow({
            where: { wawuUserId: id },
          })
        ).status,
      ).toBe('purged');
    });

    it('does not touch a deletion that was cancelled', async () => {
      const { id } = await person({ wallet: false });
      const mine = await piece(id, 'live');
      await dueDeletion(id);
      await accounts.cancelDeletion(id);
      await sweep.runOnce();
      expect(finalizeCalls()).not.toContainEqual([id]);
      expect(await prisma.contentPiece.count({ where: { id: mine.id } })).toBe(
        1,
      );
    });
  });
});
