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
import { FintavaClient } from '../../fintava/fintava-client';
import { PointsService } from '../../points/points.service';
import { WALLET_PROVIDER } from '../../wallet-provider/wallet-provider.interface';
import { WalletBillService } from '../../wallet-bills/wallet-bill.service';
import { WalletBillsModule } from '../../wallet-bills/wallet-bills.module';
import { MoneyModule } from '../money.module';
import { WalletPaymentService } from '../payments/wallet-payment.service';

/**
 * NUV-LIVE finding 3: WalletBill (fintavaTransactionId, fintavaReference) has no provider column and is classed
 * "follows its payment" in the reset. This is the probe. A bill hung on a Nuvion test payment is set up two ways a
 * bill is looked at (a purchase whose answer was lost, delivered by the payment sweep; a failed purchase looked for by
 * the half-hourly late-success scan), once for a person who is retired and once for a control who is not. Fintava's
 * client is a recorder: after the reset it is asked nothing about the retired person's bills, and it IS asked about
 * the control's, so the recorder works. The bill rows themselves are left as they were (no id is cleared: nothing reads
 * them once the payment is final and relabelled).
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

describe('a bill hung on a retired Nuvion test payment is neither delivered nor looked for (NUV-LIVE)', () => {
  let prisma: PrismaService;
  let closeApp: () => Promise<void>;
  let bills: WalletBillService;
  let payments: WalletPaymentService;
  const asked: Array<{ method: string; args: unknown }> = [];
  const people: string[] = [];
  const tag = randomUUID().slice(0, 8);
  const prev: Record<string, string | undefined> = {};
  const uid = () => {
    const id = randomUUID();
    people.push(id);
    return id;
  };

  beforeAll(async () => {
    const env = {
      FEE_QUOTE_KEY: 'resetbills-fee-quote-key-0123456789abcdef',
      MERCHANT_MAX_PER_TXN_KOBO: '1000000000',
      NUVION_FEE_BOOK_TRANSFER: '0',
      NUVION_FEE_BANK_PAYOUT: '0',
      NUVION_FEE_INFLOW: '0',
      WALLET_PROVIDER: 'nuvion',
    };
    for (const [k, v] of Object.entries(env)) {
      prev[k] = process.env[k];
      process.env[k] = v;
    }
    // A recorder with exactly the methods the bill service calls, each recorded and refused.
    const recorder: Record<string, (args?: unknown) => Promise<never>> = {};
    for (const method of [
      'buyAirtime',
      'buyCable',
      'buyDataBundle',
      'buyElectricity',
      'getMerchantHistory',
      'getTransactionById',
      'listCablePlans',
      'listDataBundles',
    ]) {
      recorder[method] = (args) => {
        asked.push({ method, args });
        return Promise.reject(new Error('recorder: no Fintava here'));
      };
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        MoneyModule,
        WalletBillsModule,
      ],
    })
      .overrideProvider(WALLET_PROVIDER)
      .useValue(new NuvionSeamStandIn())
      .overrideProvider(FintavaClient)
      .useValue(recorder)
      .compile();
    await moduleRef.init();
    prisma = moduleRef.get(PrismaService);
    bills = moduleRef.get(WalletBillService);
    payments = moduleRef.get(WalletPaymentService);
    closeApp = () => moduleRef.close();
  });

  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "WalletBill" WHERE "wawuUserId" = ANY($1::text[])`,
      people,
    );
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await closeApp();
  });

  /** A person with a Nuvion wallet and two bills: one waiting for delivery, one failed with a purchase sent. */
  async function person() {
    const id = uid();
    await prisma.fintavaWallet.create({
      data: {
        wawuUserId: id,
        customerId: `c-${randomUUID()}`,
        walletId: `w-${randomUUID()}`,
        accountNumber: `95${String(Date.now()).slice(-6)}${people.length}`,
        provider: 'nuvion',
      },
    });
    const made: { owed: string; failed: string } = { owed: '', failed: '' };
    for (const state of ['owed', 'failed'] as const) {
      const billId = randomUUID();
      const payId = randomUUID();
      const sent = new Date(Date.now() - 20 * 60_000);
      await prisma.walletPayment.create({
        data: {
          id: payId,
          payerWawuUserId: id,
          payeeWawuUserId: null,
          kind: 'bill',
          targetId: billId,
          title: 'A bill',
          priceKobo: 50000n,
          providerFeeKobo: 0n,
          wawuFeeKobo: 0n,
          totalKobo: 50000n,
          payeeShareKobo: 0n,
          wawuShareKobo: 50000n,
          customerReference: `${tag}-${payId}`,
          merchantAccountNumber: MERCHANT,
          provider: 'nuvion',
          status: state === 'owed' ? 'completed' : 'failed',
          completedAt: new Date(Date.now() - 3600_000),
          fulfilledAt: null,
        },
      });
      await prisma.walletBill.create({
        data: {
          id: billId,
          wawuUserId: id,
          category: 'airtime',
          billerCode: 'MTN',
          title: 'MTN',
          amountKobo: 50000n,
          billChargeKobo: 50000n,
          serviceFeeKobo: 0n,
          reference: `WAW-BIL-${randomUUID().slice(0, 8)}`,
          paymentId: payId,
          status: state === 'owed' ? 'buying' : 'failed',
          purchaseSentAt: sent,
          failedAt: state === 'failed' ? new Date() : null,
          fintavaTransactionId: `ftx-${randomUUID()}`,
          fintavaReference: `fref-${randomUUID()}`,
        },
      });
      made[state] = billId;
    }
    return made;
  }

  it('after the reset Fintava is asked nothing about the retired person bills; before it, it is (the recorder works)', async () => {
    const retired = await person();
    await person();
    const controlUser = people[people.length - 1];
    const retiredUser = people[people.length - 2];

    // Control first: the same sweeps DO ask Fintava about a bill whose payment is of this server's provider.
    asked.length = 0;
    await payments
      .sweep(new Date(Date.now() + 5 * 60_000))
      .catch(() => undefined);
    await bills.scanLateSuccesses(new Date()).catch(() => undefined);
    expect(asked.length).toBeGreaterThan(0);

    // Retire only the first person.
    const lines: string[] = [];
    const deps = {
      prisma,
      points: new PointsService(prisma),
      getEnv: (k: string) => SANDBOX[k],
      out: (l: string) => lines.push(l),
      onlyIds: [retiredUser],
    };
    await nuvionLiveReset(deps, { apply: false });
    const n = Number(/RETIRE (\d+) /.exec(lines.join('\n'))![1]);
    expect(n).toBe(1);
    expect(
      await nuvionLiveReset(deps, { apply: true, confirm: phraseFor(n) }),
    ).toBe(0);

    // The retired person's bills hang on final, relabelled payments.
    for (const id of [retired.owed, retired.failed]) {
      const bill = await prisma.walletBill.findUniqueOrThrow({ where: { id } });
      const pay = await prisma.walletPayment.findUniqueOrThrow({
        where: { id: bill.paymentId! },
      });
      expect(pay.provider).toBe('nuvion_test');
      // A completed one is delivered-as-test; a failed one stays failed. Neither is of provider nuvion any more.
      if (id === retired.owed) expect(pay.fulfilledAt).not.toBeNull();
      else expect(pay.status).toBe('failed');
    }

    // Make the control's bills the only ones that could be asked about, and ask: the retired ones add nothing.
    await prisma.$executeRawUnsafe(
      `DELETE FROM "WalletBill" WHERE "wawuUserId" = $1`,
      controlUser,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "WalletPayment" SET "nextDeliveryAt" = NULL WHERE "payerWawuUserId" = $1`,
      retiredUser,
    );
    asked.length = 0;
    await payments
      .sweep(new Date(Date.now() + 5 * 60_000))
      .catch(() => undefined);
    await bills.scanLateSuccesses(new Date()).catch(() => undefined);
    await payments
      .sweep(new Date(Date.now() + 3 * 3_600_000))
      .catch(() => undefined);
    expect(asked).toEqual([]);
  });
});
