import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../common/prisma/prisma.service';

/** What the reconciliation reports; see NuvionReconcileFinding in the schema. */
export type NuvionFindingKind =
  | 'fee_differs'
  | 'subscription_missing'
  | 'subscription_renewal_failed'
  | 'sweep_incomplete';

export interface NuvionFindingInput {
  kind: NuvionFindingKind;
  subject: string;
  /** Our own words and kobo figures: never a name, a number or Nuvion's text. */
  detail: string;
  settingKobo?: number | null;
  providerKobo?: number | null;
  amountKobo?: number | null;
}

/**
 * The reconciliation's report (task NUV-08): one row per (kind, subject),
 * seen again it is updated, no longer true it is resolved, and a later
 * sighting reopens it. A person at WAWU reads the open rows; the nightly
 * check (MONEY-16) is the reader to wire to them. Nothing here changes a
 * setting or moves money. Every report is also a log line at error level.
 */
export class NuvionReconcileFindings {
  private readonly logger = new Logger('NuvionReconcile');

  constructor(private readonly prisma: PrismaService) {}

  async report(f: NuvionFindingInput): Promise<void> {
    this.logger.error(`${f.kind} (${f.subject}): ${f.detail}`);
    const figures = {
      settingKobo:
        f.settingKobo === undefined || f.settingKobo === null
          ? null
          : BigInt(f.settingKobo),
      providerKobo:
        f.providerKobo === undefined || f.providerKobo === null
          ? null
          : BigInt(f.providerKobo),
      amountKobo:
        f.amountKobo === undefined || f.amountKobo === null
          ? null
          : BigInt(f.amountKobo),
    };
    const now = new Date();
    await this.prisma.nuvionReconcileFinding.upsert({
      where: { kind_subject: { kind: f.kind, subject: f.subject } },
      create: {
        kind: f.kind,
        subject: f.subject,
        detail: f.detail.slice(0, 1000),
        ...figures,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        detail: f.detail.slice(0, 1000),
        ...figures,
        lastSeenAt: now,
        seenCount: { increment: 1 },
        resolvedAt: null,
      },
    });
  }

  /** It is no longer true. A finding that was never reported is left alone. */
  async resolve(kind: NuvionFindingKind, subject: string): Promise<void> {
    await this.prisma.nuvionReconcileFinding.updateMany({
      where: { kind, subject, resolvedAt: null },
      data: { resolvedAt: new Date() },
    });
  }

  open() {
    return this.prisma.nuvionReconcileFinding.findMany({
      where: { resolvedAt: null },
      orderBy: { lastSeenAt: 'desc' },
    });
  }
}
