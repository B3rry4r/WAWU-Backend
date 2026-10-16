import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LedgerService } from '../../money/ledger/ledger.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';
import { NuvionBankOutflowRecorder } from './outflows-bank';

/** The events NUV-06 handles. */
export const NUVION_PAYOUTS_EVENTS: readonly NuvionWebhookEventName[] = [
  'outflows.completed',
  'outflows.failed',
  'outflows.cancelled',
  'outflows.refunded',
];

/**
 * Payouts (task NUV-06): the `outflows.*` events whose `payment_type` is
 * `bank-transfer` (NIP sends, from a person's wallet or from WAWU's
 * operational account), read back from Nuvion and merged into the ledger
 * once (src/nuvion/handlers/outflows-bank.ts). A book transfer's events run
 * through NUV-05's handler too, and each says whether the event was its
 * own. This file is NUV-06's alone: the receiver, the dispatcher and the
 * registry are NUV-01's and unchanged.
 *
 * What it needs beyond the database is looked up when a delivery comes, not
 * injected (as NUV-04's handler does, for the same reason: the webhook
 * module is mounted apart from the money modules so that no module loop
 * forms): the running wallet provider and the ledger. While either is
 * missing, a delivery waits. Only under `WALLET_PROVIDER=nuvion`: a server
 * switched back to Fintava leaves Nuvion's deliveries pending (the receiver
 * keeps storing them), for a Nuvion server to handle.
 */
@Injectable()
export class NuvionPayoutsHandler implements NuvionEventHandler {
  readonly task = 'NUV-06';
  readonly events: readonly NuvionWebhookEventName[] = NUVION_PAYOUTS_EVENTS;

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
    const ledger = this.find<LedgerService>(LedgerService);
    if (!ledger) {
      return { outcome: 'wait', note: 'the ledger is not mounted' };
    }
    return new NuvionBankOutflowRecorder(
      this.prisma,
      provider.payouts,
      ledger,
      provider.client.settings,
    ).onOutflow(d);
  }

  /** A provider from anywhere in the app, or null when it is not there. */
  private find<T>(token: unknown): T | null {
    try {
      return this.moduleRef.get<T>(token as string, { strict: false });
    } catch {
      return null;
    }
  }
}
