import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  clearCommunities,
  phraseFor,
  type Deps,
  type Options,
} from '../../../scripts/ops/clear-communities';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * OPS-CLEAR-ROOMS fix round 1: the money rules a room is kept for, one room each, and the two races (a purchase that
 * commits during the apply, and one still open when the apply reaches the room). Made-up rooms on the test database.
 * Each "kept" room has a control that clears, so a rule that is removed fails a row here.
 */
const SWEEP_START = new Date('2026-06-01T00:00:00Z');
const SANDBOX_ENV: Record<string, string> = {
  WALLET_PROVIDER: 'fintava',
  FINTAVA_BASE_URL: 'https://dev.fintavapay.com',
  EARNINGS_SWEEP_START: SWEEP_START.toISOString(),
};
const MERCHANT = '1102038668';

describe('clear-communities money rules (OPS-CLEAR-ROOMS fix round 1)', () => {
  let prisma: PrismaService;
  let closeApp: () => Promise<void>;
  const host = randomUUID();
  const member = randomUUID();
  const tag = `ocm-${randomUUID().slice(0, 8)}`;
  const ids: Record<string, string> = {};
  const paymentIds: string[] = [];
  const storeProductIds: string[] = [];

  async function room(key: string) {
    const id = randomUUID();
    ids[key] = id;
    await prisma.community.create({
      data: {
        id,
        name: `${tag} ${key}`,
        description: 'FIXTURE: ops-clear-communities-money.contract.spec.ts',
        hostWawuId: host,
        kind: 'private',
      },
    });
    return id;
  }

  const paymentData = (provider: string, status = 'completed') => {
    const id = randomUUID();
    paymentIds.push(id);
    return {
      id,
      payerWawuUserId: member,
      payeeWawuUserId: host,
      kind: 'community_pass',
      targetId: id,
      title: 'A room pass',
      priceKobo: 100000n,
      providerFeeKobo: 0n,
      wawuFeeKobo: 0n,
      totalKobo: 100000n,
      payeeShareKobo: 85000n,
      wawuShareKobo: 15000n,
      customerReference: `ocm-${id}`,
      merchantAccountNumber: MERCHANT,
      provider,
      status,
    };
  };
  async function payment(provider: string, status = 'completed') {
    const data = paymentData(provider, status);
    await prisma.walletPayment.create({ data });
    return data.id;
  }

  const passData = (communityId: string, walletPaymentId: string) => ({
    communityId,
    userWawuId: member,
    walletPaymentId,
    startsAt: new Date(Date.now() - 86400000),
    endsAt: new Date(Date.now() + 20 * 86400000),
    priceKobo: 100000n,
  });

  async function storePurchase(
    environment: string,
    communityId: string | null,
    kind: 'pass' | 'credits',
  ) {
    const product = await prisma.storeProduct.create({
      data: {
        platform: 'android',
        storeProductId: `${tag}-${randomUUID().slice(0, 6)}`,
        kind,
        title: 'FIXTURE',
        grants: {},
      },
    });
    storeProductIds.push(product.id);
    return prisma.storePurchase.create({
      data: {
        wawuUserId: member,
        platform: 'android',
        storeTransactionId: `ocm-${randomUUID()}`,
        productId: product.id,
        storeProductId: product.storeProductId,
        kind,
        environment,
        communityId,
        grant: {},
        storeFeeBps: 3000,
        purchasedAt: new Date(),
      },
    });
  }

  type Source =
    { wallet: string } | { store: string } | 'flutterwave' | 'missing';
  /** Credits spent in a room from the given source; the host's earning, and its settlement as asked. */
  async function spend(
    communityId: string,
    source: Source,
    over: {
      settlement?: 'landed' | 'owed' | 'none';
      moveStatus?: string;
      earnedAt?: Date;
    } = {},
  ) {
    const purchaseId = randomUUID();
    await prisma.creditPurchase.create({
      data: {
        id: purchaseId,
        userWawuId: member,
        pack: 'starter',
        creditsGranted: 50,
        flutterwaveTxRef: `ocm-${purchaseId}`,
        amount: 500,
        status: 'completed',
        walletPaymentId:
          typeof source === 'object' && 'wallet' in source
            ? source.wallet
            : null,
        storePurchaseId:
          typeof source === 'object' && 'store' in source ? source.store : null,
      },
    });
    const lot = await prisma.creditLot.create({
      data: {
        creditPurchaseId: purchaseId,
        userWawuId: member,
        creditsGranted: 50,
        creditsRemaining: 49,
        grossKobo: 50000,
        allocatedKobo: 1000,
      },
    });
    const sp = await prisma.creditSpend.create({
      data: {
        userWawuId: member,
        communityId,
        creditsSpent: 1,
        creatorWawuId: host,
      },
    });
    const earning = await prisma.creditSpendEarning.create({
      data: {
        creditSpendId: sp.id,
        creatorWawuId: host,
        communityId,
        creditsSpent: 1,
        creditsFunded: 1,
        grossKobo: 1000,
        hostShareKobo: 850,
        platformShareKobo: 150,
        lotIds: source === 'missing' ? [randomUUID()] : [lot.id],
        earnedAt: over.earnedAt ?? new Date(),
      },
    });
    const kind = over.settlement ?? 'landed';
    if (kind !== 'none') {
      let moveId: string | null = null;
      if (over.moveStatus) {
        const move = await prisma.earningMove.create({
          data: {
            payeeWawuUserId: host,
            dayKey: `2026-07-${String(10 + Math.floor(Math.random() * 18))}-${randomUUID().slice(0, 4)}`,
            merchantAccountNumber: MERCHANT,
            amountKobo: 850n,
            earnings: 1,
            status: over.moveStatus,
            customerReference: `ocm-move-${randomUUID()}`,
            ...(over.moveStatus === 'landed'
              ? {
                  settledAt: new Date(),
                  sentAt: new Date(),
                  destinationAccountNumber: '8000000001',
                }
              : {}),
          },
        });
        moveId = move.id;
      }
      await prisma.earningSettlement.create({
        data: {
          creditSpendEarningId: earning.id,
          payeeWawuUserId: host,
          kind: 'community_credits',
          targetId: communityId,
          title: 'Credits',
          earnedAt: new Date(),
          amountKobo: 850n,
          merchantAccountNumber: MERCHANT,
          customerReference: `wawu-earn-cs-${earning.id}`,
          status: kind,
          moveId,
          settledAt: kind === 'landed' ? new Date() : null,
          sentAt: kind === 'landed' ? new Date() : null,
          destinationAccountNumber: kind === 'landed' ? '8000000001' : null,
        },
      });
    }
  }

  async function run(over: Partial<Options> = {}, hooks: Partial<Deps> = {}) {
    const lines: string[] = [];
    const code = await clearCommunities(
      {
        prisma,
        getEnv: (k) => SANDBOX_ENV[k],
        out: (l) => lines.push(l),
        onlyIds: Object.values(ids),
        ...hooks,
      },
      { apply: false, ...over },
    );
    return { code, text: lines.join('\n') };
  }
  const exists = (key: string) =>
    prisma.community.count({ where: { id: ids[key] } }).then((n) => n === 1);

  const KEPT = [
    'unsettledShare',
    'storePassProd',
    'storeCreditsProd',
    'lotMissing',
    'landedInOwedMove',
    'activeSubscription',
    'prodStorePurchaseNoPass',
    'bulkWithOneReal',
    'raceCommitted',
    'raceHeld',
  ];
  const CLEARED = [
    'shareBeforeStart',
    'storePassSandbox',
    'storeCreditsSandbox',
    'landedInLandedMove',
    'endedSubscription',
    'bulkAllTest',
    'raceControl',
  ];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    closeApp = () => app.close();
    prisma = moduleRef.get(PrismaService);

    // M1: a funded wallet-bought share the sweep has not made into an earning yet keeps the room; one earned before
    // the sweep's start is never taken by the sweep and does not.
    const wallet = await payment('fintava');
    await spend(
      await room('unsettledShare'),
      { wallet },
      { settlement: 'none' },
    );
    await spend(
      await room('shareBeforeStart'),
      { wallet: await payment('fintava') },
      { settlement: 'none', earnedAt: new Date('2026-05-01T00:00:00Z') },
    );
    // Store passes.
    const prodPass = await storePurchase('production', null, 'pass');
    const prodPassRoom = await room('storePassProd');
    await prisma.communityPass.create({
      data: passData(prodPassRoom, `store:${prodPass.id}`),
    });
    const sandboxPass = await storePurchase('sandbox', null, 'pass');
    const sandboxPassRoom = await room('storePassSandbox');
    await prisma.communityPass.create({
      data: passData(sandboxPassRoom, `store:${sandboxPass.id}`),
    });
    // Store-bought credits.
    const prodCredits = await storePurchase('production', null, 'credits');
    await spend(await room('storeCreditsProd'), { store: prodCredits.id });
    const sandboxCredits = await storePurchase('sandbox', null, 'credits');
    await spend(await room('storeCreditsSandbox'), {
      store: sandboxCredits.id,
    });
    // A lot that cannot be found.
    await spend(await room('lotMissing'), 'missing');
    // A landed settlement inside a move that has not landed, and inside one that has.
    await spend(
      await room('landedInOwedMove'),
      { wallet: await payment('fintava') },
      { moveStatus: 'owed' },
    );
    await spend(
      await room('landedInLandedMove'),
      { wallet: await payment('fintava') },
      { moveStatus: 'landed' },
    );
    // Subscriptions.
    const subRoom = await room('activeSubscription');
    await prisma.storeSubscription.create({
      data: {
        platform: 'android',
        subscriptionKey: `${tag}-active`,
        wawuUserId: member,
        communityId: subRoom,
      },
    });
    await prisma.storeSubscription.create({
      data: {
        platform: 'android',
        subscriptionKey: `${tag}-ended`,
        wawuUserId: member,
        communityId: await room('endedSubscription'),
        lapsedAt: new Date(),
      },
    });
    // A production store purchase for the room with no pass row.
    await storePurchase(
      'production',
      await room('prodStorePurchaseNoPass'),
      'pass',
    );
    // More than 100 rows: 130 test passes, and one pass at another provider (the control has the 130 only).
    for (const key of ['bulkWithOneReal', 'bulkAllTest']) {
      const id = await room(key);
      const payments = Array.from({ length: 130 }, () =>
        paymentData('fintava'),
      );
      await prisma.walletPayment.createMany({ data: payments });
      await prisma.communityPass.createMany({
        data: payments.map((p) => passData(id, p.id)),
      });
    }
    await pass(ids.bulkWithOneReal, await payment('nuvion'));
    // Races: the rooms are plain; the hooks add the pass during the apply.
    await room('raceCommitted');
    await room('raceHeld');
    await room('raceControl');
  });

  async function pass(communityId: string, walletPaymentId: string) {
    await prisma.communityPass.create({
      data: passData(communityId, walletPaymentId),
    });
  }

  afterAll(async () => {
    if (prisma) {
      const all = Object.values(ids);
      await prisma.earningSettlement.deleteMany({
        where: { payeeWawuUserId: host },
      });
      await prisma.earningMove.deleteMany({ where: { payeeWawuUserId: host } });
      await prisma.community.deleteMany({ where: { id: { in: all } } });
      await prisma.storeSubscription.deleteMany({
        where: { wawuUserId: member },
      });
      await prisma.creditLot.deleteMany({ where: { userWawuId: member } });
      await prisma.creditPurchase.deleteMany({ where: { userWawuId: member } });
      await prisma.storePurchase.deleteMany({ where: { wawuUserId: member } });
      await prisma.storeProduct.deleteMany({
        where: { id: { in: storeProductIds } },
      });
      await prisma.walletPayment.deleteMany({
        where: { id: { in: paymentIds } },
      });
    }
    if (closeApp) await closeApp();
  });

  it('the dry run keeps each room with a rule and clears each control', async () => {
    const { code, text } = await run();
    expect(code).toBe(0);
    const block = (key: string) => {
      const start = text.indexOf(`${tag} ${key} [`);
      expect(start).toBeGreaterThan(-1);
      return text.slice(start, text.indexOf('\n   ->', start) + 200);
    };
    for (const k of KEPT.filter((k) => !k.startsWith('race')))
      expect(block(k)).toContain('KEPT');
    for (const k of CLEARED) expect(block(k)).toContain('would clear');
    expect(text).toContain('no settlement yet');
    expect(text).toContain('lot missing');
    expect(text).toContain('active');
  });

  it('apply keeps the kept rooms, including one with a real row among 130 test ones, and clears the controls', async () => {
    const racing = [ids.raceCommitted, ids.raceHeld];
    const beforeRoom = async (id: string) => {
      if (id === ids.raceCommitted) {
        // A pass at another provider commits after the plan was made.
        await pass(id, await payment('nuvion'));
      }
      if (id === ids.raceHeld) {
        // A pass whose transaction is still open when the apply reaches the room; it commits shortly after.
        const walletPaymentId = await payment('nuvion');
        let opened!: () => void;
        const ready = new Promise<void>((r) => (opened = r));
        void prisma.$transaction(async (tx) => {
          await tx.communityPass.create({
            data: passData(id, walletPaymentId),
          });
          opened();
          await new Promise((r) => setTimeout(r, 700));
        });
        await ready;
      }
    };
    const lines = await run(
      { apply: true, confirm: phraseFor(CLEARED.length + racing.length) },
      { beforeRoom },
    ).catch((e: Error) => ({ code: -1, text: e.message }));
    // The plan lists the controls plus the two race rooms (they hold nothing at plan time): the phrase is their count.
    expect(lines.code).toBe(0);
    for (const k of KEPT) expect(await exists(k)).toBe(true);
    for (const k of CLEARED) expect(await exists(k)).toBe(false);
    expect(
      await prisma.communityPass.count({
        where: { communityId: { in: racing } },
      }),
    ).toBe(2);
    expect(lines.text).toContain('real money appeared');
  });
});
