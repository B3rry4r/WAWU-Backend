import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CapitalService } from '../../capital/capital.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { readNuvionTransfer } from '../nuvion-ledger-delivery';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/**
 * The events NUV-12 handles. The four `capital_*` names are Nuvion's own
 * (webhooks__event-types.md) and are not in NUVION_WEBHOOK_EVENTS; a delivery
 * of any well-formed event is stored anyway and handed over once a handler
 * lists it. The transfer events are shared with the rails that handle their
 * own payment types: this handler answers only for the `capital-` ones.
 */
export const NUVION_CAPITAL_EVENTS: readonly string[] = [
  'capital_orders.completed',
  'capital_accounts.created',
  'capital_accounts.updated',
  'capital_accounts.completed',
  'inflows.completed',
  'outflows.completed',
];

/** Tries before a transfer that matches no order of ours is left for review. */
const MATCH_TRIES = 6;

const done = (note: string): NuvionHandlerResult => ({ outcome: 'done', note });

/** Where a transfer of the Capital rails is written: the payment types Nuvion gave dev on 24 Oct 2026. */
function isCapitalRail(paymentType: string | null): boolean {
  return paymentType !== null && paymentType.startsWith('capital-');
}

/**
 * Capital (task NUV-12): Nuvion's order and holding events and the transfers
 * its Capital rails make. An order or holding event only wakes the read: the
 * order is fetched from Nuvion again and the row brought up to date
 * (`CapitalService.refresh`), as Nuvion advises for anything that touches
 * money. A `capital-*` transfer is the purchase (an outflow) or a payout (an
 * inflow): it is written to the ledger once, on the row our own confirm or
 * sweep already wrote, and the provider's transfer id is added to it. This
 * file is NUV-12's alone. Like the other handlers, it looks the running
 * provider and the Capital service up when a delivery comes (the webhook
 * module is mounted apart from the money modules), and waits while either is
 * missing; only under `WALLET_PROVIDER=nuvion`.
 */
@Injectable()
export class NuvionCapitalHandler implements NuvionEventHandler {
  readonly task = 'NUV-12';
  readonly events: readonly string[] = NUVION_CAPITAL_EVENTS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async handle(d: NuvionDelivery): Promise<NuvionHandlerResult> {
    const provider = this.find<WalletProvider>(WALLET_PROVIDER);
    if (!provider) {
      return { outcome: 'wait', note: 'the wallet provider is not mounted' };
    }
    if (!(provider instanceof NuvionWalletProvider)) {
      return {
        outcome: 'wait',
        note: `the server runs ${provider.label}; left for a Nuvion server`,
      };
    }
    const capital = this.find<CapitalService>(CapitalService);
    if (!capital) return { outcome: 'wait', note: 'Capital is not mounted' };

    if (d.event.startsWith('capital_')) return this.onCapitalEvent(d, capital);
    return this.onTransfer(d, capital);
  }

  private async onCapitalEvent(
    d: NuvionDelivery,
    capital: CapitalService,
  ): Promise<NuvionHandlerResult> {
    const data = d.data as Record<string, unknown> | null;
    const orderId = d.event.startsWith('capital_orders.')
      ? data?.id
      : data?.capital_order_id;
    if (typeof orderId !== 'string' || orderId === '') {
      return done('the event names no order; nothing read');
    }
    const row = await this.prisma.capitalOrder.findUnique({
      where: { nuvionOrderId: orderId },
    });
    if (!row) return done('not an order WAWU made: left alone');
    const wallet = await capital.walletOf(row.wawuUserId);
    if (!wallet)
      return { outcome: 'wait', note: 'the wallet is not recorded yet' };
    await capital.refresh(wallet, row);
    return done('the order was read again from Nuvion');
  }

  private async onTransfer(
    d: NuvionDelivery,
    capital: CapitalService,
  ): Promise<NuvionHandlerResult> {
    const read = readNuvionTransfer(d.data);
    if (!read.ok) return done('not a transfer this handler can read');
    const t = read.transfer;
    if (!isCapitalRail(t.paymentType)) return done('not a Capital transfer');
    if (t.status.toLowerCase() !== 'successful') {
      return done(`a Capital transfer that is ${t.status}: nothing written`);
    }
    const entityId = t.entityId ?? d.entityId;
    if (!entityId) return done('the transfer names no entity');
    const entity = await this.prisma.nuvionEntity.findUnique({
      where: { entityId },
      select: { wawuUserId: true },
    });
    if (!entity) return done("not a person's entity: left alone");
    const wallet = await capital.walletOf(entity.wawuUserId);
    if (!wallet)
      return { outcome: 'wait', note: 'the wallet is not recorded yet' };

    const tryAgain = (note: string): NuvionHandlerResult =>
      d.attempts < MATCH_TRIES
        ? { outcome: 'wait', note }
        : { outcome: 'failed', note: `${note}; left for review` };

    if (t.type === 'inflow') {
      // A payout: its counterparty is the holding's `user_capital_account_id`.
      const row = t.counterpartyId
        ? await this.prisma.capitalOrder.findFirst({
            where: {
              wawuUserId: entity.wawuUserId,
              userCapitalAccountId: t.counterpartyId,
            },
          })
        : null;
      if (!row)
        return tryAgain('a Capital payout matches no order of ours yet');
      await capital.ledger.recordPayout(row, wallet.accountNumber, {
        transferId: t.id,
        uniqueReference: t.uniqueReference,
        amountKobo: t.amountKobo,
        at: t.createdAt,
      });
      await this.prisma.capitalOrder.update({
        where: { id: row.id },
        data: { payoutTransferId: t.id },
      });
      await capital.refresh(wallet, row);
      return done('the payout was written to the ledger');
    }

    // The purchase: the one confirmed order of this person for this amount whose transfer is not yet attached.
    const candidates = await this.prisma.capitalOrder.findMany({
      where: {
        wawuUserId: entity.wawuUserId,
        state: { in: ['confirming', 'confirmed'] },
        purchaseTransferId: null,
        totalDebitMinor: BigInt(t.amountKobo),
      },
      orderBy: { createdAt: 'asc' },
      take: 2,
    });
    if (candidates.length === 0)
      return tryAgain('a Capital purchase matches no order of ours yet');
    if (candidates.length > 1) {
      // Two orders for the same amount: the transfer cannot say which. Both
      // ledger rows already stand on our own references; nothing is guessed.
      return done(
        'two orders match this amount: left to the order that wrote its own row',
      );
    }
    const row = candidates[0];
    await capital.ledger.recordPurchase(row, wallet.accountNumber, t.id);
    await this.prisma.capitalOrder.update({
      where: { id: row.id },
      data: { purchaseTransferId: t.id },
    });
    return done('the purchase was matched to its order');
  }

  /** A provider or service from anywhere in the app, or null when it is not there. */
  private find<T>(token: unknown): T | null {
    try {
      return this.moduleRef.get<T>(token as string, { strict: false });
    } catch {
      return null;
    }
  }
}
