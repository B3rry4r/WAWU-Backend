import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AccountPurgeService } from '../account-purge/account-purge.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PointsService } from '../points/points.service';
import {
  AccountDeletionMoneyService,
  type DeletionBlocker,
} from './account-deletion-money.service';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from './wawu-id-account.gateway';

/** What one pass did, for the log and the specs. */
export interface DeletionSweepResult {
  purged: number;
  /** Left for later: money, held points or the provider not answering. */
  blocked: number;
  /** The Hub's data is gone but WAWU ID did not answer; asked again next pass. */
  identityPending: number;
}

type DueDeletion = { wawuUserId: string; purgeAttempts: number };

/**
 * The end of the 30 days (task SETTINGS-06, R-17). Hourly, it takes each
 * scheduled deletion whose time has come and:
 *
 *  1. Looks at the money once more. A balance, an open hold or a waiting
 *     earning that appeared during the 30 days keeps the account: nothing is
 *     deleted, `purgeBlockedBy` says why, and the next pass looks again. The
 *     wallet is frozen, so little should arrive; this is the net under it.
 *  2. Releases the points still held for an AI job (a cash-out in flight is a
 *     blocker above), so the points purge never meets a held hold
 *     (POINTS-01 lead note).
 *  3. Deletes the Hub's data (AccountPurgeService, which starts with the
 *     points purge).
 *  4. Asks WAWU ID to anonymise the identity. If it does not answer, the Hub's
 *     data is already gone and the next pass asks again (the purge finds
 *     nothing to delete the second time).
 *  5. Marks the row `purged`. The row stays as the record that it ran.
 *
 * Every step is safe to repeat, so two servers running the pass at once, or
 * a pass that stopped halfway, do no harm.
 */
@Injectable()
export class AccountDeletionSweepService {
  private readonly logger = new Logger(AccountDeletionSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly money: AccountDeletionMoneyService,
    private readonly points: PointsService,
    private readonly purgeService: AccountPurgeService,
    @Inject(WAWU_ID_ACCOUNT_GATEWAY)
    private readonly wawuId: WawuIdAccountGateway,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'account-deletion-purge' })
  async sweep(): Promise<void> {
    try {
      const r = await this.runOnce();
      if (r.purged + r.blocked + r.identityPending > 0) {
        this.logger.log(
          `Account deletions: ${r.purged} purged, ${r.blocked} kept for money or points, ${r.identityPending} waiting for WAWU ID`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Account deletion sweep failed: ${(e as Error).message}`,
      );
    }
  }

  async runOnce(
    now: Date = new Date(),
    limit = 20,
  ): Promise<DeletionSweepResult> {
    const result: DeletionSweepResult = {
      purged: 0,
      blocked: 0,
      identityPending: 0,
    };
    const due = await this.prisma.accountDeletion.findMany({
      where: { status: 'scheduled', purgeAfter: { lte: now } },
      orderBy: { purgeAfter: 'asc' },
      take: limit,
      select: { wawuUserId: true, purgeAttempts: true },
    });
    for (const row of due) {
      try {
        const outcome = await this.purgeOne(row, now);
        result[outcome] += 1;
      } catch (e) {
        // One account never stops the rest.
        result.blocked += 1;
        await this.blocked(row, now, 'error');
        this.logger.error(
          `Purge of ${row.wawuUserId} stopped: ${(e as Error).message}`,
        );
      }
    }
    return result;
  }

  private async purgeOne(
    row: DueDeletion,
    now: Date,
  ): Promise<'purged' | 'blocked' | 'identityPending'> {
    const id = row.wawuUserId;

    let blockers: DeletionBlocker[];
    try {
      blockers = (await this.money.check(id)).blockers;
    } catch {
      await this.blocked(row, now, 'provider_unreachable');
      return 'blocked';
    }
    if (blockers.length > 0) {
      this.logger.warn(
        `Deletion of ${id} is due but money is still there (${blockers.join(', ')}); kept`,
      );
      await this.blocked(row, now, blockers.join(','));
      return 'blocked';
    }

    const held = await this.prisma.pointHold.findMany({
      where: { wawuUserId: id, state: 'held' },
      select: { id: true },
    });
    for (const h of held) await this.points.release({ holdId: h.id });

    const purged = await this.purgeService.purge(id);
    if (purged.pointsLeft) {
      await this.blocked(row, now, 'points');
      return 'blocked';
    }

    try {
      await this.wawuId.finalizeAccountDeletion(id);
    } catch (e) {
      this.logger.error(
        `WAWU ID did not anonymise ${id} (the Hub's data is deleted; asking again next pass): ${(e as Error).message}`,
      );
      await this.blocked(row, now, 'identity_service');
      return 'identityPending';
    }

    await this.prisma.accountDeletion.update({
      where: { wawuUserId: id },
      data: {
        status: 'purged',
        purgedAt: now,
        purgeBlockedAt: null,
        purgeBlockedBy: null,
      },
    });
    return 'purged';
  }

  private async blocked(
    row: DueDeletion,
    now: Date,
    by: string,
  ): Promise<void> {
    const current = await this.prisma.accountDeletion.findUnique({
      where: { wawuUserId: row.wawuUserId },
      select: { purgeBlockedAt: true },
    });
    await this.prisma.accountDeletion.update({
      where: { wawuUserId: row.wawuUserId },
      data: {
        purgeBlockedAt: current?.purgeBlockedAt ?? now,
        purgeBlockedBy: by,
        purgeAttempts: { increment: 1 },
      },
    });
  }
}
