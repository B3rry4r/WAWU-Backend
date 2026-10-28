import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { tellWalletReady } from '../../money/opening/wallet-ready-notice';
import { NotificationService } from '../../notification/notification.service';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { NuvionAccountsArea } from '../areas/accounts';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import { NuvionWebhookStore } from '../webhook/nuvion-webhook.service';
import {
  NuvionFeeCheck,
  type NuvionFeeCheckResult,
  NuvionSubscriptionCheck,
  type NuvionSubscriptionOutcome,
} from './reconcile-checks';
import { NuvionAccountRecorder } from './accounts';
import { lookAtForeignDetails } from './fx-details-ready';
import { readReconcileSettings } from './reconcile-config';
import { NuvionReconcileFindings } from './reconcile-findings';
import {
  NuvionMissedDeliverySweep,
  type NuvionSweepReport,
} from './reconcile-sweep';
import type {
  NuvionEventHandler,
  NuvionHandlerResult,
} from './nuvion-handler.interface';

const HOUR = 3_600_000;
/** Account details still requested or pending this long are read again by the sweep (NUVION-FIX 9.1). */
export const NUVION_DETAILS_REREAD_AFTER_MS = 5 * 60_000;
/** Rows of waiting account details read again in one pass. */
const DETAILS_BATCH = 100;
/**
 * WALK4-FIX M-2: a foreign account whose details are still not active this long after it was opened is left to the person's
 * own reads and to Nuvion's delivery; the sweep stops asking about it (it would be read every pass for good).
 */
const FOREIGN_DETAILS_SWEEP_DAYS = 3;

/** What one re-read of waiting account details did. Counts only. */
export interface NuvionDetailsRereadReport {
  checked: number;
  /** Rows whose details moved: the number is now recorded (active), or the details are now known (pending). */
  recorded: number;
  /** Accounts that had no details and were asked for (WALK4-FIX M-1), or whose details Nuvion already held and were adopted. */
  requested: number;
  /** Rows that could not be read, or whose details need a person to look. */
  unreadable: number;
}

/** What one look at the foreign accounts still waiting for their details did (WALK4-FIX M-2). Counts only. */
export interface NuvionForeignDetailsReport {
  checked: number;
  /** Accounts whose details were found active and whose one "ready" notice this pass wrote. */
  told: number;
  /** Accounts the provider could not be asked about. */
  unreadable: number;
}

/**
 * Reconciliation with Nuvion (task NUV-08): the missed-delivery sweep, the
 * webhook subscription check and the fee check's notice, run on a schedule.
 * This file is NUV-08's alone: it never edits the receiver, the dispatcher
 * or another task's handler, and it needs no module of its own (NUV-01
 * already provides it in NuvionWebhookModule).
 *
 * It lists no event, so no delivery reaches `handle`: Nuvion's deliveries
 * are another task's. What it does is on a clock. Every minute `tick` looks
 * at what is due: the sweep and the subscription check every
 * NUVION_SWEEP_MINUTES (reconcile-config.ts). The fee check says once that it
 * is not available (Nuvion's docs describe no fee simulation). Only under `WALLET_PROVIDER=nuvion`: a server
 * switched back to Fintava does nothing here (NUV-01's rollback rule). A
 * pass that throws is logged and tried again next time; one at a time per
 * server, and two servers doing the same pass is safe (the ledger keeps one
 * row per Nuvion transfer, and a swept movement is one stored delivery).
 *
 * What it needs beyond the database is looked up when it runs, not injected
 * (as the other handlers do, for the same reason: this module is mounted
 * apart from the money modules so that no module loop forms).
 */
