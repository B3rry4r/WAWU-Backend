import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import {
  nuvionLiveReset,
  parseArgs,
  phraseFor,
  type Deps,
  type Options,
} from '../../../scripts/ops/nuvion-live-reset';
import {
  runUnowned,
  stayingRows as stayingRowsOf,
} from '../../../scripts/ops/nuvion-live-reset';
import { RETIRED_PROVIDER } from '../../../scripts/ops/nuvion-live-reset-kinds';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PointsService } from '../../points/points.service';

/**
 * NUV-LIVE: the reset command on made-up people, on the test database. No provider is called (the command has no
 * provider to call; a source check below keeps it so). The unit retired is the Nuvion test wallet of EVERY person who
 * has one; real money is never a Nuvion row and is never touched. Only an unfinished payout of a real store purchase
 * refuses a person (it holds the test merchant and destination accounts).
 */
const SANDBOX: Record<string, string> = {
  WALLET_PROVIDER: 'nuvion',
  NUVION_BASE_URL: 'https://api.nuvion.dev',
  NUVION_API_KEY: 'nv_test_sk_RESET00notarealkey000000',
  NUVION_WEBHOOK_SECRET: 'whsec_reset_0123456789',
  NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
};
const LIVE: Record<string, string> = {
  ...SANDBOX,
  NUVION_BASE_URL: 'https://api.nuvion.co',
};
const MERCHANT = '1102038668';

