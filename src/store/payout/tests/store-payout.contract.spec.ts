// Contract tests for STORE-PAYOUT (R-101 point 4): WAWU pays a creator's 85% of a store sale from its own
// account, 3 working days on, through WALLET_PROVIDER. Real database, the real payout code and the real
// ledger; the wallet provider is the Nuvion stand-in (test/payments/nuvion-seam-standin.ts: its documented
// accounts and book transfers). No Fintava, Nuvion or store host is called. Run with
//   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/test_payout_a?schema=public

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5432/test_payout_a?schema=public';

import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../../common/prisma/prisma.module';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { PlanSettingsModule } from '../../../plan-settings/plan-settings.module';
import { StoreEarningService } from '../../store-earning.service';
import { LedgerService } from '../../../money/ledger/ledger.service';
import { WALLET_PROVIDER } from '../../../wallet-provider/wallet-provider.interface';
import {
  type NuvionAccount,
  NuvionSeamStandIn,
} from '../../../../test/payments/nuvion-seam-standin';
import { WalletFundingService } from '../../../wallet/wallet-funding.service';
import { StoreAdminNoticeService } from '../store-admin-notice.service';
import { StorePayoutModule } from '../store-payout.module';
import { StorePayoutService } from '../store-payout.service';
import { payoutReference } from '../store-payout-rules';

jest.setTimeout(120_000);

const DAY = 86_400_000;

