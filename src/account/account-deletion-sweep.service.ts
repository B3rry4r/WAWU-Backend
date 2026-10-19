import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AccountPurgeService } from '../account-purge/account-purge.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PointsService } from '../points/points.service';
import {
  FREEZING_STALE_MS,
  PASS_BATCH,
  PASS_BUDGET_MS,
  PASS_CLAIM_LEASE_MS,
  PASS_OUTAGE_FAILURES,
} from './account-deletion-config';
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
  /** Rows in force, or cancelled and not yet confirmed, whose wallet the provider confirmed. */
  reconciled: number;
  /**
   * Why the pass stopped before every row was asked (round 7): `budget` (it ran
   * out of time) or `outage` (the provider failed several times in a row). The
   * rows it did not reach are asked first by the next pass. Null: it finished.
   */
  stopped: 'budget' | 'outage' | null;
}

/** What a pass may spend, and what it has seen (round 7). */
export interface PassLimits {
  budgetMs?: number;
  outageAfter?: number;
  batch?: number;
}

/** A pass's clock and its count of provider failures in a row. */
class PassGuard {
  private readonly startedAt = Date.now();
  private failures = 0;
  stopped: 'budget' | 'outage' | null = null;

  constructor(
    private readonly budgetMs: number,
    private readonly outageAfter: number,
  ) {}

  /** True once no further row should be asked. */
  halt(): boolean {
    if (this.stopped) return true;
    if (Date.now() - this.startedAt >= this.budgetMs) this.stopped = 'budget';
    else if (this.failures >= this.outageAfter) this.stopped = 'outage';
    return this.stopped !== null;
  }

  /** The provider failed (true) or answered (false) on the last row. */
  saw(unreachable: boolean): void {
    this.failures = unreachable ? this.failures + 1 : 0;
  }
}