@Injectable()
export class NuvionReconcileHandler implements NuvionEventHandler {
  readonly task = 'NUV-08';
  readonly events: readonly NuvionWebhookEventName[] = [];
  private readonly logger = new Logger('NuvionReconcile');
  private running = false;
  private lastSweepAt: number | null = null;
  private feeCheckDone = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly moduleRef: ModuleRef,
  ) {}

  handle(): Promise<NuvionHandlerResult> {
    return Promise.resolve({
      outcome: 'done',
      note: `${this.task}: nothing to do`,
    });
  }

  /** The minute clock. Does nothing unless Nuvion is the running provider. */
  @Cron(CronExpression.EVERY_MINUTE, { name: 'nuvion-reconcile' })
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    const provider = this.nuvion();
    if (!provider) return;
    const settings = this.settings();
    const due = (last: number | null, ms: number) =>
      last === null || now.getTime() - last >= ms;
    this.running = true;
    try {
      if (due(this.lastSweepAt, settings.sweepMinutes * 60_000)) {
        this.lastSweepAt = now.getTime();
        await this.guarded('sweep', () => this.sweep(now));
        await this.guarded('subscription check', () =>
          this.checkSubscription(),
        );
      }
      if (!this.feeCheckDone) {
        await this.guarded('fee check', async () => {
          await this.checkFees();
          this.feeCheckDone = true;
        });
      }
    } finally {
      this.running = false;
    }
  }

  /** One sweep pass now. Null when Nuvion is not the running provider. */
  async sweep(now = new Date()): Promise<NuvionSweepReport | null> {
    const provider = this.nuvion();
    if (!provider) return null;
    const settings = this.settings();
    const report = await new NuvionMissedDeliverySweep(
      this.prisma,
      provider,
      new NuvionWebhookStore(this.prisma),
      {
        lookbackMs: settings.lookbackHours * HOUR,
        maxAccounts: settings.maxAccounts,
        sweepMinutes: settings.sweepMinutes,
      },
    ).run(now);
    // NUVION-FIX 9.1: Nuvion stops retrying a delivery after 15 minutes and makes account details 5 to 30 minutes after they are
    // asked for, so a lost `account_details.updated` is found here.
    const details = await this.guarded('account details', () =>
      this.rereadAccountDetails(now),
    );
    if (details && details.unreadable > 0) {
      report.unreadable += details.unreadable;
      report.incomplete.push('account details could not be read again');
    }
    // WALK4-FIX M-2: a foreign account whose details turned active with the delivery lost, and whose owner has not looked.
    const foreign = await this.guarded('foreign account details', () =>
      this.rereadForeignDetails(now),
    );
    if (foreign && foreign.unreadable > 0) {
      report.unreadable += foreign.unreadable;
      report.incomplete.push('foreign account details could not be read again');
    }
    const findings = new NuvionReconcileFindings(this.prisma);
    if (report.incomplete.length > 0) {
      await findings.report({
        kind: 'sweep_incomplete',
        subject: 'sweep',
        detail: `The last sweep could not read everything: ${[...new Set(report.incomplete)].join('; ')}.`,
      });
    } else {
      await findings.resolve('sweep_incomplete', 'sweep');
    }
    return report;
  }

  /**
   * Reads again the account details of every person whose request is still `requested` or `pending` after 5 minutes, and
   * records what Nuvion now shows (NUVION-FIX 9.1). Reads only for those.
   *
   * WALK4-FIX M-1: an account recorded more than 5 minutes ago that has no details at all, and whose request was never made
   * (no id, no `requested` claim), is asked for here: Nuvion's one `accounts.created` delivery may have been lost. The ask is
   * the delivery's own (NuvionAccountRecorder.ensureDetails): the account's details are listed first and adopted if they
   * exist, the request is claimed with a conditional update so servers racing ask once, and no account is ever made.
   *
   * Null when Nuvion is not the running provider, or the notification service is not mounted (a wallet is never recorded
   * without its "ready" notice, as the delivery handler does).
   */
  async rereadAccountDetails(
    now = new Date(),
  ): Promise<NuvionDetailsRereadReport | null> {
    const provider = this.nuvion();
    if (!provider) return null;
    const notifications = this.find<NotificationService>(NotificationService);
    if (!notifications) return null;
    const recorder = new NuvionAccountRecorder(
      this.prisma,
      new NuvionAccountsArea(provider.client),
      provider.client.settings,
      (tx, wawuUserId) => tellWalletReady(notifications, tx, wawuUserId),
    );
    const rows = await this.prisma.nuvionEntity.findMany({
      where: {
        accountDetailsStatus: { in: ['requested', 'pending'] },
        accountId: { not: null },
        entityId: { not: null },
        updatedAt: {
          lt: new Date(now.getTime() - NUVION_DETAILS_REREAD_AFTER_MS),
        },
      },
      select: {
        entityId: true,
        accountId: true,
        accountDetailsId: true,
        accountDetailsStatus: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: DETAILS_BATCH,
    });
    const report: NuvionDetailsRereadReport = {
      checked: 0,
      recorded: 0,
      requested: 0,
      unreadable: 0,
    };
    const unasked = await this.prisma.nuvionEntity.findMany({
      where: {
        accountId: { not: null },
        entityId: { not: null },
        accountDetailsId: null,
        accountDetailsStatus: null,
        accountNumber: null,
        updatedAt: {
          lt: new Date(now.getTime() - NUVION_DETAILS_REREAD_AFTER_MS),
        },
      },
      select: { entityId: true, accountId: true },
      orderBy: { updatedAt: 'asc' },
      take: DETAILS_BATCH,
    });
    for (const row of unasked) {
      if (row.entityId === null || row.accountId === null) continue;
      report.checked += 1;
      const result = await recorder.ensureDetails(
        null,
        row.entityId,
        row.accountId,
      );
      if (result.outcome === 'done') {
        report.requested += 1;
      } else if (
        result.outcome === 'failed' ||
        !/request is out/.test(result.note)
      ) {
        // 'request is out': another server holds the claim and is asking; nothing is wrong.
        report.unreadable += 1;
      }
    }
    for (const row of rows) {
      if (row.entityId === null || row.accountId === null) continue;
      report.checked += 1;
      const result = await recorder.rereadDetails(
        row.entityId,
        row.accountId,
        row.accountDetailsId,
      );
      if (result.outcome === 'failed') {
        report.unreadable += 1;
      } else if (result.outcome === 'done') {
        const after = await this.prisma.nuvionEntity.findUnique({
          where: { entityId: row.entityId },
          select: { accountDetailsId: true, accountDetailsStatus: true },
        });
        if (
          after &&
          (after.accountDetailsStatus !== row.accountDetailsStatus ||
            after.accountDetailsId !== row.accountDetailsId)
        ) {
          report.recorded += 1;
        }
      } else if (/could not be asked/.test(result.note)) {
        report.unreadable += 1;
      }
    }
    return report;
  }

  /**
   * WALK4-FIX M-2. Reads again the details of the foreign accounts that are open, were opened over 5 minutes ago (and within
   * the last 3 days) and have not been told ready, and writes the one "Your {currency} account is ready" notice for each the
   * provider now shows active. Reads only; the notice is claimed with a conditional write (src/money/fx/fx-details-ready.ts), so
   * the delivery, the person's own read and servers sweeping at once write one. Null when Nuvion is not the running provider,
   * the adapter holds no foreign accounts, or the notification service is not mounted.
   */
  async rereadForeignDetails(
    now = new Date(),
  ): Promise<NuvionForeignDetailsReport | null> {
    const provider = this.nuvion();
    const fx = provider?.fx;
    if (!provider || !fx) return null;
    const notifications = this.find<NotificationService>(NotificationService);
    if (!notifications) return null;
    const rows = await this.prisma.fxAccount.findMany({
      where: {
        provider: 'nuvion',
        status: 'open',
        providerAccountId: { not: null },
        detailsReadyAt: null,
        createdAt: {
          gt: new Date(now.getTime() - FOREIGN_DETAILS_SWEEP_DAYS * 24 * HOUR),
          lt: new Date(now.getTime() - NUVION_DETAILS_REREAD_AFTER_MS),
        },
      },
      orderBy: { createdAt: 'asc' },
      take: DETAILS_BATCH,
    });
    const report: NuvionForeignDetailsReport = {
      checked: 0,
      told: 0,
      unreadable: 0,
    };
    for (const row of rows) {
      report.checked += 1;
      try {
        const look = await lookAtForeignDetails(
          this.prisma,
          notifications,
          fx,
          row,
        );
        if (look === 'told') report.told += 1;
        else if (look === 'unread') report.unreadable += 1;
      } catch (e) {
        // One account's failure (its notice could not be written) does not stop the others; its claim was rolled back with
        // the notice, so the next pass tries it again. The name only: a message can quote what Nuvion sent.
        report.unreadable += 1;
        this.logger.error(
          `foreign account details: one account could not be told (${(e as Error).name ?? 'Error'})`,
        );
      }
    }
    return report;
  }

  /** The subscription check now. Null when Nuvion is not the running provider. */
  async checkSubscription(): Promise<NuvionSubscriptionOutcome | null> {
    const provider = this.nuvion();
    if (!provider) return null;
    return new NuvionSubscriptionCheck(
      provider,
      new NuvionReconcileFindings(this.prisma),
    ).run();
  }

  /** The fee check now. Null when Nuvion is not the running provider. */
  async checkFees(): Promise<NuvionFeeCheckResult | null> {
    if (!this.nuvion()) return null;
    return new NuvionFeeCheck(new NuvionReconcileFindings(this.prisma)).run();
  }

  private async guarded<T>(
    what: string,
    run: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await run();
    } catch (e) {
      // The name only: a message can quote what Nuvion sent.
      this.logger.error(`${what} stopped (${(e as Error).name ?? 'Error'})`);
      return null;
    }
  }

  private nuvion(): NuvionWalletProvider | null {
    const provider = this.find<WalletProvider>(WALLET_PROVIDER);
    return provider instanceof NuvionWalletProvider ? provider : null;
  }

  private getter(): (key: string) => string | undefined {
    const config = this.find<ConfigService>(ConfigService);
    return (key) => config?.get<string>(key) ?? process.env[key];
  }

  private settings() {
    return readReconcileSettings(this.getter());
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
