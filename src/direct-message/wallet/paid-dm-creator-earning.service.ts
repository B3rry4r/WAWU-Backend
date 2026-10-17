import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isRowOf } from '../../wallet-provider/provider-rows';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import {
  DmCreatorEarningHooks,
  type EarningQuestionRef,
} from '../dm-creator-earning-hooks';
import type {
  PaidDmCreatorEarning,
  PaidDmEarningState,
} from '../paid-dm-view.type';
import { paymentIdOfTxRef } from './paid-dm-wallet-rules';

/**
 * What a creator earns by each paid question they read (task INBOX-18; I10,
 * I11), from our own records of the held price and its release, never from a
 * balance and never a call to the wallet provider.
 *
 * - The amount is the hold's payee share, fixed when the question was paid
 *   (R-5); the percent is that share over the price.
 * - An answered question's share is an earning that goes to the wallet in the
 *   creator's one move a day (R-55): `in_wallet` once the earning landed,
 *   `on_its_way` while it travels, `waiting_for_wallet` while the creator has
 *   no wallet of the provider this server runs (R-11).
 * - A refunded question earns nothing, and a question that was not paid from
 *   the wallet holds no share: neither has an earning.
 */
@Injectable()
export class PaidDmCreatorEarningService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(WALLET_PROVIDER) private readonly provider: WalletProvider,
    private readonly hooks: DmCreatorEarningHooks,
  ) {}

  onModuleInit(): void {
    this.hooks.register((creator, questions) =>
      this.resolve(creator, questions),
    );
  }

  async resolve(
    creatorWawuId: string,
    questions: EarningQuestionRef[],
  ): Promise<Map<string, PaidDmCreatorEarning>> {
    const out = new Map<string, PaidDmCreatorEarning>();
    const paid = questions
      .filter((q) => q.status !== 'refunded')
      .map((q) => ({ q, paymentId: paymentIdOfTxRef(q.flutterwaveTxRef) }))
      .filter(
        (x): x is { q: EarningQuestionRef; paymentId: string } =>
          x.paymentId !== null,
      );
    if (paid.length === 0) return out;
    const ids = paid.map((x) => x.paymentId);
    const [holds, earnings, wallet] = await Promise.all([
      this.prisma.walletHold.findMany({
        where: { paymentId: { in: ids }, payeeWawuUserId: creatorWawuId },
        select: {
          paymentId: true,
          amountKobo: true,
          payeeShareKobo: true,
          status: true,
          action: true,
        },
      }),
      this.prisma.earningSettlement.findMany({
        where: { paymentId: { in: ids } },
        select: { paymentId: true, status: true },
      }),
      this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId: creatorWawuId },
        select: { provider: true },
      }),
    ]);
    const holdOf = new Map(holds.map((h) => [h.paymentId, h]));
    const earningOf = new Map(earnings.map((e) => [e.paymentId, e]));
    const walletOpen = !!wallet && isRowOf(this.provider.name, wallet.provider);
    for (const { q, paymentId } of paid) {
      const hold = holdOf.get(paymentId);
      if (!hold || hold.payeeShareKobo <= 0n) continue;
      let state: PaidDmEarningState;
      if (q.status === 'awaiting_response') {
        state = 'pending';
      } else if (hold.action === 'refund' || hold.status === 'refunded') {
        continue;
      } else {
        const earning = earningOf.get(paymentId);
        if (earning ? earning.status === 'landed' : hold.status === 'released')
          state = 'in_wallet';
        else state = walletOpen ? 'on_its_way' : 'waiting_for_wallet';
      }
      out.set(q.id, {
        amountKobo: Number(hold.payeeShareKobo),
        sharePct: Math.round(
          (Number(hold.payeeShareKobo) * 100) / Number(hold.amountKobo),
        ),
        state,
      });
    }
    return out;
  }
}
