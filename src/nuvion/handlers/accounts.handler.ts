import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AddMoneyService } from '../../money/add-money/add-money.service';
import { LedgerService } from '../../money/ledger/ledger.service';
import { tellWalletReady } from '../../money/opening/wallet-ready-notice';
import { NotificationService } from '../../notification/notification.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { NuvionAccountsArea } from '../areas/accounts';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import { NuvionAccountRecorder } from './accounts';
import { NuvionInflowRecorder } from './inflows';
import type {
  NuvionDelivery,
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

/** The events NUV-04 handles. */
export const NUVION_ACCOUNTS_EVENTS: readonly NuvionWebhookEventName[] = [
  'accounts.created',
  'account_details.created',
  'account_details.updated',
  'inflows.completed',
  'inflows.failed',
];

/**
 * Accounts and money in (task NUV-04): `accounts.created` (request the
 * account number), `account_details.created` and `.updated` (the number
 * going `active`: src/nuvion/handlers/accounts.ts) and `inflows.completed`
 * and `.failed` (money in by bank transfer, R-42: inflows.ts). This file is
 * NUV-04's alone; the receiver, the dispatcher and the registry are NUV-01's
 * and unchanged.
 *
 * What it needs beyond the database is looked up when a delivery comes,
 * not injected: the running wallet provider (`WALLET_PROVIDER`, for the
 * Nuvion client) and the ledger (`LedgerService`). NuvionWebhookModule,
 * which provides this handler, imports neither (NUV-01 mounts it apart from
 * the money modules so that no module loop forms), and importing them there
 * would mean editing NUV-01's module, which every wave-2 task shares. Both
 * are in the app (MoneyModule mounts them); while either is missing, a
 * delivery waits.
 *
 * Only under `WALLET_PROVIDER=nuvion`: a server switched back to Fintava
 * leaves Nuvion's deliveries pending (the receiver keeps storing them), for
 * a Nuvion server to handle, as the ledger consumer leaves Fintava's
 * deliveries alone under nuvion (NUV-01's rollback rule).
 */
@Injectable()
export class NuvionAccountsHandler implements NuvionEventHandler {
  readonly task = 'NUV-04';
  readonly events: readonly NuvionWebhookEventName[] = NUVION_ACCOUNTS_EVENTS;

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
    const area = new NuvionAccountsArea(provider.client);
    const settings = provider.client.settings;
    switch (d.event) {
      case 'accounts.created':
      case 'account_details.created':
      case 'account_details.updated': {
        // WALLET-40: the recorder writes the person's "account number is
        // ready" notice with the wallet row, whichever of these events is
        // the one that finds the number active. Without the notification
        // service the delivery waits: a wallet is never recorded without
        // its notice (the service is global in the app).
        const notifications =
          this.find<NotificationService>(NotificationService);
        if (!notifications) {
          return {
            outcome: 'wait',
            note: 'the notification service is not mounted',
          };
        }
        const recorder = new NuvionAccountRecorder(
          this.prisma,
          area,
          settings,
          (tx, wawuUserId) => tellWalletReady(notifications, tx, wawuUserId),
        );
        return d.event === 'accounts.created'
          ? recorder.onAccountCreated(d)
          : recorder.onAccountDetails(d);
      }
      case 'inflows.completed':
      case 'inflows.failed': {
        const ledger = this.find<LedgerService>(LedgerService);
        if (!ledger) {
          return { outcome: 'wait', note: 'the ledger is not mounted' };
        }
        // WALLET-25, WALLET-26: a payment made through Add money is credited by
        // AddMoneyService (found like the ledger: it is in the app, or the
        // hook is left out and the recorder answers as it always did).
        const addMoney = this.find<AddMoneyService>(AddMoneyService);
        return new NuvionInflowRecorder(
          this.prisma,
          area,
          ledger,
          settings,
          addMoney
            ? (t, w, source, eventId) =>
                addMoney.creditInflow(t, w, source, eventId)
            : null,
        ).onInflow(d);
      }
      default:
        return { outcome: 'done', note: `${d.event}: not NUV-04's` };
    }
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
