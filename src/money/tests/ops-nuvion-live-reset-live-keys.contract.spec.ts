import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { NuvionSeamStandIn } from '../../../test/payments/nuvion-seam-standin';
import {
  nuvionLiveReset,
  phraseFor,
} from '../../../scripts/ops/nuvion-live-reset';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PointsService } from '../../points/points.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { EarningSettlementService } from '../earnings/earning-settlement.service';
import { WalletHoldService } from '../holds/wallet-hold.service';
import { LedgerService } from '../ledger/ledger.service';
import { LedgerStatusService } from '../ledger/ledger-status.service';
import { MoneyCheckService } from '../check/money-check.service';
import { MoneyModule } from '../money.module';
import { WalletPaymentService } from '../payments/wallet-payment.service';
import { WalletTransferService } from '../transfers/wallet-transfer.service';
import { StorePayoutService } from '../../store/payout/store-payout.service';

/**
 * NUV-LIVE, after apply, on live keys (R-138 point 3): the Hub, run on a production-shaped config with the Nuvion
 * stand-in standing for LIVE Nuvion (it answers only for accounts it knows, and records every call), makes no call with
 * a test id and pays no test money, by any sweep, retry or hold action. A control row that was NOT retired shows the
 * recorder and the sweeps do act. Real money (a store purchase that is not a sandbox one) still lands.
 */
jest.setTimeout(120_000);
const SANDBOX: Record<string, string> = {
  WALLET_PROVIDER: 'nuvion',
  NUVION_BASE_URL: 'https://api.nuvion.dev',
  NUVION_API_KEY: 'nv_test_sk_RESET00notarealkey000000',
  NUVION_WEBHOOK_SECRET: 'whsec_reset_0123456789',
  NUVION_OPERATIONAL_ACCOUNT_ID: '01HXYZOPERATIONAL000000001',
};
const MERCHANT = '1102038668';

