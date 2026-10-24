import { Injectable } from '@nestjs/common';
import type { CapitalOrder as OrderRow } from '../../generated/prisma/client';
import { LedgerService } from '../money/ledger/ledger.service';
import { readSnapshot } from './capital-mapping';

/** What the ledger's references call each movement of a Capital order. */
export const purchaseReference = (orderId: string) => `wawu-cap-${orderId}`;
export const payoutReference = (orderId: string) =>
  `wawu-cap-payout-${orderId}`;
export const feeReference = (orderId: string) => `wawu-capfee-${orderId}`;

/** The provider's own record of a payout, when a delivery has brought one. */
export interface CapitalPayoutRecord {
  transferId: string;
  uniqueReference: string | null;
  amountKobo: number;
  at: Date | null;
}

/**
 * Capital's rows in the ledger (task NUV-12): the purchase out of the wallet,
 * the payout back in, and WAWU's fee. The ledger is a mirror of what the
 * provider moved, never a balance. Each row is keyed on our own reference, so
 * a second call (the sweep, a delivery, a repeat) lands on the same row, and a
 * delivery adds the provider's transfer id to it.
 */
@Injectable()
export class CapitalLedger {
  constructor(private readonly ledger: LedgerService) {}

  private party(row: OrderRow) {
    return {
      kind: 'wawu' as const,
      name: `Capital · ${row.productName}`,
      wawuUserId: null,
      accountNumber: null,
      bankCode: null,
      bankName: null,
    };
  }

  async recordPurchase(
    row: OrderRow,
    accountNumber: string,
    transferId: string | null = null,
  ): Promise<void> {
    const total = Number(row.totalDebitMinor ?? row.amountMinor);
    await this.ledger.record({
      wallet: { kind: 'user', wawuUserId: row.wawuUserId, accountNumber },
      direction: 'out',
      status: 'completed',
      category: 'transfer',
      amountKobo: total,
      feeKobo: 0,
      totalKobo: total,
      counterparty: this.party(row),
      narration: `${row.productName} order`,
      references: {
        customerReference: purchaseReference(row.id),
        ...(transferId ? { fintavaTransactionId: transferId } : {}),
      },
      source: 'send',
      occurredAt: row.confirmedAt,
    });
  }

  /**
   * The payout is recorded at what the provider says it paid. Without its
   * figure (the holding has no `netPayout` yet) nothing is written: a row is
   * never invented from our own arithmetic.
   */
  async recordPayout(
    row: OrderRow,
    accountNumber: string,
    delivered: CapitalPayoutRecord | null,
  ): Promise<boolean> {
    const net = readSnapshot(row).account?.netPayoutMinor ?? null;
    const amount = delivered?.amountKobo ?? net;
    if (amount === null || amount <= 0) return false;
    await this.ledger.record({
      wallet: { kind: 'user', wawuUserId: row.wawuUserId, accountNumber },
      direction: 'in',
      status: 'completed',
      category: 'transfer',
      amountKobo: amount,
      feeKobo: 0,
      totalKobo: amount,
      counterparty: this.party(row),
      narration: `${row.productName} payout`,
      references: {
        customerReference: payoutReference(row.id),
        ...(delivered
          ? {
              fintavaTransactionId: delivered.transferId,
              ...(delivered.uniqueReference
                ? { fintavaReference: delivered.uniqueReference }
                : {}),
            }
          : {}),
      },
      source: delivered ? 'webhook' : 'send',
      occurredAt: delivered?.at ?? new Date(),
    });
    return true;
  }

  async recordFee(
    row: OrderRow,
    accountNumber: string,
    reference: string,
    providerReference: string | null,
  ): Promise<void> {
    const fee = Number(row.feeKobo);
    await this.ledger.record({
      wallet: { kind: 'user', wawuUserId: row.wawuUserId, accountNumber },
      direction: 'out',
      status: 'completed',
      category: 'transfer',
      amountKobo: fee,
      feeKobo: 0,
      totalKobo: fee,
      counterparty: { ...this.party(row), name: 'Who Made This' },
      narration: 'Capital fee',
      references: {
        customerReference: reference,
        ...(providerReference ? { fintavaReference: providerReference } : {}),
      },
      source: 'send',
    });
  }
}
