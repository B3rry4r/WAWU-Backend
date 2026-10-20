import { randomUUID } from 'node:crypto';
import {
  bootPayApp,
  type PayHarness,
  type PayPerson,
  STAND_IN_FEE_KOBO,
} from '../../../../test/payments/wallet-pay-harness';
import { body } from '../../../../test/payments/poll-helpers';
import { CreditWalletModule } from '../../../credit-purchase/wallet/credit-wallet.module';
import type {
  CreditWalletPurchaseView,
  CreditWalletQuoteView,
} from '../../../credit-purchase/wallet/credit-wallet-view.type';
import { CreditSpendModule } from '../../../credit-spend/credit-spend.module';
import { CreditSpendService } from '../../../credit-spend/credit-spend.service';
import { HOST_SHARE_KIND } from '../earning-rules';

/**
 * WALLET-17, community credits, on the wallet provider seam with NUVION stood
 * in: a host's share of the credits spent in their room (85%, R-5) becomes an
 * earning and lands in their wallet in the creator's ONE move of the day
 * (R-55), once, however many times the job runs. A host without a wallet keeps
 * it (R-11). After each, the ledger agrees with the stand-in, WAWU's operational
 * account included. No Nuvion, Fintava or wawuafrica.com host is called.
 */

jest.setTimeout(240_000);

const FEE = STAND_IN_FEE_KOBO;
const RICH = 50_000_000;
const DAY = 24 * 3_600_000;

