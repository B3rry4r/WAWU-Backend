import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { FxAccount } from '../../../generated/prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FxOperationsService } from '../../money/fx/fx-operations.service';
import { tellWalletReady } from '../../money/opening/wallet-ready-notice';
import { NotificationService } from '../../notification/notification.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import type { ProviderFxChain } from '../../wallet-provider/wallet-provider-fx';
import { readNuvionTransfer } from '../nuvion-ledger-delivery';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/** The events WALLET-21 handles for a person's foreign accounts. */
export const NUVION_FX_EVENTS: readonly NuvionWebhookEventName[] = [
  'account_details.created',
  'account_details.updated',
  'inflows.completed',
  'inflows.failed',
  'outflows.completed',
  'outflows.failed',
  'outflows.cancelled',
  'outflows.refunded',
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Foreign accounts (task WALLET-21, R-83, R-84): Nuvion's deliveries about a
 * person's dollar, euro, pound, Canadian dollar, dirham, cedi or stablecoin
 * account go into the ledger of these accounts (`FxMovement`, one row per
 * Nuvion transfer, written again to the same row on a repeat), and a swap or
 * send of ours that the delivery names is settled from the provider's own
 * record (never from the delivery alone, as Nuvion advises: the transfer is
 * read back first). This file is WALLET-21's alone; the registry lists it.
 *
 * A delivery about an account that is not a foreign account of ours (the
 * naira wallet, WAWU's own account) is not this handler's and is answered
 * `done`: NUV-04 to NUV-08 own those. Only under `WALLET_PROVIDER=nuvion`.
 */
@Injectable()
export class NuvionFxHandler implements NuvionEventHandler {
  readonly task = 'WALLET-21';
  readonly events: readonly NuvionWebhookEventName[] = NUVION_FX_EVENTS;
  private readonly logger = new Logger(NuvionFxHandler.name);

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
    const fx = provider.fx;
    if (!fx)
      return {
        outcome: 'done',
        note: 'this adapter holds no foreign accounts',
      };
    const data = isRecord(d.data) ? d.data : {};
    const wrapped = isRecord(data.account_details)
      ? data.account_details
      : data;
    const accountId =
      typeof wrapped.account_id === 'string' ? wrapped.account_id : null;
    if (!accountId)
      return { outcome: 'done', note: `${d.event}: names no account` };
    const account = await this.prisma.fxAccount.findFirst({
      where: { provider: 'nuvion', providerAccountId: accountId },
    });
    if (!account)
      return {
        outcome: 'done',
        note: `${d.event}: not a foreign account of ours`,
      };

    if (
      d.event === 'account_details.created' ||
      d.event === 'account_details.updated'
    ) {
      const detailsId = typeof wrapped.id === 'string' ? wrapped.id : null;
      if (detailsId && detailsId !== account.detailsId) {
        await this.prisma.fxAccount.update({
          where: { id: account.id },
          data: { detailsId },
        });
      }
      return this.tellReady(d, fx, account);
    }

    const read = readNuvionTransfer(d.data);
    if (!read.ok)
      return {
        outcome: 'failed',
        note: `the transfer could not be read (${read.why})`,
      };
    const t = read.transfer;
    // Nuvion advises reading the transfer back before acting on money: the
    // status and the fee come from the record, not from the delivery.
    let status = t.status.toLowerCase();
    let fee = BigInt(t.feeKobo);
    try {
      const wallet = await this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId: account.wawuUserId },
      });
      const look = await fx.readTransfer(
        {
          customerId: account.providerCustomerId,
          walletId: wallet?.walletId ?? '',
        },
        t.id,
      );
      if (look.state === 'unknown')
        return {
          outcome: 'wait',
          note: 'the transfer could not be read back yet',
        };
      if (look.state === 'found') {
        status =
          look.transfer.status === 'completed'
            ? 'successful'
            : look.transfer.status === 'failed'
              ? 'failed'
              : 'pending';
        fee = look.transfer.feeMinor ?? fee;
      }
    } catch {
      return {
        outcome: 'wait',
        note: 'the transfer could not be read back yet',
      };
    }
    const ledgerStatus =
      status === 'successful'
        ? 'completed'
        : status === 'failed'
          ? 'failed'
          : status === 'reversed'
            ? 'reversed'
            : 'pending';
    const direction =
      d.event.startsWith('inflows.') ||
      d.event === 'outflows.refunded' ||
      t.type === 'inflow'
        ? 'in'
        : 'out';
    await this.prisma.fxMovement.upsert({
      where: {
        provider_providerTransferId: {
          provider: 'nuvion',
          providerTransferId: t.id,
        },
      },
      create: {
        provider: 'nuvion',
        providerTransferId: t.id,
        wawuUserId: account.wawuUserId,
        fxAccountId: account.id,
        currency: account.currency,
        direction,
        status: ledgerStatus,
        amountMinor: BigInt(t.amountKobo),
        feeMinor: fee,
        paymentType: t.paymentType,
        reference: t.uniqueReference,
        eventId: d.eventId,
        occurredAt: t.createdAt ?? d.receivedAt,
      },
      update: { status: ledgerStatus, feeMinor: fee, eventId: d.eventId },
    });
    // A swap or send of ours: settle it from the provider's record.
    const ref = t.uniqueReference;
    if (ref) {
      const op = await this.prisma.fxOperation.findUnique({
        where: { reference: ref.endsWith('-fee') ? ref.slice(0, -4) : ref },
        select: { id: true },
      });
      if (op) {
        const ops = this.find<FxOperationsService>(FxOperationsService);
        if (!ops)
          return {
            outcome: 'wait',
            note: 'the foreign-account service is not mounted',
          };
        try {
          await ops.refreshOperation(op.id);
        } catch (e) {
          this.logger.warn(
            `fx handler: ${op.id} not settled yet (${e instanceof Error ? e.name : 'error'})`,
          );
          return {
            outcome: 'wait',
            note: 'the swap or send could not be settled yet',
          };
        }
        return {
          outcome: 'done',
          note: `${account.currency} ${direction} recorded; our ${ref.endsWith('-fee') ? 'fee' : 'operation'} settled`,
        };
      }
    }
    return {
      outcome: 'done',
      note: `${account.currency} ${direction} recorded`,
    };
  }

  /**
   * NUVION-FIX 9.6: the person is told once when a foreign account's details are ready (5 to 30 minutes after they were asked
   * for). Never on the delivery's word: the details are read back from the provider first. The notice is the wallet's own
   * ("Your account number is ready", `wallet_ready`; the tap opens Wallet) and is written in the transaction that sets
   * `detailsReadyAt` with a conditional write, so a repeated or racing delivery, and a person who already saw the details ready,
   * never get a second one.
   */
  private async tellReady(
    d: NuvionDelivery,
    fx: NonNullable<NuvionWalletProvider['fx']>,
    account: FxAccount,
  ): Promise<NuvionHandlerResult> {
    const noted = {
      outcome: 'done' as const,
      note: `${account.currency} account details noted`,
    };
    if (account.detailsReadyAt) return noted;
    const notifications = this.find<NotificationService>(NotificationService);
    if (!notifications) {
      return {
        outcome: 'wait',
        note: 'the notification service is not mounted',
      };
    }
    let active: boolean;
    try {
      const wallet = await this.prisma.fintavaWallet.findUnique({
        where: { wawuUserId: account.wawuUserId },
        select: { walletId: true },
      });
      const read = await fx.readDetails(
        {
          customerId: account.providerCustomerId,
          walletId: wallet?.walletId ?? '',
        },
        {
          accountId: account.providerAccountId ?? '',
          currency: account.currency,
          chain: (account.chain || null) as ProviderFxChain | null,
        },
        false,
      );
      active = read.details?.status === 'active';
    } catch {
      return {
        outcome: 'wait',
        note: 'the account details could not be read back yet',
      };
    }
    if (!active) {
      return {
        outcome: 'done',
        note: `${account.currency} account details noted; still pending`,
      };
    }
    const told = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.fxAccount.updateMany({
        where: { id: account.id, detailsReadyAt: null },
        data: { detailsReadyAt: new Date() },
      });
      if (claimed.count !== 1) return false;
      await tellWalletReady(notifications, tx, account.wawuUserId);
      return true;
    });
    return {
      outcome: 'done',
      note: told
        ? `${account.currency} account details ready; the person is told`
        : `${account.currency} account details noted`,
    };
  }

  private find<T>(token: unknown): T | null {
    try {
      return this.moduleRef.get<T>(token as string, { strict: false });
    } catch {
      return null;
    }
  }
}