describe('STORE-PAYOUT: paying a creator for a store sale (Nuvion stood in)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let payouts: StorePayoutService;
  let other: StorePayoutService;
  let notices: StoreAdminNoticeService;
  let storeEarnings: StoreEarningService;
  const nuvion = new NuvionSeamStandIn();
  const people: string[] = [];
  const purchaseIds: string[] = [];
  const messageIds: string[] = [];
  const previous: Record<string, string | undefined> = {};
  let seq = 0;

  type Creator = { id: string; account: NuvionAccount | null };

  async function creator(walletKobo: number | null): Promise<Creator> {
    const id = randomUUID();
    people.push(id);
    const c: Creator = { id, account: null };
    if (walletKobo !== null) await openWallet(c, walletKobo);
    return c;
  }

  async function openWallet(c: Creator, kobo: number): Promise<void> {
    seq += 1;
    const accountNumber = `85${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
    c.account = nuvion.openAccount(BigInt(kobo), accountNumber);
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: c.id,
        customerId: c.account.entityId,
        walletId: c.account.accountId,
        accountNumber,
        provider: 'nuvion',
      },
    });
  }

  /** A store earning (the creator's 85%), due unless `daysAgo` says otherwise. */
  async function earning(
    c: Creator,
    grossKobo: number,
    over: {
      availableAt?: Date;
      status?: string;
      role?: string;
    } = {},
  ) {
    return prisma.storeEarning.create({
      data: {
        storePurchaseId: randomUUID(),
        role: over.role ?? 'sale',
        payeeWawuUserId: c.id,
        kind: 'content_unlock',
        targetId: randomUUID(),
        title: 'A piece',
        earnedAt: new Date(Date.now() - 6 * DAY),
        listPriceKobo: BigInt(Math.round((grossKobo * 100) / 85)),
        amountKobo: BigInt(grossKobo),
        availableAt: over.availableAt ?? new Date(Date.now() - DAY),
        provider: 'nuvion',
        status: over.status ?? 'owed',
        ...(over.status === 'cancelled'
          ? { cancelledAt: new Date(), cancelReason: 'refunded_by_store' }
          : {}),
      },
    });
  }

  async function deduction(c: Creator, kobo: number, ageDays = 0) {
    return prisma.earningDeduction.create({
      data: {
        payeeWawuUserId: c.id,
        storePurchaseId: randomUUID(),
        amountKobo: BigInt(kobo),
        provider: 'nuvion',
        createdAt: new Date(Date.now() - ageDays * DAY),
      },
    });
  }

  const balance = (c: Creator) => c.account!.availableKobo;
  const merchant = () => nuvion.operational.availableKobo;
  const sentFromMerchant = () => nuvion.sendsFrom(nuvion.operational.accountId);

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      FINTAVA_BASE_URL: 'http://127.0.0.1:9',
      FINTAVA_API_KEY: 'live_test_payout_0123456789FAKEKEY',
    })) {
      previous[k] = process.env[k];
      process.env[k] = v;
    }
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        PlanSettingsModule,
        StorePayoutModule,
      ],
      providers: [StoreEarningService],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(nuvion)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    payouts = moduleRef.get(StorePayoutService);
    notices = moduleRef.get(StoreAdminNoticeService);
    storeEarnings = moduleRef.get(StoreEarningService);
    // A second server: its own service on the same database and provider.
    other = new StorePayoutService(
      prisma,
      nuvion,
      moduleRef.get(LedgerService),
      notices,
    );
    nuvion.mode = 'successful';
  });

  beforeEach(() => {
    nuvion.mode = 'successful';
    nuvion.operational.availableKobo = 100_000_000n;
  });

  afterAll(async () => {
    if (prisma) {
      const earnings = await prisma.storeEarning.findMany({
        where: { payeeWawuUserId: { in: people } },
        select: { id: true },
      });
      const payoutRows = await prisma.storeEarningPayout.findMany({
        where: { payeeWawuUserId: { in: people } },
        select: { id: true },
      });
      await prisma.earningDeductionTake.deleteMany({
        where: { storePayoutId: { in: payoutRows.map((p) => p.id) } },
      });
      await prisma.storeEarningPayout.deleteMany({
        where: { payeeWawuUserId: { in: people } },
      });
      await prisma.earningDeduction.deleteMany({
        where: { payeeWawuUserId: { in: people } },
      });
      await prisma.storeEarning.deleteMany({
        where: { id: { in: earnings.map((e) => e.id) } },
      });
      await prisma.fintavaLedgerEntry.deleteMany({
        where: { customerReference: { startsWith: 'wawu-spay-' } },
      });
      await prisma.fintavaWallet.deleteMany({
        where: { wawuUserId: { in: people } },
      });
      await prisma.storeAdminNotice.deleteMany({
        where: { kind: 'store_payout_short' },
      });
      await prisma.purchase.deleteMany({ where: { id: { in: purchaseIds } } });
      await prisma.directMessage.deleteMany({
        where: { id: { in: messageIds } },
      });
    }
    if (moduleRef) await moduleRef.close();
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('pays the creator their share once, writes the ledger, and a second pass pays nothing', async () => {
    const c = await creator(0);
    const e = await earning(c, 85_000);
    const before = merchant();

    const first = await payouts.sweep();
    expect(first.planned).toBeGreaterThanOrEqual(1);
    const row = await prisma.storeEarningPayout.findUniqueOrThrow({
      where: { storeEarningId: e.id },
    });
    expect(row).toMatchObject({
      status: 'paid',
      grossKobo: 85_000n,
      deductedKobo: 0n,
      amountKobo: 85_000n,
      customerReference: payoutReference(e.id, 1),
    });
    expect(balance(c)).toBe(85_000n);
    expect(merchant()).toBe(before - 85_000n);
    const earned = await prisma.storeEarning.findUniqueOrThrow({
      where: { id: e.id },
    });
    expect(earned.status).toBe('paid');
    expect(earned.paidAt).not.toBeNull();

    // The creator sees it land: a ledger row in, category earning, linked to what was sold.
    const inRow = await prisma.fintavaLedgerEntry.findFirstOrThrow({
      where: {
        wawuUserId: c.id,
        direction: 'in',
        customerReference: payoutReference(e.id, 1),
      },
    });
    expect(inRow).toMatchObject({ category: 'earning', status: 'completed' });
    expect(Number(inRow.amountKobo)).toBe(85_000);

    const sends = sentFromMerchant().length;
    await payouts.sweep();
    await other.sweep();
    expect(sentFromMerchant().length).toBe(sends);
    expect(balance(c)).toBe(85_000n);
  });

  it('does not pay an earning before its day, nor a cancelled one', async () => {
    const c = await creator(0);
    const future = await earning(c, 85_000, {
      availableAt: new Date(Date.now() + 2 * DAY),
    });
    const cancelled = await earning(c, 42_500, { status: 'cancelled' });
    await payouts.sweep();
    expect(
      await prisma.storeEarningPayout.count({
        where: { storeEarningId: { in: [future.id, cancelled.id] } },
      }),
    ).toBe(0);
    expect(balance(c)).toBe(0n);
    // Its day comes: paid.
    await payouts.sweep(new Date(Date.now() + 3 * DAY));
    expect(balance(c)).toBe(85_000n);
  });

  it('runs at once pay each earning once (a race of three servers over several earnings)', async () => {
    const c = await creator(0);
    const d = await creator(0);
    const es = [
      await earning(c, 170_000),
      await earning(c, 8_500),
      await earning(d, 42_500),
      await earning(d, 85_000),
    ];
    const before = merchant();
    const third = new StorePayoutService(
      prisma,
      nuvion,
      moduleRef.get(LedgerService),
      notices,
    );
    await Promise.all([payouts.sweep(), other.sweep(), third.sweep()]);
    await Promise.all([payouts.sweep(), other.sweep(), third.sweep()]);
    expect(balance(c)).toBe(178_500n);
    expect(balance(d)).toBe(127_500n);
    expect(merchant()).toBe(before - 306_000n);
    for (const e of es) {
      expect(
        await prisma.storeEarningPayout.count({
          where: { storeEarningId: e.id },
        }),
      ).toBe(1);
      expect(
        sentFromMerchant().filter(
          (t) => t.request.unique_reference === payoutReference(e.id, 1),
        ),
      ).toHaveLength(1);
      expect(
        await prisma.fintavaLedgerEntry.count({
          where: { customerReference: payoutReference(e.id, 1) },
        }),
      ).toBe(2);
    }
  });

  it('nets open deductions oldest first and never below zero', async () => {
    const c = await creator(0);
    const old = await deduction(c, 20_000, 3);
    const newer = await deduction(c, 80_000, 1);
    const e = await earning(c, 85_000);
    await payouts.sweep();
    const row = await prisma.storeEarningPayout.findUniqueOrThrow({
      where: { storeEarningId: e.id },
      include: { takes: true },
    });
    // 20,000 from the older, 65,000 from the newer: nothing is left to send.
    expect(row).toMatchObject({
      status: 'paid',
      deductedKobo: 85_000n,
      amountKobo: 0n,
    });
    const byDeduction = new Map(
      row.takes.map((t) => [t.deductionId, t.amountKobo]),
    );
    expect(byDeduction.get(old.id)).toBe(20_000n);
    expect(byDeduction.get(newer.id)).toBe(65_000n);
    expect(balance(c)).toBe(0n);
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('paid');
    // What is still owed on the newer deduction (15,000) comes out of the next earning.
    const e2 = await earning(c, 85_000);
    await payouts.sweep();
    expect(balance(c)).toBe(70_000n);
    const row2 = await prisma.storeEarningPayout.findUniqueOrThrow({
      where: { storeEarningId: e2.id },
    });
    expect(row2).toMatchObject({ deductedKobo: 15_000n, amountKobo: 70_000n });
    // The guard: no deduction is taken beyond its amount, whoever took it.
    const taken = await prisma.earningDeductionTake.aggregate({
      where: { deductionId: newer.id },
      _sum: { amountKobo: true },
    });
    expect(taken._sum.amountKobo).toBe(80_000n);
  });

  it('a creator without a wallet keeps the earning waiting; it lands when they open one', async () => {
    const c = await creator(null);
    const e = await earning(c, 85_000);
    await payouts.sweep();
    expect(
      await prisma.storeEarningPayout.count({
        where: { storeEarningId: e.id },
      }),
    ).toBe(0);
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('owed');
    await openWallet(c, 0);
    await payouts.sweep();
    expect(balance(c)).toBe(85_000n);
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('paid');
  });

  it('a short merchant wallet pays in availableAt order up to its balance and tells the owner once a day', async () => {
    const c = await creator(0);
    await payouts.sweep();
    await prisma.storeAdminNotice.deleteMany({
      where: { kind: 'store_payout_short' },
    });
    const d1 = await earning(c, 60_000, {
      availableAt: new Date(Date.now() - 3 * DAY),
    });
    const d2 = await earning(c, 50_000, {
      availableAt: new Date(Date.now() - 2 * DAY),
    });
    const d3 = await earning(c, 10_000, {
      availableAt: new Date(Date.now() - DAY),
    });
    nuvion.operational.availableKobo = 100_000n;
    const run = await payouts.sweep();
    expect(run.short).toBe(true);
    const state = async (id: string) =>
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id } })).status;
    // 60,000 fits; 50,000 does not fit in the 40,000 left; the newer 10,000 waits behind it (the order is kept).
    expect(await state(d1.id)).toBe('paid');
    expect(await state(d2.id)).toBe('owed');
    expect(await state(d3.id)).toBe('owed');
    expect(balance(c)).toBe(60_000n);
    expect(merchant()).toBe(40_000n);
    expect(
      await prisma.storeEarningPayout.count({
        where: { storeEarningId: { in: [d2.id, d3.id] } },
      }),
    ).toBe(0);

    // The owner is told once a day, however many passes and servers run.
    await payouts.sweep();
    await other.sweep();
    const told = await prisma.storeAdminNotice.findMany({
      where: { kind: 'store_payout_short' },
    });
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain('are due to creators');
    expect(told[0].body).not.toContain('\u2014');
    expect((await notices.list({ unreadOnly: true })).unread).toBeGreaterThan(
      0,
    );

    // Money is added: the rest is paid, in order.
    nuvion.operational.availableKobo = 1_000_000n;
    await payouts.sweep();
    expect(await state(d2.id)).toBe('paid');
    expect(await state(d3.id)).toBe('paid');
    expect(balance(c)).toBe(120_000n);
  });

  it('the ledger equals the provider after a run', async () => {
    const a = await creator(5_000);
    const b = await creator(0);
    const e1 = await earning(a, 85_000);
    const e2 = await earning(b, 127_500);
    const e3 = await earning(b, 8_500);
    const merchantBefore = merchant();
    const aBefore = balance(a);
    const bBefore = balance(b);
    await payouts.sweep();
    const refs = [e1, e2, e3].map((e) => payoutReference(e.id, 1));

    const ledgerOut = await prisma.fintavaLedgerEntry.aggregate({
      where: { customerReference: { in: refs }, direction: 'out' },
      _sum: { amountKobo: true },
    });
    const providerOut = sentFromMerchant()
      .filter((t) => refs.includes(t.request.unique_reference))
      .reduce((n, t) => n + t.amountKobo, 0n);
    expect(BigInt(ledgerOut._sum.amountKobo ?? 0)).toBe(providerOut);
    expect(providerOut).toBe(85_000n + 127_500n + 8_500n);
    expect(merchantBefore - merchant()).toBe(providerOut);

    for (const [who, before] of [
      [a, aBefore],
      [b, bBefore],
    ] as const) {
      const ledgerIn = await prisma.fintavaLedgerEntry.aggregate({
        where: {
          wawuUserId: who.id,
          direction: 'in',
          customerReference: { in: refs },
        },
        _sum: { amountKobo: true },
      });
      expect(BigInt(ledgerIn._sum.amountKobo ?? 0)).toBe(balance(who) - before);
    }
  });

  it('a sale refunded before anything is sent cancels the payout and gives its takes back', async () => {
    const c = await creator(0);
    const d = await deduction(c, 10_000);
    const e = await earning(c, 85_000);
    // A payout planned and not yet sent (the account was short when it was made), its sale refunded since.
    const p = await prisma.storeEarningPayout.create({
      data: {
        storeEarningId: e.id,
        payeeWawuUserId: c.id,
        provider: 'nuvion',
        grossKobo: 85_000n,
        deductedKobo: 10_000n,
        amountKobo: 75_000n,
        merchantAccountNumber: nuvion.operational.nuvionBan,
        customerReference: payoutReference(e.id, 1),
        takes: { create: { deductionId: d.id, amountKobo: 10_000n } },
      },
    });
    await prisma.storeEarning.update({
      where: { id: e.id },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelReason: 'refunded_by_store',
      },
    });
    const sends = sentFromMerchant().length;
    const r = await payouts.drive(p.id);
    expect(r.state).toBe('cancelled');
    expect(sentFromMerchant().length).toBe(sends);
    expect(balance(c)).toBe(0n);
    expect(
      await prisma.earningDeductionTake.count({
        where: { storePayoutId: p.id },
      }),
    ).toBe(0);
  });

  it('a wallet the provider refuses keeps the earning owed and tries again', async () => {
    const c = await creator(0);
    const e = await earning(c, 85_000);
    nuvion.mode = 'account_not_active';
    await payouts.sweep();
    const row = await prisma.storeEarningPayout.findUniqueOrThrow({
      where: { storeEarningId: e.id },
    });
    expect(row.status).toBe('pending');
    expect(row.sentAt).toBeNull();
    expect(row.waiting).not.toBeNull();
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('owed');
    expect(balance(c)).toBe(0n);
    // The wallet is fine again; the retry (after its rest) pays it once, under the same reference.
    nuvion.mode = 'successful';
    await payouts.sweep(new Date(Date.now() + 2 * 3_600_000));
    expect(balance(c)).toBe(85_000n);
    expect(
      (
        await prisma.storeEarningPayout.findUniqueOrThrow({
          where: { storeEarningId: e.id },
        })
      ).customerReference,
    ).toBe(payoutReference(e.id, 1));
  });

  it('a store sale is paid once: the legacy wallet funding sweep leaves store rows to StoreEarning', async () => {
    const c = await creator(0);
    const buyer = randomUUID();
    const row = async (ref: string) => {
      const id = randomUUID();
      purchaseIds.push(id);
      await prisma.purchase.create({
        data: {
          id,
          type: 'tip',
          buyerWawuId: buyer,
          creatorWawuId: c.id,
          amount: 1000,
          commissionRate: 0.15,
          flutterwaveTxRef: ref,
          status: 'completed',
        },
      });
      return id;
    };
    const storeId = randomUUID();
    const storePurchase = await row(`store:${storeId}`);
    const webPurchase = await row(`FLW-${randomUUID()}`);
    // A question bought in the store, answered; and a card-paid one, answered.
    const message = async (ref: string) => {
      const id = randomUUID();
      messageIds.push(id);
      await prisma.directMessage.create({
        data: {
          id,
          creatorWawuId: c.id,
          senderWawuId: buyer,
          text: 'A question',
          amount: 1000,
          status: 'responded',
          deadlineAt: new Date(Date.now() + DAY),
          respondedAt: new Date(),
          flutterwaveTxRef: ref,
        },
      });
      return id;
    };
    const storeMessage = await message(`store:${randomUUID()}`);
    const webMessage = await message(`FLW-${randomUUID()}`);

    const credited: string[] = [];
    const funding = new WalletFundingService(
      prisma,
      {
        creditEarning: (i: { reference: string }) => {
          credited.push(i.reference);
          return Promise.resolve();
        },
        reconcilePending: () => Promise.resolve({ checked: 0, settled: 0 }),
      } as never,
      {
        get: (k: string) => (k === 'WALLET_FUNDING' ? 'on' : undefined),
      } as never,
    );

    const e = await earning(c, 85_000);
    const before = balance(c);
    await funding.run();
    await payouts.sweep();
    await funding.run();
    await payouts.sweep();
    await other.sweep();

    // The sweep still pays what is not a store sale (so it is running), and never a store row.
    expect(credited).toContain(`purchase:${webPurchase}`);
    expect(credited).toContain(`direct_message:${webMessage}`);
    expect(credited).not.toContain(`purchase:${storePurchase}`);
    expect(credited).not.toContain(`direct_message:${storeMessage}`);
    // The creator got the store sale once, from StoreEarning, on the wallet provider.
    expect(balance(c) - before).toBe(85_000n);
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('paid');
    expect(
      sentFromMerchant().filter(
        (t) => t.request.unique_reference === payoutReference(e.id, 1),
      ),
    ).toHaveLength(1);
  });

  // ---------------------------------------------------------- patch round 1 (verifier V-SP-1, 2, 4)

  /** The store refunds a sale: the creator's share is taken back (the real code, in its own transaction). */
  const refund = (storePurchaseId: string) =>
    prisma.$transaction((tx) =>
      storeEarnings.takeBack(tx, { id: storePurchaseId } as never, new Date()),
    );
  const reverse = (storePurchaseId: string) =>
    prisma.$transaction((tx) =>
      storeEarnings.restore(tx, { id: storePurchaseId } as never, new Date()),
    );

  it('V-SP-1: a refund racing the send either cancels before anything leaves or becomes a deduction after, never both', async () => {
    const c = await creator(0);
    const e = await earning(c, 85_000);
    await payouts['plan'](new Date(), Date.now(), 45_000); // the payout is made, nothing is sent
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    // The refund reads the earning, then waits before it writes (the verifier's order).
    const refunding = prisma.$transaction(async (tx) => {
      const gated = new Proxy(tx, {
        get(target, prop, receiver) {
          const v = Reflect.get(target, prop, receiver) as unknown;
          if (prop !== 'storeEarning') return v;
          return new Proxy(v as object, {
            get(model, key) {
              const f = Reflect.get(model, key) as (...a: unknown[]) => unknown;
              if (key !== 'update' && key !== 'updateMany') return f;
              return async (...a: unknown[]) => {
                entered();
                await gate;
                return f.apply(model, a);
              };
            },
          });
        },
      });
      return storeEarnings.takeBack(
        gated,
        { id: e.storePurchaseId } as never,
        new Date(),
      );
    });
    await inside;
    const sweeping = payouts.sweep(); // the send must not pass the refund
    await new Promise((r) => setTimeout(r, 500));
    release();
    await refunding;
    await sweeping;
    await payouts.sweep();

    const earned = await prisma.storeEarning.findUniqueOrThrow({
      where: { id: e.id },
    });
    const payout = await prisma.storeEarningPayout.findUniqueOrThrow({
      where: { storeEarningId: e.id },
    });
    const debt = await prisma.earningDeduction.findUnique({
      where: { storePurchaseId: e.storePurchaseId },
    });
    // The refund came first: nothing left WAWU's account, the earning and the payout are cancelled.
    expect(earned.status).toBe('cancelled');
    expect(payout.status).toBe('cancelled');
    expect(balance(c)).toBe(0n);
    expect(debt).toBeNull();
    // Whichever way the race goes, money out always has a debt or a paid earning behind it.
    expect(balance(c) === 0n || debt !== null || earned.status === 'paid').toBe(
      true,
    );
  });

  it('V-SP-1: a refund of an earning whose transfer is out is a deduction, not a cancellation', async () => {
    const c = await creator(0);
    const e = await earning(c, 85_000);
    nuvion.mode = 'pending'; // the provider takes the transfer and says it is not finished
    await payouts.sweep();
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('sending');
    const out = await refund(e.storePurchaseId);
    expect(out.earning).toBe('debt');
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('sending');
    nuvion.mode = 'successful';
    const p = await prisma.storeEarningPayout.findUniqueOrThrow({
      where: { storeEarningId: e.id },
    });
    nuvion.settle(p.customerReference, 'successful');
    await payouts.sweep(new Date(Date.now() + 10 * 60_000));
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('paid');
    expect(balance(c)).toBe(85_000n);
    const debt = await prisma.earningDeduction.findUniqueOrThrow({
      where: { storePurchaseId: e.storePurchaseId },
    });
    expect(debt.amountKobo).toBe(85_000n); // taken from the creator's next earnings
  });

  it('V-SP-2: a refund, then the store reverses it, then the payout: the creator is paid once', async () => {
    const c = await creator(0);
    const e = await earning(c, 85_000);
    await payouts['plan'](new Date(), Date.now(), 45_000); // payout made, nothing sent
    expect((await refund(e.storePurchaseId)).earning).toBe('cancelled');
    await payouts.sweep(); // the lease sees the cancelled sale and cancels the payout
    expect(
      (
        await prisma.storeEarningPayout.findUniqueOrThrow({
          where: { storeEarningId: e.id },
        })
      ).status,
    ).toBe('cancelled');
    expect((await reverse(e.storePurchaseId)).earning).toBe('restored');

    await payouts.sweep();
    await other.sweep();
    await payouts.sweep();
    expect(balance(c)).toBe(85_000n);
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('paid');
    // One payout row, one transfer under its reference.
    expect(
      await prisma.storeEarningPayout.count({
        where: { storeEarningId: e.id },
      }),
    ).toBe(1);
    expect(
      sentFromMerchant().filter(
        (t) => t.request.unique_reference === payoutReference(e.id, 1),
      ),
    ).toHaveLength(1);
  });

  it('V-SP-4: a refusal for funds writes a notice from the real balance and the real earnings waiting', async () => {
    await payouts.sweep();
    await prisma.storeAdminNotice.deleteMany({
      where: { kind: 'store_payout_short' },
    });
    const c = await creator(0);
    const e = await earning(c, 85_000);
    nuvion.mode = 'insufficient';
    await payouts.sweep();
    nuvion.mode = 'successful';
    const told = await prisma.storeAdminNotice.findMany({
      where: { kind: 'store_payout_short' },
    });
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain('holds \u20a61,000,000');
    expect(told[0].body).toContain('1 store earning worth \u20a6850 is due');
    expect(told[0].body).not.toContain('holds \u20a60.');
    // And a refusal that proves nothing is waiting writes nothing and keeps the day's key free.
    await prisma.storeAdminNotice.deleteMany({
      where: { kind: 'store_payout_short' },
    });
    await payouts.sweep(new Date(Date.now() + 10 * 60_000));
    expect(
      (await prisma.storeEarning.findUniqueOrThrow({ where: { id: e.id } }))
        .status,
    ).toBe('paid');
    nuvion.mode = 'insufficient';
    await payouts['tellShort'](new Date());
    nuvion.mode = 'successful';
    expect(
      await prisma.storeAdminNotice.count({
        where: { kind: 'store_payout_short' },
      }),
    ).toBe(0);
  });
});