describe('Hosts receive their share of spent credits (WALLET-17), Nuvion stood in', () => {
  let h: PayHarness;
  let spends: CreditSpendService;
  const hosts: string[] = [];

  beforeAll(async () => {
    h = await bootPayApp('w17c', {
      modules: [CreditWalletModule, CreditSpendModule],
      cleanup: async (prisma, users) => {
        await prisma.community.deleteMany({
          where: { hostWawuId: { in: users } },
        });
        await prisma.creditPurchase.deleteMany({
          where: { userWawuId: { in: users } },
        });
        await prisma.creditsState.deleteMany({
          where: { userWawuId: { in: users } },
        });
        await prisma.userProfile.deleteMany({
          where: { wawuUserId: { in: hosts } },
        });
      },
    });
    spends = h.app.get(CreditSpendService, { strict: false });
  });
  afterAll(async () => {
    await h.close();
  });
  beforeEach(() => {
    h.nuvion.mode = 'successful';
  });

  /** A creator hosting a room, with a wallet when `wallet` is true. */
  async function host(wallet = true) {
    const p = wallet ? await h.person(0) : h.walletless();
    await h.prisma.userProfile.create({
      data: {
        wawuUserId: p.id,
        accountType: 'creator',
        handle: `h${p.id.slice(0, 8)}`,
      },
    });
    hosts.push(p.id);
    const room = await h.prisma.community.create({
      data: {
        name: 'Night shoots',
        description: 'Lighting talk',
        hostWawuId: p.id,
        kind: 'open',
      },
    });
    return { p, room };
  }

  /** A member who bought a pack with the wallet: 120 credits for ₦1,000. */
  async function member(): Promise<PayPerson> {
    const m = await h.person(RICH);
    const quote = await h.get(m, '/credits/purchase/wallet/quote?pack=popular');
    expect(quote.status).toBe(200);
    const q = body<CreditWalletQuoteView>(quote).data!;
    const res = await h.post(m, '/credits/purchase/wallet', {
      pack: 'popular',
      expectedTotalKobo: q.payment.totalKobo,
      quoteToken: q.payment.quoteToken,
    });
    expect(res.status).toBe(201);
    expect(body<CreditWalletPurchaseView>(res).data!.status).toBe('paid');
    return m;
  }

  const spend = (
    m: PayPerson,
    hostId: string,
    communityId: string,
    credits = 12,
  ) =>
    spends.record({
      userWawuId: m.id,
      communityId,
      creatorWawuId: hostId,
      creditsSpent: credits,
    });
  const shareOf = async (hostId: string) =>
    (
      await h.prisma.creditSpendEarning.aggregate({
        where: { creatorWawuId: hostId },
        _sum: { hostShareKobo: true },
      })
    )._sum.hostShareKobo ?? 0;
  const settlements = (hostId: string) =>
    h.prisma.earningSettlement.findMany({
      where: { payeeWawuUserId: hostId, kind: HOST_SHARE_KIND },
      orderBy: { createdAt: 'asc' },
    });
  const paidTo = (p: PayPerson) =>
    h.nuvion
      .sendsFrom(h.nuvion.operational.accountId)
      .filter((t) => t.toAccountId === p.account!.accountId);
  const balance = (p: PayPerson) =>
    h.nuvion.accounts.get(p.account!.accountId)!.availableKobo;
  async function operationalAgrees(): Promise<void> {
    const rows = await h.prisma.fintavaLedgerEntry.findMany({
      where: {
        accountNumber: h.nuvion.operational.nuvionBan,
        status: 'completed',
        // This spec's own people only (FIX-91): every stand-in's WAWU account
        // has the same number, so rows an earlier spec of the same run left
        // on it are not money this stand-in ever held.
        counterpartyWawuUserId: { in: h.users },
      },
      select: { direction: true, amountKobo: true, totalKobo: true },
    });
    let held = 50_000_000n;
    for (const r of rows)
      held += r.direction === 'in' ? r.amountKobo : -r.totalKobo;
    expect(h.nuvion.operational.availableKobo).toBe(held);
  }

  it("members spend credits and the host's wallet grows by their share, in one move, once", async () => {
    const m = await member();
    const { p: hp, room } = await host();
    await spend(m, hp.id, room.id);
    await spend(m, hp.id, room.id);
    await spend(m, hp.id, room.id);
    const owed = await shareOf(hp.id);
    // 36 credits of a ₦1,000 pack for 120: about ₦300 collected, 85% of it theirs.
    expect(owed).toBeGreaterThan(20_000);
    const op0 = h.nuvion.operational.availableKobo;

    await h.pass();
    const rows = await settlements(hp.id);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.status === 'landed')).toBe(true);
    expect(new Set(rows.map((r) => r.moveId)).size).toBe(1);
    expect(rows.reduce((a, r) => a + r.amountKobo, 0n)).toBe(BigInt(owed));
    expect(balance(hp)).toBe(BigInt(owed));
    expect(paidTo(hp)).toHaveLength(1);
    expect(paidTo(hp)[0].request.amount).toBe(owed);
    // WAWU carries the charge on the move (R-31), once for the three.
    expect(op0 - h.nuvion.operational.availableKobo).toBe(
      BigInt(owed) + BigInt(FEE),
    );

    // The job running again, and twice at once, pays nothing more.
    await h.pass();
    await Promise.all([h.earnings.sweep(), h.earnings.sweep()]);
    await h.pass();
    expect(paidTo(hp)).toHaveLength(1);
    expect(await settlements(hp.id)).toHaveLength(3);
    expect(balance(hp)).toBe(BigInt(owed));
    await h.expectLedgerEqualsStandIn([m, hp]);
    await operationalAgrees();
  });

  it("a creator gets one move a day: a later spend waits for tomorrow's, and lands once then", async () => {
    // The sweeps' Lagos day must not turn over between the two passes below.
    h.keepInLagosDay();
    const m = await member();
    const { p: hp, room } = await host();
    for (let i = 0; i < 3; i += 1) await spend(m, hp.id, room.id);
    const first = await shareOf(hp.id);
    await h.pass();
    expect(paidTo(hp)).toHaveLength(1);

    for (let i = 0; i < 3; i += 1) await spend(m, hp.id, room.id);
    const total = await shareOf(hp.id);
    await h.pass();
    // Today's move is made: the new earnings are owed and wait.
    expect(paidTo(hp)).toHaveLength(1);
    const owed = (await settlements(hp.id)).filter((r) => r.status === 'owed');
    expect(owed.length).toBeGreaterThan(0);
    expect(balance(hp)).toBe(BigInt(first));

    await h.pass(DAY + 2 * 3_600_000);
    expect(paidTo(hp)).toHaveLength(2);
    expect(balance(hp)).toBe(BigInt(total));
    await h.pass(DAY + 2 * 3_600_000);
    expect(paidTo(hp)).toHaveLength(2);
    expect(
      await h.prisma.earningMove.count({ where: { payeeWawuUserId: hp.id } }),
    ).toBe(2);
    await h.expectLedgerEqualsStandIn([m, hp]);
    await operationalAgrees();
  });

  it('a host without a wallet keeps earning, and the share lands once the minute they open one (R-11)', async () => {
    const m = await member();
    const { p: hp, room } = await host(false);
    for (let i = 0; i < 3; i += 1) await spend(m, hp.id, room.id);
    const owed = await shareOf(hp.id);
    const sent0 = h.nuvion.sendsFrom(h.nuvion.operational.accountId).length;
    await h.pass();
    await h.pass();
    const waiting = await settlements(hp.id);
    expect(waiting).toHaveLength(3);
    expect(waiting.every((r) => r.status === 'owed')).toBe(true);
    expect(h.nuvion.sendsFrom(h.nuvion.operational.accountId)).toHaveLength(
      sent0,
    );

    // They open a wallet.
    const opened = await h.person(0);
    await h.prisma.fintavaWallet.update({
      where: { wawuUserId: opened.id },
      data: { wawuUserId: hp.id },
    });
    await h.pass();
    await h.pass();
    expect((await settlements(hp.id)).every((r) => r.status === 'landed')).toBe(
      true,
    );
    expect(
      h.nuvion.accounts.get(opened.account!.accountId)!.availableKobo,
    ).toBe(BigInt(owed));
    expect(paidTo(opened)).toHaveLength(1);
    await h.pass();
    expect(paidTo(opened)).toHaveLength(1);
    await operationalAgrees();
  });

  it('credits bought another way, or a spend that mixed them, are not paid from the wallet', async () => {
    const { p: hp, room } = await host();
    const buyer = await h.person(RICH);
    const now = new Date();
    const lot = async (
      user: string,
      credits: number,
      walletPaymentId: string | null,
    ) => {
      const purchase = await h.prisma.creditPurchase.create({
        data: {
          userWawuId: user,
          pack: 'popular',
          creditsGranted: credits,
          flutterwaveTxRef: `w17-${randomUUID()}`,
          amount: 1000,
          status: 'completed',
          purchasedAt: now,
          walletPaymentId,
        },
      });
      await h.prisma.creditLot.create({
        data: {
          creditPurchaseId: purchase.id,
          userWawuId: user,
          creditsGranted: credits,
          creditsRemaining: credits,
          grossKobo: 100_000,
          purchasedAt: now,
        },
      });
    };
    // Credits bought at Flutterwave: WAWU's money is there, not in its account here.
    await lot(buyer.id, 120, null);
    await spend(buyer, hp.id, room.id, 100);
    expect(await shareOf(hp.id)).toBeGreaterThan(0);
    await h.pass();
    expect(await settlements(hp.id)).toHaveLength(0);

    // A spend that used the last of those and some bought with the wallet.
    const m = await member();
    await lot(m.id, 10, null);
    // The older lot is drawn first (FIFO): 10 from it, then 5 from the wallet pack.
    await h.prisma.creditLot.updateMany({
      where: { userWawuId: m.id, creditPurchase: { walletPaymentId: null } },
      data: { purchasedAt: new Date(now.getTime() - 3_600_000) },
    });
    await spend(m, hp.id, room.id, 15);
    await h.pass();
    expect(await settlements(hp.id)).toHaveLength(0);
    expect(paidTo(hp)).toHaveLength(0);
  });

  it("the database refuses a share that is not the host's, or the same spent credit twice", async () => {
    const m = await member();
    const { p: hp, room } = await host();
    await spend(m, hp.id, room.id, 12);
    await h.pass();
    const row = (await settlements(hp.id))[0];
    const earning = await h.prisma.creditSpendEarning.findFirstOrThrow({
      where: { creatorWawuId: hp.id },
    });
    expect(row.creditSpendEarningId).toBe(earning.id);
    const base = {
      kind: HOST_SHARE_KIND,
      targetId: room.id,
      title: 'Community credits',
      earnedAt: new Date(),
      merchantAccountNumber: row.merchantAccountNumber,
      provider: row.provider,
    };
    // Twice for one spent credit.
    await expect(
      h.prisma.earningSettlement.create({
        data: {
          ...base,
          creditSpendEarningId: earning.id,
          payeeWawuUserId: hp.id,
          amountKobo: BigInt(earning.hostShareKobo),
          customerReference: `wawu-earn-cs-${earning.id}-2`,
        },
      }),
    ).rejects.toThrow();
    // Someone else's share of it, and another amount.
    const other = await host();
    const second = await spend(m, other.p.id, other.room.id, 6);
    const secondEarning = await h.prisma.creditSpendEarning.findFirstOrThrow({
      where: { creditSpendId: second.id },
    });
    await expect(
      h.prisma.earningSettlement.create({
        data: {
          ...base,
          creditSpendEarningId: secondEarning.id,
          payeeWawuUserId: hp.id,
          amountKobo: BigInt(secondEarning.hostShareKobo),
          customerReference: `wawu-earn-cs-${secondEarning.id}`,
        },
      }),
    ).rejects.toThrow();
    await expect(
      h.prisma.earningSettlement.create({
        data: {
          ...base,
          creditSpendEarningId: secondEarning.id,
          payeeWawuUserId: other.p.id,
          amountKobo: BigInt(secondEarning.hostShareKobo) + 1n,
          customerReference: `wawu-earn-cs-${secondEarning.id}`,
        },
      }),
    ).rejects.toThrow();
    // And neither a payment nor a credit earning, nor both.
    await expect(
      h.prisma.earningSettlement.create({
        data: {
          ...base,
          payeeWawuUserId: hp.id,
          amountKobo: 1000n,
          customerReference: `wawu-earn-cs-${randomUUID()}`,
        },
      }),
    ).rejects.toThrow();
  });
});
