import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  Prisma,
  StoreEarning,
  StorePurchase,
} from '../../generated/prisma/client';
import type { StoreIntentKind } from '../../generated/prisma/enums';
import {
  readWalletProviderName,
  WALLET_PROVIDER_CONFIG_KEY,
} from '../wallet-provider/wallet-provider-config';
import {
  creatorShareOfList,
  EARNING_KIND_OF,
  payableAt,
} from './store-buy-rules';

/** What a store refund did to the creator's share (recorded on the purchase's `takenBack`). */
export interface EarningTakeBack {
  /**
   * none: the purchase had no earning. cancelled: it had not been paid, so it
   * is cancelled. already_cancelled: said before. debt: it had been paid, so
   * a deduction of the same amount comes off the creator's next daily move.
   * review: a second refund of an earning that had already been through a
   * reversal; a person looks (`StorePurchase.flag`).
   */
  earning: 'none' | 'cancelled' | 'already_cancelled' | 'debt' | 'review';
  /** The deduction's amount in kobo, for `debt`. */
  debtKobo?: number;
}

/** What a reversed refund did to the creator's share. */
export interface EarningRestore {
  /** none, restored (cancelled back to owed), debt_voided (the deduction was removed, nothing had been taken), debt_reduced (part had been taken and is owed back), unchanged, or review. */
  earning:
    | 'none'
    | 'restored'
    | 'debt_voided'
    | 'debt_reduced'
    | 'unchanged'
    | 'review';
  /** For `debt_reduced`: what had been taken and is now owed back to the creator, in kobo. */
  owedBackKobo?: number;
}

/** The facts a ladder sale's earning is made from. */
export interface RecordEarning {
  purchase: StorePurchase;
  payeeWawuUserId: string;
  buyKind: StoreIntentKind;
  targetId: string;
  title: string;
  /** The list price, whole kobo: the creator's 85% is worked from this, never from what the store charged. */
  listPriceKobo: number;
  /** When the sale was made. */
  soldAt: Date;
  /**
   * When the creator earned it, if that is later than the sale: a paid
   * question is earned when it is answered, and the 3 working days count from
   * then (STORE-QUESTION). Unset, the sale's own time counts.
   */
  earnedAt?: Date;
}

/**
 * The creator's 85% of a store sale (STORE-BUY-HUB, R-101 points 2, 4 and 5).
 *
 * **Recorded** inside the grant's transaction, with the day it may be paid
 * (`availableAt`, the sale plus 3 working days, Lagos time). **Not moved**: the
 * daily mover (`EarningSettlementService`) reads only `EarningSettlement`, and
 * nothing here writes that table, so a store earning cannot be paid early. The
 * payout is STORE-PAYOUT's.
 *
 * **Taken back** when the store pays the buyer back: an earning that has not
 * been paid is cancelled; one that has been paid becomes a deduction in
 * `EarningDeduction`, which the creator's next daily move takes from their
 * earnings. Money is never taken out of a wallet. **Restored** when Apple
 * reverses its refund. Every step is idempotent: the purchase row's status
 * decides who gets here, once.
 */
@Injectable()
export class StoreEarningService {
  constructor(private readonly config: ConfigService) {}

  /** The wallet provider this Hub runs: the one whose mover takes the creator's deductions. */
  providerName(): string {
    return readWalletProviderName(
      this.config.get<string>(WALLET_PROVIDER_CONFIG_KEY),
    );
  }

