import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { readNuvionFees } from '../../money/fees/nuvion-fee-config';
import {
  WALLET_PROVIDER,
  type WalletProvider,
} from '../../wallet-provider/wallet-provider.interface';
import { NuvionWalletProvider } from '../nuvion-wallet-provider';
import type { NuvionWebhookEventName } from '../nuvion.interface';
import { NuvionWebhookStore } from '../webhook/nuvion-webhook.service';
import {
  NuvionFeeCheck,
  type NuvionFeeCheckResult,
  NuvionSubscriptionCheck,
  type NuvionSubscriptionOutcome,
} from './reconcile-checks';
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

/**
 * Reconciliation with Nuvion (task NUV-08): the missed-delivery sweep, the
 * webhook subscription's renewal and the fee comparison, run on a schedule.
 * This file is NUV-08's alone: it never edits the receiver, the dispatcher
 * or another task's handler, and it needs no module of its own (NUV-01
 * already provides it in NuvionWebhookModule).
 *
 * It lists no event, so no delivery reaches `handle`: Nuvion's deliveries
 * are another task's. What it does is on a clock. Every minute `tick` looks
 * at what is due: the sweep and the subscription check every
 * NUVION_SWEEP_MINUTES, the fee comparison every NUVION_FEE_CHECK_HOURS
 * (reconcile-config.ts). Only under `WALLET_PROVIDER=nuvion`: a server
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
  private lastFeeCheckAt: number | null = null;

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
          this.checkSubscription(now),
        );
      }
      if (due(this.lastFeeCheckAt, settings.feeCheckHours * HOUR)) {
        this.lastFeeCheckAt = now.getTime();
        await this.guarded('fee check', () => this.checkFees());
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

  /** The subscription check now. Null when Nuvion is not the running provider. */
  async checkSubscription(
    now = new Date(),
  ): Promise<NuvionSubscriptionOutcome | null> {
    const provider = this.nuvion();
    if (!provider) return null;
    return new NuvionSubscriptionCheck(
      provider,
      new NuvionReconcileFindings(this.prisma),
      this.settings().renewHours * HOUR,
    ).run(now);
  }

  /** The fee comparison now. Null when Nuvion is not the running provider. */
  async checkFees(): Promise<NuvionFeeCheckResult | null> {
    const provider = this.nuvion();
    if (!provider) return null;
    return new NuvionFeeCheck(
      provider,
      new NuvionReconcileFindings(this.prisma),
      () => readNuvionFees(this.getter()),
    ).run();
  }

  private async guarded(what: string, run: () => Promise<unknown>) {
    try {
      await run();
    } catch (e) {
      // The name only: a message can quote what Nuvion sent.
      this.logger.error(`${what} stopped (${(e as Error).name ?? 'Error'})`);
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