describe('after the reset, live keys pay no test money (NUV-LIVE)', () => {
  let prisma: PrismaService;
  let nuvion: NuvionSeamStandIn;
  let closeApp: () => Promise<void>;
  let earnings: EarningSettlementService;
  let payments: WalletPaymentService;
  let holds: WalletHoldService;
  let transfers: WalletTransferService;
  let ledgerStatus: LedgerStatusService;
  let storePayouts: StorePayoutService;
  let check: MoneyCheckService;
  const people: string[] = [];
  const tag = randomUUID().slice(0, 8);
  let seq = 0;
  const uid = () => {
    const id = randomUUID();
    people.push(id);
    return id;
  };
  const testIds: string[] = [];

  async function wallet(id: string, test: boolean) {
    seq += 1;
    const accountNumber = `87${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}`;
    const acc = nuvion.openAccount(500_000n, accountNumber);
    const customerId = `cust-${randomUUID()}`;
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId,
        walletId: acc.accountId,
        accountNumber,
        provider: 'nuvion',
      },
    });
    if (test) {
      await prisma.fintavaWalletOpening.create({
        data: {
          wawuUserId: id,
          state: 'opened',
          bvnHash: `bvn-${randomUUID()}`,
          bvnVerifiedAt: new Date(),
          phone: `+23481${Date.now().toString().slice(-7)}${seq}`,
          provider: 'nuvion',
        },
      });
      testIds.push(accountNumber, customerId, acc.accountId);
    }
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
        nextCheckAt: status === 'pending' ? new Date(Date.now() - 1000) : null,
        completedAt:
          status === 'completed' ? new Date(Date.now() - 3600_000) : null,
        ...over,
      },
    });
    return id;
  }

  beforeAll(async () => {
    nuvion = new NuvionSeamStandIn();
    nuvion.operational.availableKobo = 50_000_000n;
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        MoneyModule,
      ],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(nuvion)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    earnings = moduleRef.get(EarningSettlementService);
    payments = moduleRef.get(WalletPaymentService);
    holds = moduleRef.get(WalletHoldService);
    transfers = moduleRef.get(WalletTransferService);
    ledgerStatus = moduleRef.get(LedgerStatusService);
    storePayouts = new StorePayoutService(
      prisma,
      nuvion,
      moduleRef.get(LedgerService),
      { send: () => Promise.resolve(undefined) } as never,
    );
    check = moduleRef.get(MoneyCheckService);
    closeApp = () => moduleRef.close();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EarningSettlement" WHERE "payeeWawuUserId" = ANY($1::text[])`,
      people,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM "EarningMove" WHERE "payeeWawuUserId" = ANY($1::text[])`,
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
    await closeApp();
  });

  it('retires, then every sweep and retry makes no call with a test id and pays nothing', async () => {
    const t = uid();
    const u = uid();
    const control = uid();
    const controlPayee = uid();
    const realPayee = uid();
    const sandboxPayee = uid();
    const tAcc = await wallet(t, true);
    await wallet(u, true);
    await wallet(control, false);
    await wallet(controlPayee, false);

    // Test-era rows in motion, of every path that could pay.
    const pendingPay = await payment(t, u, 'pending');
    const heldPay = await payment(u, t, 'completed', {
      fulfilledAt: new Date(),
    });
    const hold = await prisma.walletHold.create({
      data: {
        paymentId: heldPay,
        payerWawuUserId: u,
        payeeWawuUserId: t,
        kind: 'dm',
        targetId: heldPay,
        title: 'A DM',
        releaseCondition: 'reply',
        amountKobo: 100000n,
        payeeShareKobo: 85000n,
        wawuShareKobo: 15000n,
        merchantAccountNumber: MERCHANT,
        provider: 'nuvion',
        heldAt: new Date(Date.now() - 86400000),
        action: 'release',
        actionAt: new Date(),
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
    const earnPay = await payment(u, t, 'completed', {
      fulfilledAt: new Date(),
    });
    const move = await prisma.earningMove.create({
      data: {
        payeeWawuUserId: t,
        dayKey: `${tag}-d`,
        provider: 'nuvion',
        merchantAccountNumber: MERCHANT,
        amountKobo: 85000n,
        earnings: 1,
        customerReference: `${tag}-mv`,
        nextAttemptAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.earningSettlement.create({
      data: {
        paymentId: earnPay,
        payeeWawuUserId: t,
        kind: 'tip',
        targetId: earnPay,
        title: 'A tip',
        earnedAt: new Date(Date.now() - 3600_000),
        amountKobo: 85000n,
        merchantAccountNumber: MERCHANT,
        provider: 'nuvion',
        customerReference: `wawu-earn-${earnPay}-1`,
        moveId: move.id,
      },
    });
    await prisma.walletTransfer.create({
      data: {
        payerWawuUserId: t,
        recipientWawuUserId: u,
        amountKobo: 1000n,
        providerFeeKobo: 0n,
        wawuFeeKobo: 0n,
        totalKobo: 1000n,
        feeTransferDue: true,
        customerReference: `${tag}-tr`,
        provider: 'nuvion',
        status: 'pending',
        nextCheckAt: new Date(Date.now() - 1000),
      },
    });
    await prisma.fintavaLedgerEntry.create({
      data: {
        walletKind: 'user',
        wawuUserId: t,
        accountNumber: tAcc,
        direction: 'out',
        status: 'pending',
        category: 'transfer',
        amountKobo: 5000n,
        totalKobo: 5000n,
        source: 'test',
        occurredAt: new Date(Date.now() - 3600_000),
        provider: 'nuvion',
        customerReference: `${tag}-led`,
        nextCheckAt: new Date(Date.now() - 1000),
      },
    });
    // A store SANDBOX earning waiting for a person with no wallet: test money of another kind.
    const product = await prisma.storeProduct.create({
      data: {
        platform: 'android',
        storeProductId: `${tag}-sp`,
        kind: 'pass',
        title: 'FIXTURE',
        grants: {},
      },
    });
    const purchase = (environment: string) =>
      prisma.storePurchase.create({
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
    const earning = async (payee: string, environment: string) => {
      const p = await purchase(environment);
      return prisma.storeEarning.create({
        data: {
          storePurchaseId: p.id,
          payeeWawuUserId: payee,
          kind: 'pass',
          targetId: p.id,
          title: 'A pass',
          earnedAt: new Date(Date.now() - 30 * 86400000),
          listPriceKobo: 100000n,
          amountKobo: 70000n,
          availableAt: new Date(Date.now() - 20 * 86400000),
          provider: 'nuvion',
        },
      });
    };
    const sandboxEarning = await earning(sandboxPayee, 'sandbox');
    const realEarning = await earning(realPayee, 'production');
    // The control: a payment of a person with a live-shaped wallet, NOT retired (it is not in the list).
    const controlPay = await payment(control, controlPayee, 'pending');

    // Apply.
    const only = [t, u, sandboxPayee];
    const lines: string[] = [];
    const deps = {
      prisma,
      points: new PointsService(prisma),
      getEnv: (k: string) => SANDBOX[k],
      out: (l: string) => lines.push(l),
      onlyIds: only,
    };
    await nuvionLiveReset(deps, { apply: false });
    const n = Number(/RETIRE (\d+) /.exec(lines.join('\n'))![1]);
    expect(n).toBe(3);
    const code = await nuvionLiveReset(deps, {
      apply: true,
      confirm: phraseFor(n),
    });
    if (code !== 0) throw new Error(lines.slice(-12).join('\n'));
    expect(code).toBe(0);

    // Live keys: every path that could pay.
    nuvion.calls.length = 0;
    const transfersBefore = nuvion.transfers.length;
    await earnings.sweep(new Date());
    await earnings.sweep(new Date(Date.now() + 86400000));
    await payments.sweep(new Date());
    await holds.sweep(new Date());
    await transfers.sweep(new Date());
    await ledgerStatus.sweep(new Date());
    await storePayouts.sweep(new Date());
    // The nightly check, run by hand: it asks Nuvion about the wallets that exist, and none is a test one.
    await check.runNight({ byHand: true, again: true }).catch(() => undefined);
    // Retries a person or an admin can ask for.
    await holds.release({ holdId: hold.id }, 'retry').catch(() => undefined);
    await holds.refund({ paymentId: heldPay }).catch(() => undefined);

    const text = (v: unknown) =>
      JSON.stringify(v, (_k, x: unknown) =>
        typeof x === 'bigint' ? x.toString() : x,
      );
    const seen = text(nuvion.calls);
    for (const id of testIds.slice(0, 6)) expect(seen).not.toContain(id);
    // Nothing was moved for anything of the test era.
    expect(
      nuvion.transfers
        .slice(transfersBefore)
        .filter((x) => text(x).includes(tAcc)),
    ).toEqual([]);
    expect(
      (
        await prisma.walletPayment.findUniqueOrThrow({
          where: { id: pendingPay },
        })
      ).status,
    ).toBe('failed');
    expect(
      (await prisma.walletHold.findUniqueOrThrow({ where: { id: hold.id } }))
        .status,
    ).toBe('released');
    expect(
      await prisma.earningSettlement.count({ where: { payeeWawuUserId: t } }),
    ).toBe(0);
    expect(
      await prisma.storeEarningPayout.count({
        where: { payeeWawuUserId: sandboxPayee },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.storeEarning.findUniqueOrThrow({
          where: { id: sandboxEarning.id },
        })
      ).status,
    ).toBe('cancelled');

    // The real store earning was never touched, and lands when its person has a live wallet.
    const real = await prisma.storeEarning.findUniqueOrThrow({
      where: { id: realEarning.id },
    });
    expect([real.status, real.provider]).toEqual(['owed', 'nuvion']);
    await wallet(realPayee, false);
    nuvion.mode = 'successful';
    await storePayouts.sweep(new Date());
    expect(
      await prisma.storeEarningPayout.count({
        where: { payeeWawuUserId: realPayee },
      }),
    ).toBe(1);

    // The control row was not retired, and the sweep does act on it (the recorder and the sweeps are live).
    expect(
      (
        await prisma.walletPayment.findUniqueOrThrow({
          where: { id: controlPay },
        })
      ).provider,
    ).toBe('nuvion');
    await payments.sweep(new Date());
    expect(nuvion.calls.length).toBeGreaterThan(0);
  });
});