  /** Records the earning for a purchase that has just been granted. Once per purchase (unique key); returns its id. */
  async record(
    tx: Prisma.TransactionClient,
    a: RecordEarning,
  ): Promise<string> {
    const earnedAt =
      a.earnedAt ??
      new Date(Math.min(a.soldAt.getTime(), a.purchase.createdAt.getTime()));
    const data = {
      storePurchaseId: a.purchase.id,
      role: 'sale',
      payeeWawuUserId: a.payeeWawuUserId,
      kind: EARNING_KIND_OF[a.buyKind],
      targetId: a.targetId,
      title: a.title,
      earnedAt,
      listPriceKobo: BigInt(a.listPriceKobo),
      amountKobo: BigInt(creatorShareOfList(a.listPriceKobo)),
      availableAt: payableAt(earnedAt),
      provider: this.providerName(),
    };
    await tx.storeEarning.createMany({ data: [data], skipDuplicates: true });
    const row = await tx.storeEarning.findUniqueOrThrow({
      where: {
        storePurchaseId_role: { storePurchaseId: a.purchase.id, role: 'sale' },
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Takes the creator's share back because the store paid the buyer back. */
  async takeBack(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    now: Date,
  ): Promise<EarningTakeBack> {
    const sale = await this.rowOf(tx, purchase.id, 'sale');
    if (sale === null) return { earning: 'none' };
    const restore = await this.rowOf(tx, purchase.id, 'restore');
    if (sale.status === 'cancelled') return { earning: 'already_cancelled' };
    if (sale.status === 'owed') {
      await this.cancel(tx, sale.id, now, 'refunded_by_store');
      if (restore !== null && restore.status === 'owed')
        await this.cancel(tx, restore.id, now, 'refunded_by_store');
      return { earning: 'cancelled' };
    }
    // Paid. A second refund after a reversal that had already given part back
    // is rare and not worked out by code: a person looks.
    if (restore !== null && restore.status === 'paid')
      return { earning: 'review' };
    if (restore !== null && restore.status === 'owed')
      await this.cancel(tx, restore.id, now, 'refunded_by_store');
    const existing = await tx.earningDeduction.findUnique({
      where: { storePurchaseId: purchase.id },
      select: { id: true },
    });
    const amount = sale.amountKobo;
    if (existing === null) {
      await tx.earningDeduction.create({
        data: {
          payeeWawuUserId: sale.payeeWawuUserId,
          storePurchaseId: purchase.id,
          amountKobo: amount,
          provider: sale.provider,
        },
      });
    } else {
      await tx.earningDeduction.update({
        where: { id: existing.id },
        data: { amountKobo: amount },
      });
    }
    return { earning: 'debt', debtKobo: Number(amount) };
  }

  /** Puts the creator's share back because Apple reversed its refund. */
  async restore(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    now: Date,
  ): Promise<EarningRestore> {
    const sale = await this.rowOf(tx, purchase.id, 'sale');
    if (sale === null) return { earning: 'none' };
    if (sale.status === 'cancelled') {
      await tx.storeEarning.update({
        where: { id: sale.id },
        data: { status: 'owed', cancelledAt: null, cancelReason: null },
      });
      return { earning: 'restored' };
    }
    if (sale.status === 'owed') return { earning: 'unchanged' };
    // Paid: the refund made a deduction (or, if the creator was owed nothing
    // more, none). The part not yet taken is voided; the part already taken is
    // owed back to the creator as an earning of its own.
    const restore = await this.rowOf(tx, purchase.id, 'restore');
    if (restore !== null) return { earning: 'review' };
    const deduction = await tx.earningDeduction.findUnique({
      where: { storePurchaseId: purchase.id },
      select: { id: true },
    });
    if (deduction === null) return { earning: 'unchanged' };
    const taken = await tx.earningDeductionTake.aggregate({
      where: { deductionId: deduction.id },
      _sum: { amountKobo: true },
    });
    const takenKobo = taken._sum.amountKobo ?? 0n;
    if (takenKobo === 0n) {
      await tx.earningDeduction.delete({ where: { id: deduction.id } });
      return { earning: 'debt_voided' };
    }
    await tx.earningDeduction.update({
      where: { id: deduction.id },
      data: { amountKobo: takenKobo },
    });
    await tx.storeEarning.create({
      data: {
        storePurchaseId: purchase.id,
        role: 'restore',
        payeeWawuUserId: sale.payeeWawuUserId,
        kind: sale.kind,
        targetId: sale.targetId,
        title: sale.title,
        earnedAt: now,
        listPriceKobo: sale.listPriceKobo,
        amountKobo: takenKobo,
        availableAt: now,
        provider: sale.provider,
      },
    });
    return { earning: 'debt_reduced', owedBackKobo: Number(takenKobo) };
  }

  private rowOf(
    tx: Prisma.TransactionClient,
    storePurchaseId: string,
    role: 'sale' | 'restore',
  ): Promise<StoreEarning | null> {
    return tx.storeEarning.findUnique({
      where: { storePurchaseId_role: { storePurchaseId, role } },
    });
  }

  private async cancel(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
    reason: string,
  ): Promise<void> {
    await tx.storeEarning.update({
      where: { id },
      data: { status: 'cancelled', cancelledAt: now, cancelReason: reason },
    });
  }
}
