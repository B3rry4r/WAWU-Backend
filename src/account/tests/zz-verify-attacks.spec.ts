/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- the verifier's attack spec, kept as written (formatting only) */
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
import { AccountDeletionSweepService } from '../account-deletion-sweep.service';
import { AccountService } from '../account.service';
import { AccountDeletionMoneyService } from '../account-deletion-money.service';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from '../wawu-id-account.gateway';

// VERIFIER ATTACKS for SETTINGS-06 (not part of the product; never committed).
type W = { balanceKobo: number; frozen: boolean };

describe('SETTINGS-06 verifier attacks', () => {
  const double = new FintavaDouble();
  const wallets = new Map<string, W>();
  const faults = {
    failBalanceWhenFrozen: false,
    lostFreezeAnswer: false,
    balanceDelayMs: 0,
    failUnfreeze: false,
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

  function piece(
    creator: string,
    status: 'live' | 'pending' | 'removed' | 'rejected',
  ) {
    const id = randomUUID();
    return prisma.contentPiece.create({
      data: {
        id,
        slug: `v06-${id.slice(0, 8)}`,
        creatorWawuId: creator,
        contentType: 'video',
        title: 'FIXTURE: zz-verify-attacks.spec.ts',
        description: 'Owned by the verifier attack spec.',
        category: 'beauty',
        tags: [],
        accessType: 'free',
        price: 0,
        previewAssetUrl: 'https://storage.test/fixture-preview.mp4',
        status,
      },
    });
  }

  async function holdFor(payer: string, payee: string) {
    const id = randomUUID();
    const p = await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'tip',
        targetId: id,
        title: 'A tip',
        priceKobo: 10000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 10000n,
        payeeShareKobo: 8500n,
        wawuShareKobo: 1500n,
        customerReference: `v06-${id}`,
        merchantAccountNumber: '1102038668',
        status: 'completed',
      },
    });
    return prisma.walletHold.create({
      data: {
        paymentId: p.id,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'paid_dm',
        targetId: p.id,
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
      const r = await accounts.deleteAccount(id);
      return { ok: true as const, r };
    } catch (e) {
      return { ok: false as const, status: status(e), code: code(e) };
    }
  }

  async function due(id: string) {
    await prisma.accountDeletion.update({
      where: { wawuUserId: id },
      data: {
        purgeAfter: new Date(Date.now() - 1000),
        scheduledAt: new Date(Date.now() - 31 * 86400000),
      },
    });
  }

  beforeAll(async () => {
    await double.start();
    double.on('GET', /^\/customer\/wallet\/balance\//, (req) => {
      const id = decodeURIComponent(req.path.split('/').pop()!);
      const w = wallets.get(id);
      if (!w)
        return { status: 404, body: { status: 404, message: ['No wallet'] } };
      if (faults.failBalanceWhenFrozen && w.frozen)
        return { status: 500, body: { message: 'boom' } };
      return {
        status: 200,
        delayMs: faults.balanceDelayMs || undefined,
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
      return { status: 200, body: FREEZE_200 };
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
      FINTAVA_API_KEY: 'live_test_v06_0123456789FAKEKEY',
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
    faults.balanceDelayMs = 0;
    faults.failUnfreeze = false;
    gateway.scheduleAccountDeletion.mockClear();
    gateway.finalizeAccountDeletion.mockClear();
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

  const frozenCount = () =>
    double.seen.filter((r) => r.path.endsWith('/freeze')).length;
  const unfrozenCount = () =>
    double.seen.filter((r) => r.path.endsWith('/unfreeze')).length;

  it('A1 balance read fails AFTER the freeze: wallet must not stay frozen with nothing scheduled', async () => {
    const { id, walletId } = await person(0);
    faults.failBalanceWhenFrozen = true;
    const r = await attempt(id);
    faults.failBalanceWhenFrozen = false;
    const rows = await prisma.accountDeletion.count({
      where: { wawuUserId: id },
    });
    console.log(
      'A1',
      JSON.stringify({
        r,
        rows,
        frozen: wallets.get(walletId)!.frozen,
        freezes: frozenCount(),
        unfreezes: unfrozenCount(),
      }),
    );
    // Then: cancel does not release it either
    const c = await accounts.cancelDeletion(id);
    console.log(
      'A1 cancel',
      JSON.stringify({ c, frozen: wallets.get(walletId)!.frozen }),
    );
    // And a retry that now finds money is told to empty a wallet it cannot send from
    wallets.get(walletId)!.balanceKobo = 5000;
    const r2 = await attempt(id);
    console.log(
      'A1 retry with money',
      JSON.stringify({ r2, frozen: wallets.get(walletId)!.frozen }),
    );
    expect(wallets.get(walletId)!.frozen).toBe(false);
  });

  it('A2 freeze answer lost (provider froze it, 500 back): wallet frozen, nothing scheduled', async () => {
    const { id, walletId } = await person(0);
    faults.lostFreezeAnswer = true;
    const r = await attempt(id);
    faults.lostFreezeAnswer = false;
    const rows = await prisma.accountDeletion.count({
      where: { wawuUserId: id },
    });
    console.log(
      'A2',
      JSON.stringify({ r, rows, frozen: wallets.get(walletId)!.frozen }),
    );
    expect(wallets.get(walletId)!.frozen).toBe(false);
  });

  it('A3 cancel while the sweep is mid-pass (balance read slow)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id, walletId } = await person(0);
    const kept = await piece(id, 'live');
    expect((await attempt(id)).ok).toBe(true);
    await due(id);
    faults.balanceDelayMs = 1500;
    const sweepP = sweep.runOnce();
    await new Promise((r) => setTimeout(r, 400));
    faults.balanceDelayMs = 0;
    const cancelRes = await accounts.cancelDeletion(id);
    const sweepRes = await sweepP;
    const row = await prisma.accountDeletion.findUniqueOrThrow({
      where: { wawuUserId: id },
    });
    const content = await prisma.contentPiece.findUnique({
      where: { id: kept.id },
    });
    const wallet = await prisma.fintavaWallet.findUnique({
      where: { wawuUserId: id },
    });
    console.log(
      'A3',
      JSON.stringify({
        cancelRes,
        sweepRes,
        status: row.status,
        contentExists: !!content,
        walletRow: !!wallet,
        finalize: gateway.finalizeAccountDeletion.mock.calls.length,
      }),
    );
    expect(content).not.toBeNull();
    expect(row.status).toBe('cancelled');
  });

  it('A4 three parallel DELETEs', async () => {
    const { id, walletId } = await person(0);
    await piece(id, 'live');
    const rs = await Promise.all([attempt(id), attempt(id), attempt(id)]);
    const rows = await prisma.accountDeletion.findMany({
      where: { wawuUserId: id },
    });
    const hiddenRows = await prisma.accountDeletionContent.count({
      where: { wawuUserId: id },
    });
    console.log(
      'A4',
      JSON.stringify({
        rs: rs.map((x) => (x.ok ? x.r : x)),
        rows: rows.length,
        purgeAfter: rows[0]?.purgeAfter,
        hiddenRows,
        freezes: frozenCount(),
        frozen: wallets.get(walletId)!.frozen,
      }),
    );
    expect(rows.length).toBe(1);
  });

  it('A5 repeat DELETE racing a cancel, 15 rounds: no cancelled account with hidden content', async () => {
    let bad = 0;
    const samples: string[] = [];
    for (let i = 0; i < 15; i++) {
      const { id } = await person(0);
      const p = await piece(id, 'live');
      await accounts.deleteAccount(id);
      await Promise.all([attempt(id), accounts.cancelDeletion(id)]);
      const row = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      const c = await prisma.contentPiece.findUniqueOrThrow({
        where: { id: p.id },
      });
      const hid = await prisma.accountDeletionContent.count({
        where: { wawuUserId: id },
      });
      if (row.status === 'cancelled' && (c.status === 'removed' || hid > 0)) {
        bad++;
        samples.push(`${row.status}/${c.status}/hid${hid}`);
      }
    }
    console.log('A5', JSON.stringify({ bad, samples: samples.slice(0, 3) }));
    expect(bad).toBe(0);
  });

  it('A6 an open hold appears while the balance is being read: DELETE still schedules', async () => {
    const { id } = await person(0);
    const other = randomUUID();
    people.push(other);
    faults.balanceDelayMs = 1200;
    const p = attempt(id);
    await new Promise((r) => setTimeout(r, 400));
    await holdFor(other, id);
    const r = await p;
    faults.balanceDelayMs = 0;
    const row = await prisma.accountDeletion.findUnique({
      where: { wawuUserId: id },
    });
    const holds = await prisma.walletHold.count({
      where: { payeeWawuUserId: id, status: 'held' },
    });
    console.log(
      'A6',
      JSON.stringify({ ok: r.ok, scheduled: !!row, openHolds: holds }),
    );
    // The sweep's net: due, then looked at again.
    if (row) {
      await due(id);
      const res = await sweep.runOnce();
      const row2 = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: id },
      });
      console.log(
        'A6 sweep',
        JSON.stringify({ res, status: row2.status, by: row2.purgeBlockedBy }),
      );
    }
  });

  it('A7 restore: hidden pieces only; a piece made later, an already-removed one, an admin-removed one', async () => {
    const { id } = await person(0);
    const live = await piece(id, 'live');
    const pend = await piece(id, 'pending');
    const rej = await piece(id, 'rejected');
    const gone = await piece(id, 'removed');
    expect((await attempt(id)).ok).toBe(true);
    const later = await piece(id, 'live');
    const c = await accounts.cancelDeletion(id);
    const st = async (p: { id: string }) =>
      (await prisma.contentPiece.findUniqueOrThrow({ where: { id: p.id } }))
        .status;
    console.log(
      'A7',
      JSON.stringify({
        c,
        live: await st(live),
        pend: await st(pend),
        rej: await st(rej),
        gone: await st(gone),
        later: await st(later),
      }),
    );
    expect(await st(live)).toBe('live');
    expect(await st(pend)).toBe('pending');
    expect(await st(rej)).toBe('rejected');
    expect(await st(gone)).toBe('removed');
  });

  it('A8 purge of a creator whose content was sold (Purchase.content is Restrict): row marked purged?', async () => {
    const { id } = await person(0);
    const sold = await piece(id, 'live');
    await prisma.purchase.create({
      data: {
        contentId: sold.id,
        type: 'content',
        buyerWawuId: randomUUID(),
        creatorWawuId: id,
        amount: 1000,
        commissionRate: '0.1500',
        flutterwaveTxRef: `v06-${randomUUID()}`,
        status: 'completed',
      },
    });
    expect((await attempt(id)).ok).toBe(true);
    await due(id);
    const res = await sweep.runOnce();
    const row = await prisma.accountDeletion.findUniqueOrThrow({
      where: { wawuUserId: id },
    });
    const left = await prisma.contentPiece.count({
      where: { creatorWawuId: id },
    });
    console.log(
      'A8',
      JSON.stringify({
        res,
        status: row.status,
        by: row.purgeBlockedBy,
        contentLeft: left,
        finalize: gateway.finalizeAccountDeletion.mock.calls.length,
      }),
    );
  });

  it('A9 cash-out in flight, wallet opening, no wallet + earnings', async () => {
    const { id } = await person(0);
    await prisma.pointHold.create({
      data: {
        wawuUserId: id,
        purpose: 'cash_out',
        reference: `v06-${randomUUID()}`,
        quantity: 10,
        state: 'held',
      },
    });
    const r = await attempt(id);
    console.log('A9 cashout', JSON.stringify(r));
    expect(r.ok).toBe(false);
    const nw = randomUUID();
    people.push(nw);
    await prisma.fintavaWalletOpening
      .create({
        data: {
          wawuUserId: nw,
          state: 'opening',
          bvnHash: `h-${nw}`,
          bvnVerifiedAt: new Date(),
          phone: `+234${Math.floor(Math.random() * 1e10)}`,
        } as never,
      })
      .catch((e) =>
        console.log(
          'A9 opening create failed',
          (e as Error).message.slice(0, 200),
        ),
      );
    const r2 = await attempt(nw);
    console.log('A9 opening', JSON.stringify(r2));
    await prisma.fintavaWalletOpening.deleteMany({ where: { wawuUserId: nw } });
  });
  it('N1 provider without freeze (Nuvion shape): up-front and final checks still guard', async () => {
    const svc = app.get(AccountDeletionMoneyService) as unknown as {
      provider: Record<string, unknown>;
    };
    const real = svc.provider;
    const noFreeze = new Proxy(real, {
      get(t, k, r) {
        if (k === 'freezeWallet' || k === 'unfreezeWallet') return undefined;
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    svc.provider = noFreeze as never;
    try {
      const rich = await person(250_000);
      const r1 = await attempt(rich.id);
      const poor = await person(0);
      await piece(poor.id, 'live');
      const r2 = await attempt(poor.id);
      const row = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: poor.id },
      });
      // money arrives in the window (nothing is frozen)
      wallets.get(poor.walletId)!.balanceKobo = 90_000;
      await due(poor.id);
      const s1 = await sweep.runOnce();
      const row1 = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: poor.id },
      });
      wallets.get(poor.walletId)!.balanceKobo = 0;
      const s2 = await sweep.runOnce();
      const row2 = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: poor.id },
      });
      console.log(
        'N1',
        JSON.stringify({
          rich: r1.ok ? 'scheduled' : r1,
          poorOk: r2.ok,
          walletFrozenAt: row.walletFrozenAt,
          freezeCalls: frozenCount(),
          s1,
          by1: row1.purgeBlockedBy,
          s2,
          status2: row2.status,
        }),
      );
    } finally {
      svc.provider = real;
    }
  });

  it('N2 provider switched after scheduling: cancel on a provider that cannot unfreeze', async () => {
    const svc = app.get(AccountDeletionMoneyService) as unknown as {
      provider: Record<string, unknown>;
    };
    const real = svc.provider;
    const p = await person(0);
    expect((await attempt(p.id)).ok).toBe(true);
    const frozenBefore = wallets.get(p.walletId)!.frozen;
    svc.provider = new Proxy(real, {
      get(t, k, r) {
        if (k === 'freezeWallet' || k === 'unfreezeWallet') return undefined;
        const v = Reflect.get(t, k, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as never;
    try {
      const c = await accounts.cancelDeletion(p.id);
      const row = await prisma.accountDeletion.findUniqueOrThrow({
        where: { wawuUserId: p.id },
      });
      console.log(
        'N2',
        JSON.stringify({
          frozenBefore,
          c,
          status: row.status,
          frozenAfter: wallets.get(p.walletId)!.frozen,
        }),
      );
    } finally {
      svc.provider = real;
    }
  });
  it('A10 WAWU ID down during the sweep (data purged, identity pending), then the person cancels', async () => {
    const p = await person(0);
    const kept = await piece(p.id, 'live');
    expect((await attempt(p.id)).ok).toBe(true);
    await due(p.id);
    gateway.finalizeAccountDeletion.mockRejectedValueOnce(
      new Error('wawu id down'),
    );
    const s1 = await sweep.runOnce();
    const mid = await prisma.accountDeletion.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    const c = await accounts.cancelDeletion(p.id);
    const end = await prisma.accountDeletion.findUniqueOrThrow({
      where: { wawuUserId: p.id },
    });
    const s2 = await sweep.runOnce();
    const content = await prisma.contentPiece.findUnique({
      where: { id: kept.id },
    });
    const walletRow = await prisma.fintavaWallet.findUnique({
      where: { wawuUserId: p.id },
    });
    console.log(
      'A10',
      JSON.stringify({
        s1,
        midStatus: mid.status,
        midBy: mid.purgeBlockedBy,
        c,
        endStatus: end.status,
        s2,
        contentExists: !!content,
        walletRow: !!walletRow,
        finalizeCalls: gateway.finalizeAccountDeletion.mock.calls.length,
      }),
    );
  });
});