describe('nuvion-live-reset (NUV-LIVE)', () => {
  let prisma: PrismaService;
  let points: PointsService;
  let closeApp: () => Promise<void>;
  const people: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let seq = 0;

  const uid = () => {
    const id = randomUUID();
    people.push(id);
    return id;
  };
  const acct = () =>
    `9${String(Date.now()).slice(-6)}${String(++seq).padStart(3, '0')}`;

  async function run(
    opts: Partial<Options>,
    env: Record<string, string> = SANDBOX,
    extra: Partial<Deps> = {},
  ) {
    const lines: string[] = [];
    const code = await nuvionLiveReset(
      {
        prisma,
        points,
        getEnv: (k) => env[k],
        out: (l) => lines.push(l),
        onlyIds: [...people],
        ...extra,
      },
      { apply: false, ...opts },
    );
    return { code, text: lines.join('\n'), lines };
  }
  const phrase = (n: number) => phraseFor(n);

  /** A Flutterwave payout subaccount: a row the real-money list refuses on. */
  async function realRow(id: string) {
    await prisma.creatorWallet.create({
      data: {
        wawuUserId: id,
        accountReference: `${tag}-ref-${id}`,
        barterId: `${tag}-bar-${id}`,
      },
    });
  }

  let productId: string | undefined;
  /** A store earning of the given environment, owed to `payee`; and optionally its payout. */
  async function storeEarning(
    payee: string,
    environment: 'sandbox' | 'production',
    payout?: 'pending' | 'paid' | 'cancelled',
  ) {
    if (!productId) {
      const product = await prisma.storeProduct.create({
        data: {
          platform: 'android',
          storeProductId: `${tag}-sp`,
          kind: 'pass',
          title: 'FIXTURE',
          grants: {},
        },
      });
      productId = product.id;
    }
    const product = await prisma.storeProduct.findUniqueOrThrow({
      where: { id: productId },
    });
    const purchase = await prisma.storePurchase.create({
      data: {
        wawuUserId: uid(),
        platform: 'android',
        storeTransactionId: `${tag}-${randomUUID()}`,
        productId: product.id,
        storeProductId: product.storeProductId,
        kind: 'pass',
        environment,
        grant: {},
        storeFeeBps: 3000,
        purchasedAt: new Date(Date.now() - 30 * 86400000),
      },
    });
    const earning = await prisma.storeEarning.create({
      data: {
        storePurchaseId: purchase.id,
        payeeWawuUserId: payee,
        kind: 'pass',
        targetId: purchase.id,
        title: 'A pass',
        earnedAt: new Date(Date.now() - 30 * 86400000),
        listPriceKobo: 100000n,
        amountKobo: 70000n,
        availableAt: new Date(Date.now() - 20 * 86400000),
        provider: 'nuvion',
      },
    });
    const pay = payout
      ? await prisma.storeEarningPayout.create({
          data: {
            storeEarningId: earning.id,
            payeeWawuUserId: payee,
            provider: 'nuvion',
            grossKobo: 70000n,
            amountKobo: 70000n,
            merchantAccountNumber: MERCHANT,
            destinationAccountNumber: acct(),
            customerReference: `${tag}-sp-${randomUUID()}`,
            status: payout,
            settledAt: payout === 'paid' ? new Date() : null,
          },
        })
      : null;
    return { earning, payout: pay, purchase };
  }

  async function wallet(id: string, provider = 'nuvion') {
    const accountNumber = acct();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: `c-${randomUUID()}`,
        walletId: `w-${randomUUID()}`,
        accountNumber,
        provider,
      },
    });
    await prisma.fintavaWalletOpening.create({
      data: {
        wawuUserId: id,
        state: 'opened',
        bvnHash: `bvn-${randomUUID()}`,
        bvnVerifiedAt: new Date(),
        phone: `+23480${Date.now().toString().slice(-8)}${seq}`,
        provider,
      },
    });
    await prisma.nuvionEntity.create({
      data: { wawuUserId: id, entityId: `ent-${randomUUID()}` },
    });
    await prisma.nuvionOnboarding.create({
      data: { wawuUserId: id, entityId: `ent-${randomUUID()}` },
    });
    await prisma.walletIdentity.create({ data: { wawuUserId: id } });
    return accountNumber;
  }

  async function payment(
    payer: string,
    payee: string,
    status: string,
    over: Record<string, unknown> = {},
  ) {
    const id = randomUUID();
    await prisma.walletPayment.create({
      data: {
        id,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'tip',
        targetId: id,
        title: 'A tip',
        priceKobo: 100000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 100000n,
        payeeShareKobo: 85000n,
        wawuShareKobo: 15000n,
        customerReference: `${tag}-${id}`,
        merchantAccountNumber: MERCHANT,
        provider: 'nuvion',
        status,
        nextCheckAt: status === 'pending' ? new Date() : null,
        completedAt: status === 'completed' ? new Date() : null,
        openKey: status === 'pending' ? `${tag}-open-${id}` : null,
        ...over,
      },
    });
    return id;
  }
  async function hold(paymentId: string, payer: string, payee: string) {
    return prisma.walletHold.create({
      data: {
        paymentId,
        payerWawuUserId: payer,
        payeeWawuUserId: payee,
        kind: 'dm',
        targetId: paymentId,
        title: 'A held DM',
        releaseCondition: 'reply',
        amountKobo: 100000n,
        payeeShareKobo: 85000n,
        wawuShareKobo: 15000n,
        merchantAccountNumber: MERCHANT,
        provider: 'nuvion',
        heldAt: new Date(),
        nextAttemptAt: new Date(),
      },
    });
  }
  async function settlement(payee: string, paymentId: string, owed = true) {
    const move = await prisma.earningMove.create({
      data: {
        payeeWawuUserId: payee,
        dayKey: `${tag}-${seq++}`,
        provider: 'nuvion',
        merchantAccountNumber: MERCHANT,
        amountKobo: 85000n,
        earnings: 1,
        customerReference: `${tag}-mv-${randomUUID()}`,
      },
    });
    void owed;
    return prisma.earningSettlement.create({
      data: {
        paymentId,
        payeeWawuUserId: payee,
        kind: 'tip',
        targetId: paymentId,
        title: 'A tip',
        earnedAt: new Date(),
        amountKobo: 85000n,
        merchantAccountNumber: MERCHANT,
        provider: 'nuvion',
        customerReference: `wawu-earn-${paymentId}-1`,
        moveId: move.id,
      },
    });
  }
  async function ledger(id: string, accountNumber: string) {
    const e = await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: 'user',
        wawuUserId: id,
        accountNumber,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 5000n,
        totalKobo: 5000n,
        source: 'test',
        occurredAt: new Date(),
        provider: 'nuvion',
        nextCheckAt: new Date(),
      },
    });
    await prisma.moneyReceipt.create({
      data: {
        code: `${tag}-${randomUUID()}`,
        entryId: e.id,
        wawuUserId: id,
        accountNumber,
      },
    });
    return e;
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    points = new PointsService(prisma);
    closeApp = () => moduleRef.close();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EarningDeduction" WHERE "payeeWawuUserId" = ANY($1::text[])`,
      people,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "StoreEarningPayout" WHERE "payeeWawuUserId" = ANY($1::text[])`,
      people,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "StoreEarning" WHERE "payeeWawuUserId" = ANY($1::text[])`,
      people,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EarningSettlement" WHERE "payeeWawuUserId" = ANY($1::text[])`,
      people,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EarningMove" WHERE "payeeWawuUserId" = ANY($1::text[])`,
      people,
    );
    await closeApp();
  });

  it('refuses on live keys and without proof, and has no provider to call', async () => {
    expect((await run({}, LIVE)).code).toBe(1);
    const noEnv = await run({}, {});
    expect(noEnv.code).toBe(1);
    expect(noEnv.text).toContain('REFUSED');
    expect(
      (await run({}, { ...SANDBOX, WALLET_PROVIDER: 'fintava' })).code,
    ).toBe(1);
    const src = readFileSync(
      join(__dirname, '../../../scripts/ops/nuvion-live-reset.ts'),
      'utf8',
    );
    expect(src).not.toMatch(
      /from '\.\.\/\.\.\/src\/(nuvion|fintava)\/(?!nuvion-config)/,
    );
    expect(src).not.toMatch(/fetch\(|https?\.request|axios/);
    expect(src).not.toContain('—');
  });

  it('refuses a live-shaped key even on the sandbox host, and never prints the key', async () => {
    const key = 'nv_live_sk_NOTAREALKEY00000000000';
    const r = await run({}, { ...SANDBOX, NUVION_API_KEY: key });
    expect(r.code).toBe(1);
    expect(r.text).toContain('REFUSED');
    expect(r.text).toContain('nv_live_');
    expect(r.text).not.toContain(key);
    expect(r.text).toContain('Nothing was changed.');
    const quoted = await run({}, { ...SANDBOX, NUVION_API_KEY: `"${key}"` });
    expect(quoted.code).toBe(1);
    expect(quoted.text).not.toContain(key);
    const upper = await run(
      { apply: true, confirm: phrase(1) },
      { ...SANDBOX, NUVION_API_KEY: key.toUpperCase() },
    );
    expect(upper.code).toBe(1);
    // A test-shaped key on the sandbox host still runs.
    expect((await run({})).code).toBe(0);
  });

  it('parses its arguments and has no flag that waives a rule', () => {
    expect(parseArgs([])).toEqual({ apply: false, confirm: undefined });
    expect(typeof parseArgs(['--force'])).toBe('string');
    expect(typeof parseArgs(['--apply', '--confirm'])).toBe('string');
  });

  describe('one test-era person with a row of every kind', () => {
    const a = uid();
    const b = uid();
    const real = uid();
    let paymentPending: string;
    let paymentDone: string;
    let holdPaymentId: string;
    let accountA: string;
    let convId: string;

    beforeAll(async () => {
      accountA = await wallet(a);
      await wallet(b);
      await ledger(a, accountA);
      paymentPending = await payment(a, b, 'pending');
      holdPaymentId = await payment(a, b, 'completed');
      await hold(holdPaymentId, a, b);
      paymentDone = await payment(b, a, 'completed', {
        fulfilledAt: null,
      });
      await settlement(
        a,
        await payment(b, a, 'completed', { fulfilledAt: new Date() }),
      );
      await prisma.walletTransfer.create({
        data: {
          payerWawuUserId: a,
          recipientWawuUserId: b,
          amountKobo: 1000n,
          providerFeeKobo: 0n,
          wawuFeeKobo: 0n,
          totalKobo: 1000n,
          feeTransferDue: true,
          customerReference: `${tag}-tr-${randomUUID()}`,
          provider: 'nuvion',
          status: 'pending',
          nextCheckAt: new Date(),
        },
      });
      await prisma.addMoneySession.create({
        data: {
          wawuUserId: a,
          provider: 'nuvion',
          rail: 'card',
          amountKobo: 1000n,
          chargeKobo: 1000n,
          reference: `${tag}-am-${randomUUID()}`,
          status: 'awaiting_user',
        },
      });
      await prisma.walletCard.create({
        data: {
          wawuUserId: a,
          provider: 'nuvion',
          reference: `${tag}-card`,
          type: 'virtual',
          name: 'A card',
          state: 'active',
        },
      });
      await prisma.communityPassRefund.create({
        data: {
          communityId: randomUUID(),
          userWawuId: a,
          hostWawuId: b,
          removedAt: new Date(),
          unusedDays: 3,
          amountKobo: 1000n,
          hostShareKobo: 850n,
          merchantAccountNumber: MERCHANT,
          provider: 'nuvion',
          customerReference: `${tag}-pr-${randomUUID()}`,
        },
      });
      await prisma.moneyPayoutAccount.upsert({
        where: { wawuUserId: a },
        create: {
          wawuUserId: a,
          bankCode: '058',
          bankName: 'A bank',
          accountNumber: '0123456789',
          accountName: 'Test Person',
          nuvionCounterpartyId: 'cp_test_1',
          nuvionPaymentDetailId: 'pd_test_1',
          nuvionCheckedAt: new Date(),
        } as never,
        update: {},
      });
      await prisma.capitalOrder.create({
        data: {
          wawuUserId: a,
          reserveKey: `${tag}-cap`,
          fingerprint: 'fp',
          state: 'reserved',
          provider: 'nuvion',
          nuvionOrderId: `ord-${randomUUID()}`,
          productId: 'p',
          productName: 'P',
          productType: 'T',
          currency: 'USD',
          amountMinor: 1000n,
          feeKobo: 500n,
          feeState: 'owed',
        },
      });
      // A held cash-out with its points hold.
      await points.grant({
        wawuUserId: a,
        source: 'referral',
        sourceRef: `${tag}-grant`,
        points: 5000,
        expiresAt: new Date(Date.now() + 86400000 * 30),
      });
      convId = randomUUID();
      await points.hold({
        wawuUserId: a,
        purpose: 'cash_out',
        reference: convId,
        points: 1000,
      });
      await prisma.pointConversion.create({
        data: {
          id: convId,
          wawuUserId: a,
          points: 1000,
          cashKobo: 1000n,
          per1000PointsKobo: 1000n,
          merchantAccountNumber: MERCHANT,
          provider: 'nuvion',
          customerReference: `wawu-pts-${convId}`,
        },
      });
      // A person with real money (a Flutterwave payout subaccount and a credit balance) is retired all the same.
      await wallet(real);
      await realRow(real);
      await prisma.creditsState.create({
        data: { userWawuId: real, creditBalance: 12 },
      });
    });

    afterAll(async () => {
      await prisma.$executeRawUnsafe(
        `DELETE FROM "CreatorWallet" WHERE "wawuUserId" = $1`,
        real,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM "CreditsState" WHERE "userWawuId" = $1`,
        real,
      );
    });

    it('dry run writes nothing, prints ids only, and names the phrase', async () => {
      const before = await prisma.fintavaWallet.count({
        where: { wawuUserId: { in: people } },
      });
      const r = await run({});
      expect(r.code).toBe(0);
      expect(r.text).toContain('DRY RUN');
      expect(r.text).toContain(`Person ${a}`);
      expect(r.text).toMatch(
        /Confirmation phrase: RETIRE \d+ NUVION TEST WALLETS/,
      );
      expect(r.text).not.toMatch(/Test Person|0123456789|\+234/);
      expect(r.text).not.toContain('—');
      expect(
        await prisma.fintavaWallet.count({
          where: { wawuUserId: { in: people } },
        }),
      ).toBe(before);
      expect(
        await prisma.walletPayment.count({
          where: { id: paymentPending, status: 'pending' },
        }),
      ).toBe(1);
    });

    it('refuses without the phrase, or with a wrong one', async () => {
      const dry = await run({});
      const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
      expect((await run({ apply: true })).code).toBe(1);
      expect((await run({ apply: true, confirm: phrase(n + 1) })).code).toBe(1);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: a } }),
      ).toBe(1);
    });

    it('apply retires exactly the listed people; a second run finds nothing', async () => {
      const dry = await run({});
      const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
      expect(dry.text).toContain(`Person ${real}:`);
      expect(dry.text).not.toMatch(/KEPT/);
      const res = await run({ apply: true, confirm: phrase(n) });
      expect(res.text).toContain(`Retired ${a}`);
      expect(res.code).toBe(0);

      // Nobody sees a wallet; the BVN and phone are free; no Nuvion entity.
      for (const t of [a, b]) {
        expect(
          await prisma.fintavaWallet.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.fintavaWalletOpening.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.nuvionEntity.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.walletIdentity.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.fintavaLedgerEntry.count({ where: { wawuUserId: t } }),
        ).toBe(0);
        expect(
          await prisma.earningSettlement.count({
            where: { payeeWawuUserId: t },
          }),
        ).toBe(0);
        expect(
          await prisma.earningMove.count({ where: { payeeWawuUserId: t } }),
        ).toBe(0);
      }
      // In motion: closed, relabelled, nothing left on provider nuvion that is open.
      const p = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: paymentPending },
      });
      expect(p.status).toBe('failed');
      expect(p.provider).toBe(RETIRED_PROVIDER);
      expect(p.openKey).toBeNull();
      expect(p.nextCheckAt).toBeNull();
      const unfulfilled = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: paymentDone },
      });
      expect(unfulfilled.fulfilledAt).not.toBeNull();
      const h = await prisma.walletHold.findUniqueOrThrow({
        where: { paymentId: holdPaymentId },
      });
      expect(h.status).toBe('refunded');
      expect(h.provider).toBe(RETIRED_PROVIDER);
      expect(h.nextAttemptAt).toBeNull();
      const t = await prisma.walletTransfer.findFirstOrThrow({
        where: { payerWawuUserId: a },
      });
      expect([t.status, t.provider, t.feeTransferDue]).toEqual([
        'failed',
        RETIRED_PROVIDER,
        false,
      ]);
      expect(
        (
          await prisma.addMoneySession.findFirstOrThrow({
            where: { wawuUserId: a },
          })
        ).status,
      ).toBe('cancelled');
      expect(
        (await prisma.walletCard.findFirstOrThrow({ where: { wawuUserId: a } }))
          .state,
      ).toBe('cancelled');
      expect(
        (
          await prisma.communityPassRefund.findFirstOrThrow({
            where: { userWawuId: a },
          })
        ).status,
      ).toBe('refunded');
      const cap = await prisma.capitalOrder.findFirstOrThrow({
        where: { wawuUserId: a },
      });
      expect([
        cap.state,
        cap.feeState,
        cap.nuvionOrderId,
        cap.provider,
      ]).toEqual(['cancelled', 'none', null, RETIRED_PROVIDER]);
      const pa = await prisma.moneyPayoutAccount.findUniqueOrThrow({
        where: { wawuUserId: a },
      });
      expect(pa.nuvionCounterpartyId).toBeNull();
      expect(pa.accountNumber).toBe('0123456789');
      // Points: the conversion is cancelled and the points are back.
      expect(
        (
          await prisma.pointConversion.findUniqueOrThrow({
            where: { id: convId },
          })
        ).status,
      ).toBe('cancelled');
      const lots = await prisma.pointLot.findMany({ where: { wawuUserId: a } });
      expect(lots.reduce((s, l) => s + l.remaining, 0)).toBe(5000);

      // The person with real money was retired too: no test wallet, and the real money untouched.
      expect(res.text).toContain(`Retired ${real}`);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: real } }),
      ).toBe(0);
      expect(
        await prisma.nuvionEntity.count({ where: { wawuUserId: real } }),
      ).toBe(0);
      expect(
        await prisma.creatorWallet.count({ where: { wawuUserId: real } }),
      ).toBe(1);
      expect(
        (
          await prisma.creditsState.findUniqueOrThrow({
            where: { userWawuId: real },
          })
        ).creditBalance,
      ).toBe(12);
      // Nobody keeps a Nuvion test id the live server could read.
      const left = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT (SELECT count(*) FROM "FintavaWallet" WHERE "provider" = 'nuvion' AND "wawuUserId" = ANY($1::text[]))::int
              + (SELECT count(*) FROM "NuvionEntity" WHERE "wawuUserId" = ANY($1::text[]))::int AS n`,
        people,
      );
      expect(left[0].n).toBe(0);
      const keptNow = await run({});
      expect(keptNow.text).toContain('Nothing to retire.');
    });
  });

  describe('real money is never touched, and never a reason to keep a test wallet', () => {
    const flutter = uid();
    const partner = uid();
    let motion: string;

    beforeAll(async () => {
      await wallet(flutter);
      await wallet(partner);
      await realRow(flutter);
      await prisma.creditsState.create({
        data: { userWawuId: flutter, creditBalance: 40 },
      });
      // A Flutterwave charge waiting, and a payment in motion with another person.
      await prisma.pendingCharge.create({
        data: {
          wawuUserId: flutter,
          txRef: `${tag}-tx-${randomUUID()}`,
          kind: 'dm',
          expectedAmount: 1000,
          context: {},
        } as never,
      });
      motion = await payment(partner, flutter, 'pending');
    });

    afterAll(async () => {
      for (const t of ['CreatorWallet', 'PendingCharge']) {
        await prisma.$executeRawUnsafe(
          `DELETE FROM "${t}" WHERE "wawuUserId" = $1`,
          flutter,
        );
      }
      await prisma.$executeRawUnsafe(
        `DELETE FROM "CreditsState" WHERE "userWawuId" = $1`,
        flutter,
      );
    });

    it('retires both people, closes the payment between them, leaves the real rows alone', async () => {
      const dry = await run({});
      expect(dry.text).not.toContain('REFUSED');
      expect(dry.text).not.toContain('KEPT');
      expect(dry.text).toContain(`Person ${flutter}:`);
      const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
      const res = await run({ apply: true, confirm: phrase(n) });
      expect(res.code).toBe(0);
      expect(res.text).not.toContain('WARNING');
      expect(
        await prisma.fintavaWallet.count({
          where: { wawuUserId: { in: [flutter, partner] } },
        }),
      ).toBe(0);
      const p = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: motion },
      });
      expect([p.status, p.provider]).toEqual(['failed', RETIRED_PROVIDER]);
      // Real money: untouched.
      expect(
        await prisma.creatorWallet.count({ where: { wawuUserId: flutter } }),
      ).toBe(1);
      expect(
        await prisma.pendingCharge.count({ where: { wawuUserId: flutter } }),
      ).toBe(1);
      expect(
        (
          await prisma.creditsState.findUniqueOrThrow({
            where: { userWawuId: flutter },
          })
        ).creditBalance,
      ).toBe(40);
    });
  });

  describe('a Nuvion row that is not provably test money (real store money)', () => {
    const owedOnly = uid();
    const sandbox = uid();
    const finalPayouts = uid();
    const blocked = uid();
    const control = uid();
    let blockedPayout: string;
    let blockedEarning: string;
    let owedEarning: string;
    let sandboxEarning: string;
    let realDebt: string;
    let testDebt: string;
    let sandboxPayout: string;

    beforeAll(async () => {
      for (const id of [owedOnly, sandbox, finalPayouts, blocked, control])
        await wallet(id);
      owedEarning = (await storeEarning(owedOnly, 'production')).earning.id;
      const sb = await storeEarning(sandbox, 'sandbox', 'pending');
      sandboxEarning = sb.earning.id;
      sandboxPayout = sb.payout!.id;
      await storeEarning(finalPayouts, 'production', 'paid');
      await storeEarning(finalPayouts, 'production', 'cancelled');
      const b = await storeEarning(blocked, 'production', 'pending');
      blockedPayout = b.payout!.id;
      blockedEarning = b.earning.id;
      // A debt from a refund of a real purchase, and one from a community pass refund.
      const refundedPurchase = await storeEarning(owedOnly, 'production');
      realDebt = (
        await prisma.earningDeduction.create({
          data: {
            payeeWawuUserId: owedOnly,
            storePurchaseId: refundedPurchase.purchase.id,
            amountKobo: 1000n,
            provider: 'nuvion',
          },
        })
      ).id;
      const refund = await prisma.communityPassRefund.create({
        data: {
          communityId: randomUUID(),
          userWawuId: control,
          hostWawuId: owedOnly,
          removedAt: new Date(),
          unusedDays: 3,
          amountKobo: 1000n,
          hostShareKobo: 850n,
          merchantAccountNumber: MERCHANT,
          provider: 'nuvion',
          customerReference: `${tag}-dpr-${randomUUID()}`,
        },
      });
      testDebt = (
        await prisma.earningDeduction.create({
          data: {
            payeeWawuUserId: owedOnly,
            passRefundId: refund.id,
            amountKobo: 850n,
            provider: 'nuvion',
          },
        })
      ).id;
    });

    it('the dry run lists the rows that stay, and names the one row that refuses its person', async () => {
      const dry = await run({});
      expect(dry.code).toBe(0);
      expect(dry.text).toContain(`StoreEarning ${owedEarning} of ${owedOnly}`);
      expect(dry.text).toContain(`EarningDeduction ${realDebt}`);
      expect(dry.text).not.toContain(`EarningDeduction ${testDebt}`);
      expect(dry.text).toContain(
        `REFUSES StoreEarningPayout ${blockedPayout} of ${blocked}`,
      );
      expect(dry.text).toContain(`REFUSED ${blocked}:`);
      // The owed earning alone does not refuse, and neither does a final payout, nor a sandbox one.
      for (const ok of [owedOnly, sandbox, finalPayouts, control])
        expect(dry.text).not.toContain(`REFUSED ${ok}:`);
      expect(dry.text).not.toMatch(/Test Person|0123456789|\+234/);
      expect(dry.text).not.toContain('—');
    });

    it('apply retires everyone else, leaves the real rows and the refused person alone, and ends not finished', async () => {
      const dry = await run({});
      const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
      const res = await run({ apply: true, confirm: phrase(n) });
      expect(res.code).toBe(2);
      expect(res.text).toContain('NOT FINISHED');
      // Retired: no test wallet.
      expect(
        await prisma.fintavaWallet.count({
          where: {
            wawuUserId: { in: [owedOnly, sandbox, finalPayouts, control] },
          },
        }),
      ).toBe(0);
      // The real earning stays owed on provider nuvion, with no id on it, and lands on a live wallet.
      const real = await prisma.storeEarning.findUniqueOrThrow({
        where: { id: owedEarning },
      });
      expect([real.status, real.provider]).toEqual(['owed', 'nuvion']);
      // The real debt stays; the test debt is relabelled.
      expect(
        (
          await prisma.earningDeduction.findUniqueOrThrow({
            where: { id: realDebt },
          })
        ).provider,
      ).toBe('nuvion');
      expect(
        (
          await prisma.earningDeduction.findUniqueOrThrow({
            where: { id: testDebt },
          })
        ).provider,
      ).toBe(RETIRED_PROVIDER);
      // The sandbox earning and its payout are cancelled and relabelled.
      expect(
        (
          await prisma.storeEarning.findUniqueOrThrow({
            where: { id: sandboxEarning },
          })
        ).status,
      ).toBe('cancelled');
      expect(
        (
          await prisma.storeEarningPayout.findUniqueOrThrow({
            where: { id: sandboxPayout },
          })
        ).provider,
      ).toBe(RETIRED_PROVIDER);
      // The refused person: nothing touched, the payout row is as it was.
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: blocked } }),
      ).toBe(1);
      expect(
        await prisma.nuvionEntity.count({ where: { wawuUserId: blocked } }),
      ).toBe(1);
      const stuck = await prisma.storeEarningPayout.findUniqueOrThrow({
        where: { id: blockedPayout },
      });
      expect([
        stuck.status,
        stuck.provider,
        stuck.merchantAccountNumber,
      ]).toEqual(['pending', 'nuvion', MERCHANT]);
      // The dry run still names the row. The owner settles it (here: cancels it, as an owner's call), and the next run retires the person.
      expect((await run({})).text).toContain(
        `REFUSES StoreEarningPayout ${blockedPayout}`,
      );
      await prisma.storeEarningPayout.update({
        where: { id: blockedPayout },
        data: { status: 'cancelled' },
      });
      const again = await run({});
      const m = Number(/RETIRE (\d+) /.exec(again.text)![1]);
      expect(m).toBe(1);
      const done = await run({ apply: true, confirm: phrase(m) });
      expect(done.code).toBe(0);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: blocked } }),
      ).toBe(0);
      void blockedEarning;
      // Nothing is left to retire for anyone.
      expect((await run({})).text).toContain('Nothing to retire.');
    });

    it('a payout of a real purchase that appears after the plan refuses its person inside the transaction', async () => {
      const late = uid();
      await wallet(late);
      const e = await storeEarning(late, 'production');
      const dry = await run({});
      const n = Number(/RETIRE (\d+) /.exec(dry.text)![1]);
      const res = await run({ apply: true, confirm: phrase(n) }, SANDBOX, {
        beforePerson: async (id) => {
          if (id !== late) return;
          await prisma.storeEarningPayout.create({
            data: {
              storeEarningId: e.earning.id,
              payeeWawuUserId: late,
              provider: 'nuvion',
              grossKobo: 70000n,
              amountKobo: 70000n,
              merchantAccountNumber: MERCHANT,
              destinationAccountNumber: acct(),
              customerReference: `${tag}-late-${randomUUID()}`,
            },
          });
        },
      });
      expect(res.text).toContain(`Refused ${late}:`);
      expect(res.code).toBe(2);
      expect(
        await prisma.fintavaWallet.count({ where: { wawuUserId: late } }),
      ).toBe(1);
    });

    it('only an unfinished payout of a real store purchase can refuse a person', async () => {
      const src = readFileSync(
        join(__dirname, '../../../scripts/ops/nuvion-live-reset.ts'),
        'utf8',
      );
      expect(src.match(/refuses: true/g)).toHaveLength(1);
      expect(src.match(/refuses: false/g)).toHaveLength(2);
      // Every other kind of Nuvion row, for one person at once, refuses nobody: person `a` of the first describe held a row
      // of every kind, and was retired with exit 0 (see above). A fresh person with one row of each real-money kind:
      const who = uid();
      await wallet(who);
      await storeEarning(who, 'production');
      await storeEarning(who, 'production', 'paid');
      const rows = await prisma.$transaction((tx) =>
        stayingRowsOf(tx as never, [who]),
      );
      expect(rows.filter((r) => r.refuses)).toEqual([]);
      expect([...new Set(rows.map((r) => r.table))]).toEqual(['StoreEarning']);
    });
  });

  it("retires the unowned rows (WAWU's own test account, logs) and leaves a kept person's alone, then rolls back", async () => {
    const keptPerson = randomUUID();
    class Rollback extends Error {}
    const night = '2020-01-01';
    let seen: Record<string, unknown> = {};
    await prisma
      .$transaction(async (tx) => {
        await tx.moneyCheckRun.create({
          data: {
            provider: 'nuvion',
            night,
            startedAt: new Date(),
            leaseUntil: new Date(Date.now() + 600000),
          },
        });
        await tx.nuvionReconcileFinding.create({
          data: { kind: 'k', subject: `${tag}-s`, detail: 'd' },
        });
        const ev = await tx.nuvionWebhookEvent.create({
          data: {
            eventId: `${tag}-ev`,
            event: 'x',
            signedAt: 's',
            bodySha256: `${tag}-sha`,
            rawBody: Buffer.from('{}'),
            payload: {},
          },
        });
        const merchant = await tx.fintavaLedgerEntry.create({
          data: {
            walletKind: 'merchant',
            accountNumber: MERCHANT,
            direction: 'in',
            status: 'pending',
            category: 'purchase',
            amountKobo: 1n,
            totalKobo: 1n,
            source: 'test',
            occurredAt: new Date(),
            provider: 'nuvion',
            nextCheckAt: new Date(),
          },
        });
        const school = await tx.school.create({
          data: {
            name: `Reset ${tag}`,
            category: 'tech',
            location: 'Yaba, Lagos',
            about: 'A school.',
            reportEmail: `office-${tag}@school.test`,
          },
        });
        await tx.schoolPayee.create({
          data: {
            schoolId: school.id,
            bankCode: '058',
            bankName: 'A bank',
            accountNumber: '0123456789',
            accountName: 'A SCHOOL LTD',
            verifiedAt: new Date(),
            counterpartyId: 'cp_TESTSYSTEM',
            paymentDetailId: 'pd_TESTSYSTEM',
          },
        });
        const orphanPay = await payment(
          null as never,
          null as never,
          'pending',
        );
        const keptPay = await payment(keptPerson, null as never, 'pending');
        await runUnowned(tx, [keptPerson]);
        seen = {
          run: (await tx.moneyCheckRun.findFirstOrThrow({ where: { night } }))
            .provider,
          finding:
            (
              await tx.nuvionReconcileFinding.findFirstOrThrow({
                where: { subject: `${tag}-s` },
              })
            ).resolvedAt !== null,
          event: (
            await tx.nuvionWebhookEvent.findUniqueOrThrow({
              where: { id: ev.id },
            })
          ).processingStatus,
          merchant: (
            await tx.fintavaLedgerEntry.findUniqueOrThrow({
              where: { id: merchant.id },
            })
          ).provider,
          payee: await tx.schoolPayee.findUniqueOrThrow({
            where: { schoolId: school.id },
          }),
          orphanPay: (
            await tx.walletPayment.findUniqueOrThrow({
              where: { id: orphanPay },
            })
          ).status,
          keptPay: (
            await tx.walletPayment.findUniqueOrThrow({ where: { id: keptPay } })
          ).status,
        };
        throw new Rollback();
      })
      .catch((e) => {
        if (!(e instanceof Rollback)) throw e;
      });
    const { payee, ...rest } = seen as Record<string, unknown> & {
      payee: Record<string, unknown>;
    };
    // Both test ids are gone; the bank, account and name are as they were.
    expect([payee.counterpartyId, payee.paymentDetailId]).toEqual([null, null]);
    expect([payee.bankCode, payee.accountNumber, payee.accountName]).toEqual([
      '058',
      '0123456789',
      'A SCHOOL LTD',
    ]);
    expect(rest).toEqual({
      run: RETIRED_PROVIDER,
      finding: true,
      event: 'processed',
      merchant: RETIRED_PROVIDER,
      orphanPay: 'failed',
      keptPay: 'pending',
    });
  });
});
