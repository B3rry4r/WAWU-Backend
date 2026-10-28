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

/** What one re-read of waiting account details did. Counts only. */
export interface NuvionDetailsRereadReport {
  checked: number;
  /** Rows whose details moved: the number is now recorded (active), or the details are now known (pending). */
  recorded: number;
  /** Rows that could not be read, or whose details need a person to look. */
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
   * records what Nuvion now shows (NUVION-FIX 9.1). Null when Nuvion is not the running provider, or the notification
   * service is not mounted (a wallet is never recorded without its "ready" notice, as the delivery handler does).
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
      unreadable: 0,
    };
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