const RECONCILE_MAX = 5000;

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
 * Round 5 (R-1 wallet safety): the wallet always follows the row. Every
 * account the pass looks at ends with `reconcileWallet` (frozen while a
 * deletion is in force or done, unfrozen when cancelled or dropped), and the
 * purge freezes the wallet BEFORE it reads the balance for the last time (a
 * wallet it cannot freeze keeps the account, `provider_unreachable`).
 *
 * Round 6: after the due ones the pass reconciles EVERY row in `freezing`,
 * `scheduled` or `purging` whatever its age, and every `cancelled` row until
 * one reconcile was confirmed for it (`walletSyncedAt`), so an answer lost to
 * a cancel, a repeat request or a provider fault is put right within the hour
 * however long the outage was, and a cancelled row that is confirmed costs no
 * provider call per hour. Nothing is held while the provider answers: no
 * transaction, no pooled connection, no lock.
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

  /** The cron entry: one pass at a time in this process (round 7, verifier R6-2). */
  private running = false;

  @Cron(CronExpression.EVERY_HOUR, { name: 'account-deletion-purge' })
  async sweep(): Promise<void> {
    if (this.running) {
      this.logger.warn(
        'Account deletion sweep: the last pass is still running; this hour is skipped',
      );
      return;
    }
    this.running = true;
    try {
      const r = await this.runOnce();
      if (r.purged + r.blocked + r.identityPending + r.unfrozen > 0) {
        this.logger.log(
          `Account deletions: ${r.purged} purged, ${r.blocked} kept for money or points, ${r.identityPending} waiting for WAWU ID, ${r.unfrozen} wallets let go, ${r.reconciled} wallets checked against their row`,
        );
      }
      if (r.stopped) {
        this.logger.warn(
          r.stopped === 'outage'
            ? `Account deletion sweep stopped early: the wallet provider failed ${PASS_OUTAGE_FAILURES} times in a row. The rows it did not reach are asked first next pass`
            : `Account deletion sweep stopped early: it used its ${Math.round(PASS_BUDGET_MS / 60000)} minutes. The rows it did not reach are asked first next pass`,
        );
      }
    } catch (e) {
      this.logger.error(
        `Account deletion sweep failed: ${(e as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  async runOnce(
    now: Date = new Date(),
    limit = 20,
    limits: PassLimits = {},
  ): Promise<DeletionSweepResult> {
    const result: DeletionSweepResult = {
      purged: 0,
      blocked: 0,
      identityPending: 0,
      unfrozen: 0,
      reconciled: 0,
      stopped: null,
    };
    const guard = new PassGuard(
      limits.budgetMs ?? PASS_BUDGET_MS,
      limits.outageAfter ?? PASS_OUTAGE_FAILURES,
    );
    const batch = limits.batch ?? PASS_BATCH;
    // Rows claimed before this moment are free to claim; rows this pass has
    // finished with carry a later time, so it never takes one twice.
    const passStart = new Date();
    // Accounts this pass has already reconciled (their last step did it).
    const done = new Set<string>();
    // A request that died after freezing leaves its wallet frozen; let it go.
    // Never stops the purge below.
    try {
      result.unfrozen = await this.releaseStaleFreezing(
        now,
        limit,
        done,
        guard,
      );
    } catch (e) {
      this.logger.error(
        `Letting go of stranded wallets stopped: ${(e as Error).message}`,
      );
    }
    // Due ones, and the ones an earlier pass claimed but could not finish
    // (WAWU ID down, a table that would not clear): those carry on. Claimed
    // first (round 7), so a second server's pass leaves them to this one.
    try {
      const lease = this.leaseEnd();
      const due = await this.claimDue(now, limit, passStart, lease);
      const finished: string[] = [];
      try {
        for (const row of due) {
          if (guard.halt()) break;
          done.add(row.wawuUserId);
          finished.push(row.wawuUserId);
          try {
            const outcome = await this.purgeOne(row, now, guard);
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
      } finally {
        await this.release(finished, lease, true);
        await this.release(
          due.map((d) => d.wawuUserId).filter((id) => !finished.includes(id)),
          lease,
          false,
        );
      }
    } catch (e) {
      this.logger.error(
        `Taking due deletions stopped: ${(e as Error).message}`,
      );
    }
    // Every row that can owe its wallet a change: the wallet follows the row.
    try {
      result.reconciled = await this.reconcileOwed(
        done,
        passStart,
        batch,
        guard,
      );
    } catch (e) {
      this.logger.error(
        `Reconciling deletions stopped: ${(e as Error).message}`,
      );
    }
    result.stopped = guard.stopped;
    return result;
  }

  private leaseEnd(): Date {
    return new Date(Date.now() + PASS_CLAIM_LEASE_MS);
  }

  /**
   * Takes the due and purging rows nobody holds (oldest check first, then
   * oldest due date): one statement, so no lock or transaction is held
   * afterwards. `SKIP LOCKED` keeps two servers off the same row.
   */
  private async claimDue(
    now: Date,
    take: number,
    passStart: Date,
    lease: Date,
  ): Promise<DueDeletion[]> {
    const rows = await this.prisma.$queryRaw<
      (DueDeletion & { purgeAfter: Date; prev: Date | null })[]
    >`
      WITH picked AS (
        SELECT "wawuUserId", "reconcileClaimedUntil" AS "prev" FROM "AccountDeletion"
        WHERE (("status" = 'scheduled' AND "purgeAfter" <= ${now}) OR "status" = 'purging')
          AND ("reconcileClaimedUntil" IS NULL OR "reconcileClaimedUntil" < ${passStart})
        ORDER BY "reconcileClaimedUntil" ASC NULLS FIRST, "purgeAfter" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "AccountDeletion" a SET "reconcileClaimedUntil" = ${lease}
      FROM picked p WHERE a."wawuUserId" = p."wawuUserId"
      RETURNING a."wawuUserId", a."purgeAttempts", a."status", a."purgeAfter", p."prev"`;
    // RETURNING has no order of its own: oldest check first, then oldest due.
    return rows.sort(
      (x, y) =>
        (x.prev?.getTime() ?? -Infinity) - (y.prev?.getTime() ?? -Infinity) ||
        x.purgeAfter.getTime() - y.purgeAfter.getTime(),
    );
  }

  /** Takes the rows that can owe their wallet a change, oldest check first. */
  private async claimOwed(
    take: number,
    passStart: Date,
    lease: Date,
  ): Promise<{ wawuUserId: string }[]> {
    const rows = await this.prisma.$queryRaw<
      { wawuUserId: string; prev: Date | null }[]
    >`
      WITH picked AS (
        SELECT "wawuUserId", "reconcileClaimedUntil" AS "prev" FROM "AccountDeletion"
        WHERE ("status" IN ('freezing', 'scheduled', 'purging')
               OR ("status" = 'cancelled' AND "walletSyncedAt" IS NULL))
          AND ("reconcileClaimedUntil" IS NULL OR "reconcileClaimedUntil" < ${passStart})
        ORDER BY "reconcileClaimedUntil" ASC NULLS FIRST, "wawuUserId" ASC
        LIMIT ${take}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "AccountDeletion" a SET "reconcileClaimedUntil" = ${lease}
      FROM picked p WHERE a."wawuUserId" = p."wawuUserId"
      RETURNING a."wawuUserId", p."prev"`;
    return rows.sort(
      (x, y) =>
        (x.prev?.getTime() ?? -Infinity) - (y.prev?.getTime() ?? -Infinity) ||
        (x.wawuUserId < y.wawuUserId
          ? -1
          : x.wawuUserId > y.wawuUserId
            ? 1
            : 0),
    );
  }

  /**
   * Lets go of rows this pass claimed: asked (`checked`: the time is now, so
   * the next pass takes them last) or not reached (null, so the next pass takes
   * them first). Only the claim this pass made, and without touching
   * `updatedAt`, which a `freezing` row's age is measured from.
   */
  private async release(
    ids: string[],
    lease: Date,
    checked: boolean,
  ): Promise<void> {
    if (ids.length === 0) return;
    const stamp = checked ? new Date() : null;
    try {
      await this.prisma.$executeRaw`
        UPDATE "AccountDeletion" SET "reconcileClaimedUntil" = ${stamp}
        WHERE "wawuUserId" = ANY(${ids}) AND "reconcileClaimedUntil" = ${lease}`;
    } catch (e) {
      this.logger.error(
        `Could not let go of ${ids.length} claimed deletion row(s): ${(e as Error).message}`,
      );
    }
  }

  /**
   * Round 5 (verifier R4-1, R4-5), widened in round 6 (verifier R5-2): the net
   * under every other step. Every row that can owe its wallet a change has the
   * wallet driven to match it, so a freeze or unfreeze that was lost, landed
   * late or was refused is put right by the next hourly pass at the latest,
   * however old the row is:
   *
   *  - a row in force (`freezing`, `scheduled`, `purging`) is always looked
   *    at: a late unfreeze can land at any time in the 30 days;
   *  - a `cancelled` row is looked at until a reconcile was confirmed for it
   *    (`walletSyncedAt`). A cancel that confirmed sets the mark at once, so a
   *    cancelled row costs no provider call per hour; a reconcile that could
   *    not be confirmed leaves it (or puts it back) unset.
   *
   * Round 7 (verifier R6-2, R6-3): rows are claimed a batch at a time (a second
   * server's pass skips the rows this one holds), the oldest check first (so a
   * budget or the cap never starves the same rows), and the pass stops when its
   * time budget is used or the provider has failed several times in a row (the
   * claimed rows it did not reach are let go as not asked, so the next pass
   * takes them first).
   *
   * Returns how many wallets the provider confirmed.
   */
  private async reconcileOwed(
    done: Set<string>,
    passStart: Date,
    batch: number,
    guard: PassGuard,
  ): Promise<number> {
    let confirmed = 0;
    let seen = 0;
    while (seen < RECONCILE_MAX && !guard.halt()) {
      const lease = this.leaseEnd();
      const rows = await this.claimOwed(batch, passStart, lease);
      if (rows.length === 0) return confirmed;
      const finished: string[] = [];
      try {
        for (const { wawuUserId } of rows) {
          if (guard.halt()) break;
          finished.push(wawuUserId);
          if (done.has(wawuUserId)) continue;
          done.add(wawuUserId);
          const r = await this.money.reconcileWallet(wawuUserId);
          guard.saw(r.failed);
          if (r.done) confirmed += 1;
        }
      } finally {
        await this.release(finished, lease, true);
        await this.release(
          rows.map((r) => r.wawuUserId).filter((id) => !finished.includes(id)),
          lease,
          false,
        );
      }
      seen += rows.length;
    }
    if (seen >= RECONCILE_MAX) {
      this.logger.warn(
        `Reconciling deletions stopped at ${RECONCILE_MAX} rows; the rest wait for the next pass`,
      );
    }
    return confirmed;
  }

  /**
   * Round 3 (verifier R2-1): `freezing` rows nobody retried. Returns how many
   * wallets were let go and rows closed.
   */
  private async releaseStaleFreezing(
    now: Date,
    limit: number,
    done: Set<string>,
    guard: PassGuard,
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
      if (guard.halt()) break;
      done.add(row.wawuUserId);
      try {
        if (await this.releaseOne(row, now, cutoff)) released += 1;
        guard.saw(false);
      } catch (e) {
        // The provider did not answer: the row stays, the next pass asks again.
        guard.saw(true);
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
    let removed = false;
    try {
      try {
        if (row.walletId) await this.money.unfreeze(row.walletId);
      } catch (e) {
        failure = e instanceof Error ? e : new Error(String(e));
      }
      // Only the row we took: a request that took it over meanwhile has
      // touched it, and its row is its own. Not removed while the unfreeze is
      // unanswered.
      if (!failure) {
        // Never deleted (round 7, verifier R6-1): a freeze that lands after
        // this unfreeze must still find a row to be undone by. Cancelled and
        // not yet confirmed, it is looked at by the pass until a reconcile
        // confirmed the wallet.
        const gone = await this.prisma.accountDeletion.updateMany({
          where: { wawuUserId: id, status: 'freezing', updatedAt: now },
          data: {
            status: 'cancelled',
            cancelledAt: new Date(),
            walletFrozenAt: null,
            walletSyncedAt: null,
          },
        });
        removed = gone.count === 1;
      }
    } finally {
      // Round 5: the wallet follows the row as it is now. The row gone (or
      // taken over and cancelled): unfrozen. A request that took it over and
      // is in force: frozen. Our row kept because the unfreeze was not
      // answered: still `freezing`, so frozen, and the next pass tries again.
      if (row.walletId) {
        await this.money.reconcileWallet(id, {
          walletId: row.walletId,
          provider: row.walletProvider,
        });
      }
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
    guard: PassGuard,
  ): Promise<'purged' | 'blocked' | 'identityPending' | 'skipped'> {
    try {
      return await this.purgeSteps(row, now, guard);
    } finally {
      // Whatever the steps did (purged, kept, a cancel won, WAWU ID did not
      // answer), the wallet ends as the row says: frozen for a purging or
      // purged one, unfrozen for one a cancel took (round 5, R4-2).
      const r = await this.money.reconcileWallet(row.wawuUserId);
      guard.saw(r.failed);
    }
  }

  private async purgeSteps(
    row: DueDeletion,
    now: Date,
    guard: PassGuard,
  ): Promise<'purged' | 'blocked' | 'identityPending' | 'skipped'> {
    const id = row.wawuUserId;

    if (row.status === 'scheduled') {
      // Freeze first, then read the balance (round 5, R4-2): a wallet that is
      // not frozen yet (a lost answer, a double fault) must not be purged
      // behind, and money that arrives before the freeze is seen below. A
      // wallet this server cannot freeze keeps the account for the next pass.
      const frozen = await this.money.reconcileWallet(id);
      guard.saw(frozen.failed);
      if (frozen.failed) {
        await this.blocked(row, now, 'provider_unreachable');
        return 'blocked';
      }
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
