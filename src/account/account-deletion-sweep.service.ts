import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AccountPurgeService } from '../account-purge/account-purge.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PointsService } from '../points/points.service';
import { FREEZING_STALE_MS } from './account-deletion-config';
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
  /** A stranded `freezing` row: the wallet was let go and the row removed. */
  unfrozen: number;
}

type DueDeletion = {
  wawuUserId: string;
  purgeAttempts: number;
  status: string;
};

/**
 * The end of the 30 days (task SETTINGS-06, R-17). Hourly, it takes each
 * scheduled deletion whose time has come and:
 *
 *  1. Looks at the money once more. A balance, an open hold or a waiting
 *     earning that appeared during the 30 days keeps the account: nothing is
 *     deleted, `purgeBlockedBy` says why, and the next pass looks again. The
 *     wallet is frozen, so little should arrive; this is the net under it.
 *  2. Claims the row (`scheduled` to `purging`, one conditional update). From
 *     here a cancel is refused, because data is about to go; if a cancel got
 *     there first, the claim finds nothing and the pass leaves the account
 *     alone. Nothing is deleted before the claim.
 *  3. Releases the points still held for an AI job (a cash-out in flight is a
 *     blocker above), so the points purge never meets a held hold
 *     (POINTS-01 lead note).
 *  4. Deletes the Hub's data (AccountPurgeService, which starts with the
 *     points purge). Content a buyer paid for cannot be deleted, so it is
 *     hidden and stripped of the person's words, and the row's `purgeNote`
 *     says so. If any table could not be cleared the row stays `purging`
 *     with `purgeBlockedBy` naming it, and the next pass tries again. WAWU
 *     ID is not told before the Hub's side is done.
 *  5. Asks WAWU ID to anonymise the identity. If it does not answer, the row
 *     stays `purging` and the next pass picks it up again (the purge finds
 *     nothing to delete the second time). It is never marked cancelled.
 *  6. Marks the row `purged`, only if it is still `purging`. The row stays as
 *     the record that it ran.
 *
 * Before those, one more step (round 3): a `freezing` row older than
 * FREEZING_STALE_MS belongs to a request that died (its freeze answer was
 * lost, and the unfreeze right after failed too), so nobody will retry it and
 * its wallet would stay frozen for good. The sweep takes the row (touches
 * it, so a second server leaves it alone), lets the wallet go through the
 * wallet seam, and deletes the row only while it is still the row it took
 * and still `freezing`. If the provider does not answer the row stays and
 * the next pass tries again. A row naming another provider's wallet is left
 * as it is (a server acts only on its own provider's rows).
 *
 * Every write to the row names the status it expects. Every step is safe to
 * repeat, so two servers running the pass at once, or a pass that stopped
 * halfway, do no harm.
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
      if (r.purged + r.blocked + r.identityPending + r.unfrozen > 0) {
        this.logger.log(
          `Account deletions: ${r.purged} purged, ${r.blocked} kept for money or points, ${r.identityPending} waiting for WAWU ID, ${r.unfrozen} wallets let go`,
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
      unfrozen: 0,
    };
    // A request that died after freezing leaves its wallet frozen; let it go.
    // Never stops the purge below.
    try {
      result.unfrozen = await this.releaseStaleFreezing(now, limit);
    } catch (e) {
      this.logger.error(
        `Letting go of stranded wallets stopped: ${(e as Error).message}`,
      );
    }
    // Due ones, and the ones an earlier pass claimed but could not finish
    // (WAWU ID down, a table that would not clear): those carry on.
    const due = await this.prisma.accountDeletion.findMany({
      where: {
        OR: [
          { status: 'scheduled', purgeAfter: { lte: now } },
          { status: 'purging' },
        ],
      },
      orderBy: { purgeAfter: 'asc' },
      take: limit,
      select: { wawuUserId: true, purgeAttempts: true, status: true },
    });
    for (const row of due) {
      try {
        const outcome = await this.purgeOne(row, now);
        if (outcome !== 'skipped') result[outcome] += 1;
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

  /**
   * Round 3 (verifier R2-1): `freezing` rows nobody retried. Returns how many
   * wallets were let go and rows removed.
   */
  private async releaseStaleFreezing(
    now: Date,
    limit: number,
  ): Promise<number> {
    const cutoff = new Date(now.getTime() - FREEZING_STALE_MS);
    const stale = await this.prisma.accountDeletion.findMany({
      where: { status: 'freezing', updatedAt: { lte: cutoff } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
      select: { wawuUserId: true, walletId: true, walletProvider: true },
    });
    let released = 0;
    for (const row of stale) {
      try {
        if (await this.releaseOne(row, now, cutoff)) released += 1;
      } catch (e) {
        // The provider did not answer: the row stays, the next pass asks again.
        this.logger.error(
          `Wallet of ${row.wawuUserId} is still frozen by a deletion request that never finished (${(e as Error).message}); asking again next pass`,
        );
      }
    }
    return released;
  }

  private async releaseOne(
    row: {
      wawuUserId: string;
      walletId: string | null;
      walletProvider: string | null;
    },
    now: Date,
    cutoff: Date,
  ): Promise<boolean> {
    const id = row.wawuUserId;
    if (row.walletId && !this.money.holdsWalletOf(row.walletProvider)) {
      this.logger.warn(
        `A deletion request of ${id} left a wallet of another provider frozen; left for the server that runs it`,
      );
      return false;
    }
    // Take the row: touching it (while it is still stale and `freezing`)
    // keeps a second server's pass off it, and marks the version we hold.
    const taken = await this.prisma.accountDeletion.updateMany({
      where: { wawuUserId: id, status: 'freezing', updatedAt: { lte: cutoff } },
      data: { updatedAt: now },
    });
    if (taken.count !== 1) return false;
    let failure: Error | null = null;
    try {
      if (row.walletId) await this.money.unfreeze(row.walletId);
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    }
    // Only the row we took: a request that took it over meanwhile has touched
    // it, and its row is its own. Not removed while the unfreeze is unanswered.
    let removed = false;
    if (!failure) {
      const gone = await this.prisma.accountDeletion.deleteMany({
        where: { wawuUserId: id, status: 'freezing', updatedAt: now },
      });
      removed = gone.count === 1;
    }
    // Round 4 (verifier R3-2): the unfreeze may have landed after a request
    // froze the wallet for its own deletion; if one is in force now (or is
    // mid-way), freeze again. A row still ours (unanswered unfreeze, marked
    // with `now`) says nothing.
    if (row.walletId) {
      await this.money.holdIfDeleting(id, row.walletId, {
        includeFreezing: !failure,
        ownRowUpdatedAt: failure ? now : undefined,
      });
    }
    if (failure) throw failure;
    if (removed) {
      this.logger.log(
        `A deletion request of ${id} never finished; its wallet was let go and the request dropped`,
      );
    }
    return removed;
  }

  private async purgeOne(
    row: DueDeletion,
    now: Date,
  ): Promise<'purged' | 'blocked' | 'identityPending' | 'skipped'> {
    const id = row.wawuUserId;

    if (row.status === 'scheduled') {
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
      // The claim. A cancel that finished while the money was being looked at
      // has already changed the status, so this finds nothing and the account
      // is left exactly as the cancel made it.
      const claimed = await this.prisma.accountDeletion.updateMany({
        where: {
          wawuUserId: id,
          status: 'scheduled',
          purgeAfter: { lte: now },
        },
        data: { status: 'purging' },
      });
      if (claimed.count !== 1) {
        this.logger.log(
          `Deletion of ${id} changed before the purge started (cancelled); left alone`,
        );
        return 'skipped';
      }
      row = { ...row, status: 'purging' };
    }

    const held = await this.prisma.pointHold.findMany({
      where: { wawuUserId: id, state: 'held' },
      select: { id: true },
    });
    for (const h of held) await this.points.release({ holdId: h.id });

    const purged = await this.purgeService.purge(id);
    if (purged.pointsLeft || purged.failed.length > 0) {
      const by = purged.pointsLeft
        ? 'points'
        : `purge:${purged.failed.slice(0, 5).join(',')}`;
      this.logger.error(
        `Purge of ${id} is not complete (${by}); the account stays in purging and the next pass tries again`,
      );
      await this.blocked(row, now, by);
      return 'blocked';
    }

    // The Hub's side is done. Only now is WAWU ID asked to anonymise.
    try {
      await this.wawuId.finalizeAccountDeletion(id);
    } catch (e) {
      this.logger.error(
        `WAWU ID did not anonymise ${id} (the Hub's data is deleted; asking again next pass): ${(e as Error).message}`,
      );
      await this.blocked(row, now, 'identity_service');
      return 'identityPending';
    }

    await this.prisma.accountDeletion.updateMany({
      where: { wawuUserId: id, status: 'purging' },
      data: {
        status: 'purged',
        purgedAt: now,
        purgeBlockedAt: null,
        purgeBlockedBy: null,
        purgeNote:
          purged.keptForBuyers > 0
            ? `${purged.keptForBuyers} content piece(s) that buyers paid for were kept hidden and anonymised`
            : null,
      },
    });
    return 'purged';
  }

  /** Records why a pass left the account for later. Only while the row is still in the status the pass saw. */
  private async blocked(
    row: DueDeletion,
    now: Date,
    by: string,
  ): Promise<void> {
    const current = await this.prisma.accountDeletion.findUnique({
      where: { wawuUserId: row.wawuUserId },
      select: { purgeBlockedAt: true },
    });
    await this.prisma.accountDeletion.updateMany({
      where: {
        wawuUserId: row.wawuUserId,
        status: {
          in: row.status === 'purging' ? ['purging'] : ['scheduled', 'purging'],
        },
      },
      data: {
        purgeBlockedAt: current?.purgeBlockedAt ?? now,
        purgeBlockedBy: by,
        purgeAttempts: { increment: 1 },
      },
    });
  }
}
