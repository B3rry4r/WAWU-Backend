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
import { NuvionBookRecorder } from './book';
import type {
  NuvionEventHandler,
  NuvionHandlerResult,
  NuvionDelivery,
} from './nuvion-handler.interface';

/** The events NUV-05 handles. */
export const NUVION_BOOK_EVENTS: readonly NuvionWebhookEventName[] = [
  'outflows.created',
  'outflows.completed',
  'outflows.failed',
  'outflows.cancelled',
  'outflows.refunded',
];

/**
 * Book transfers (task NUV-05): the `outflows.*` events whose
 * `payment_type` is `book-transfer` (paying from the wallet, held money
 * through WAWU's operational account), read back from Nuvion and merged into
 * the ledger once (src/nuvion/handlers/book.ts). The money received by the
 * other side of a book transfer (`inflows.completed`) is recorded by the
 * sender's event, never twice (NUV-04 leaves it to this task). This file is
 * NUV-05's alone: it fills the handler NUV-01 registered, and the receiver,
 * the dispatcher and the registry are NUV-01's and unchanged. A payout
 * (`bank-transfer`) is NUV-06's: its events run through that handler too,
 * and each says whether the event was its own.
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
export class NuvionBookHandler implements NuvionEventHandler {
  readonly task = 'NUV-05';
  readonly events: readonly NuvionWebhookEventName[] = NUVION_BOOK_EVENTS;

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
    const area = provider.book;
    if (!area.store) {
      return {
        outcome: 'wait',
        note: 'no record of book transfers is attached to this adapter',
      };
    }
    return new NuvionBookRecorder(
      this.prisma,
      area,
      area.store,
      ledger,
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
