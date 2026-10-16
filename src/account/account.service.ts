import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client';
import { ContentStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AccountDeletionResponse } from '../common/types';
import { PushTokenService } from '../push/push-token.service';
import { DELETION_GRACE_MS } from './account-deletion-config';
import {
  AccountDeletionBlockedError,
  AccountDeletionMoneyService,
} from './account-deletion-money.service';
import type { CancelDeletionResponseDto } from './dto/account-deletion.dto';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from './wawu-id-account.gateway';

/** What a cancel is told once the purge has started. No em-dash. */
export const DELETION_IN_PROGRESS_MESSAGE =
  'Your account is already being deleted, so it can no longer be restored.';

const IN_PROGRESS: CancelDeletionResponseDto = {
  cancelled: false,
  walletUnfrozen: false,
  contentRestored: 0,
  deletionInProgress: true,
  message: DELETION_IN_PROGRESS_MESSAGE,
};

/** What a request that lost its row to a cancel is told. No em-dash. */
const CHANGED_MESSAGE =
  'Something changed while we were setting this up. Nothing was scheduled. Try again.';

type Promoted = {
  outcome: 'scheduled' | 'purging' | 'lost';
  purgeAfter: Date;
};

const CONTENT_STATUSES: ReadonlySet<string> = new Set(
  Object.values(ContentStatus),
);

/**
 * Deleting an account, and cancelling it (tasks SETTINGS-06 and SETTINGS-08,
 * R-17). Account has no Prisma model of its own (registry.json fields: []);
 * `AccountDeletion` records the 30-day wait.
 *
 * A deletion row has a status, and every write to it names the status it
 * expects, so two requests (or a request and the sweep) can never undo each
 * other:
 *   freezing   asked; the wallet is being frozen. Not in force. The row is
 *              written BEFORE the freeze call, so an answer that is lost
 *              after the provider froze the wallet can always be undone:
 *              a cancel or a new request unfreezes it from this row.
 *   scheduled  in force for 30 days.
 *   purging    the sweep took it and is deleting. A cancel is refused.
 *   cancelled, purged: the end.
 *
 * Asking to delete:
 *  1. The money is looked at first (nothing is frozen yet): refused
 *     (`409 account_deletion_blocked`) while the wallet holds money, a hold
 *     is open or earnings are waiting (Z6, R-11, R-19).
 *  2. The row is recorded (`freezing`), then the person's wallet is frozen at
 *     the provider: it can neither send nor receive for the 30 days (G-10:
 *     money due to it waits in WAWU's account and is paid on unfreeze, as the
 *     hold and earning sweeps already do). The balance is read once more
 *     after the freeze, to catch money that arrived in between.
 *  3. The row becomes `scheduled` and their content is hidden (status
 *     `removed`) in one transaction; which pieces were hidden is remembered,
 *     so a cancel puts back those and no others.
 *  4. Phone push stops (INBOX-03), and WAWU ID starts its own grace period.
 * If anything fails after the freeze the wallet is let go again, unless a
 * deletion is in force by then (a request that got in after this one froze it
 * for its own 30 days). If the unfreeze fails too the `freezing` row stays so
 * a cancel or a retry can do it, and if nobody does, the hourly sweep lets the
 * wallet go once the row is older than FREEZING_STALE_MINUTES.
 *
 * Cancelling does the reverse, in the order that cannot lose anything: the
 * wallet first (if the provider does not answer, nothing else changed and the
 * caller tries again), then content, push and the record, under a lock on the
 * row. From `purging` on it is refused: it answers `cancelled: false` with
 * `deletionInProgress`, never "restored".
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @Inject(WAWU_ID_ACCOUNT_GATEWAY)
    private readonly wawuIdGateway: WawuIdAccountGateway,
    private readonly prisma: PrismaService,
    private readonly pushTokens: PushTokenService,
    private readonly money: AccountDeletionMoneyService,
  ) {}

  async deleteAccount(wawuUserId: string): Promise<AccountDeletionResponse> {
    let existing = await this.prisma.accountDeletion.findUnique({
      where: { wawuUserId },
    });
    // The sweep already took it: nothing is left to ask for. The answer is
    // the date it was due.
    if (existing?.status === 'purging') {
      return { deletionScheduledAt: existing.purgeAfter.toISOString() };
    }
    // A request that stopped after the freeze (the answer was lost, or the
    // unfreeze after a failure failed too) left the wallet frozen with this
    // row as the only record. Let it go before anything else, so a refusal
    // below leaves a wallet that works. If the provider does not answer, the
    // person is told to try again and the row stays.
    if (existing?.status === 'freezing') {
      if (existing.walletId) await this.money.unfreeze(existing.walletId);
      await this.prisma.accountDeletion.deleteMany({
        where: { wawuUserId, status: 'freezing' },
      });
      existing = null;
    }

    // Asked again while one is waiting: the money was settled and the wallet
    // frozen the first time, and the date does not move. The steps below that
    // hide content and stop push run again (a piece made since is hidden too,
    // and a first call that stopped halfway is finished), and WAWU ID is told
    // once more (its first call may be the one that failed).
    if (existing?.status === 'scheduled') {
      return this.finishScheduled(wawuUserId, existing.purgeAfter);
    }

    // Money first, with nothing frozen yet: a refusal changes nothing.
    const check = await this.money.check(wawuUserId);
    if (check.blockers.length > 0) {
      throw new AccountDeletionBlockedError(check);
    }
    const wallet = check.wallet;

    const scheduledAt = new Date();
    const purgeAfter = new Date(scheduledAt.getTime() + DELETION_GRACE_MS);
    const recorded = await this.record(wawuUserId, wallet, {
      scheduledAt,
      purgeAfter,
    });
    if (!recorded) {
      // Another request for the same account got in first and is in force.
      const now = await this.prisma.accountDeletion.findUnique({
        where: { wawuUserId },
      });
      if (now?.status === 'scheduled') {
        return this.finishScheduled(wawuUserId, now.purgeAfter);
      }
      if (now?.status === 'purging') {
        return { deletionScheduledAt: now.purgeAfter.toISOString() };
      }
      throw new ServiceUnavailableException(CHANGED_MESSAGE);
    }

    let promoted: Promoted;
    try {
      let frozen = false;
      if (wallet) {
        // Freeze first, then look at the balance once more: money that
        // arrived between the look and the freeze is caught here, and
        // nothing can arrive after it.
        frozen = (await this.money.freeze(wallet.walletId)).done;
        if (frozen) {
          const after = await this.money.balanceOf(wallet.walletId);
          if (after > 0) {
            throw new AccountDeletionBlockedError({
              ...check,
              blockers: ['wallet_balance'],
              balanceKobo: after,
            });
          }
        }
      }
      promoted = await this.promote(wawuUserId, {
        frozen,
        scheduledAt,
        purgeAfter,
      });
    } catch (e) {
      // Not scheduled: do not leave the wallet frozen. The freeze answer may
      // have been lost after the provider froze it, so the wallet is let go
      // whether or not the freeze looked done. If the provider does not
      // answer that, the `freezing` row stays: a cancel or a new request
      // lets it go.
      await this.abandon(
        wawuUserId,
        wallet,
        { scheduledAt, purgeAfter },
        e instanceof AccountDeletionBlockedError,
      );
      throw e;
    }

    if (promoted.outcome === 'lost') {
      // A cancel, or another request's failure, took the row while the
      // wallet was being frozen. The wallet may have been frozen after that:
      // let it go, and say nothing was scheduled.
      await this.abandon(
        wawuUserId,
        wallet,
        { scheduledAt, purgeAfter },
        false,
      );
      throw new ServiceUnavailableException(CHANGED_MESSAGE);
    }
    if (promoted.outcome === 'scheduled') {
      await this.stopPushAndTell(wawuUserId);
    }
    return { deletionScheduledAt: promoted.purgeAfter.toISOString() };
  }

  /**
   * Cancels a scheduled deletion (SETTINGS-08 calls it when the person signs
   * in during the 30 days). Idempotent: with nothing scheduled it changes
   * nothing and answers `cancelled: false`. Refused once the sweep has taken
   * the deletion (`deletionInProgress`): data may already be gone, so
   * "restored" would be a lie.
   */
  async cancelDeletion(wawuUserId: string): Promise<CancelDeletionResponseDto> {
    const row = await this.prisma.accountDeletion.findUnique({
      where: { wawuUserId },
    });
    if (row?.status === 'purging') return { ...IN_PROGRESS };
    if (!row || (row.status !== 'scheduled' && row.status !== 'freezing')) {
      return { cancelled: false, walletUnfrozen: false, contentRestored: 0 };
    }

    // The wallet first: if the provider does not answer, nothing else has
    // changed and the same call can be made again. A `freezing` row may have
    // a frozen wallet whose answer was lost, so it is let go too.
    let walletUnfrozen = false;
    const mayBeFrozen =
      row.walletId && (row.walletFrozenAt || row.status === 'freezing');
    if (mayBeFrozen) {
      walletUnfrozen = (await this.money.unfreeze(row.walletId!)).done;
    }

    let contentRestored = 0;
    let cancelled = false;
    await this.prisma.$transaction(async (tx) => {
      // The row is locked: the sweep's claim and a repeat request wait here,
      // and whoever comes after sees the status written below.
      const status = await this.lockRow(tx, wawuUserId);
      if (status !== 'scheduled' && status !== 'freezing') return;
      const hidden = await tx.accountDeletionContent.findMany({
        where: { wawuUserId },
      });
      for (const h of hidden) {
        if (!CONTENT_STATUSES.has(h.priorStatus)) continue;
        const { count } = await tx.contentPiece.updateMany({
          // Only a piece that is still `removed`: one that changed since is
          // left as it is.
          where: { id: h.contentPieceId, status: 'removed' },
          data: { status: h.priorStatus as ContentStatus },
        });
        contentRestored += count;
      }
      await tx.accountDeletionContent.deleteMany({ where: { wawuUserId } });
      await this.pushTokens.resumeAccount(wawuUserId, tx);
      const done = await tx.accountDeletion.updateMany({
        where: { wawuUserId, status },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          walletFrozenAt: null,
        },
      });
      cancelled = done.count === 1;
    });

    if (!cancelled) {
      // The sweep took the row between the look above and the lock. The
      // wallet was let go for nothing: freeze it again (it stays frozen
      // until the purge), and say the truth.
      const now = await this.prisma.accountDeletion.findUnique({
        where: { wawuUserId },
        select: { status: true },
      });
      if (now?.status === 'purging') {
        if (walletUnfrozen) {
          await this.refreeze(wawuUserId, row.walletId!);
        }
        return { ...IN_PROGRESS };
      }
      return { cancelled: false, walletUnfrozen: false, contentRestored: 0 };
    }
    this.logger.log(
      `Deletion cancelled for ${wawuUserId}: wallet unfrozen ${walletUnfrozen}, ${contentRestored} content piece(s) back`,
    );
    return { cancelled: true, walletUnfrozen, contentRestored };
  }

  /**
   * Writes the `freezing` row before the wallet is touched. Returns false
   * when a deletion is already in force for the account (another request got
   * in first), so the caller does not freeze or reschedule anything.
   */
  private async record(
    wawuUserId: string,
    wallet: { walletId: string; provider: string } | null,
    when: { scheduledAt: Date; purgeAfter: Date },
  ): Promise<boolean> {
    const fields = {
      scheduledAt: when.scheduledAt,
      purgeAfter: when.purgeAfter,
      walletId: wallet?.walletId ?? null,
      walletProvider: wallet?.provider ?? null,
      walletFrozenAt: null,
    };
    const created = await this.prisma.accountDeletion.createMany({
      data: { wawuUserId, status: 'freezing', ...fields },
      skipDuplicates: true,
    });
    if (created.count === 1) return true;
    // A row from an earlier deletion (cancelled or purged) or an earlier
    // request still freezing: take it over. A row in force is left alone.
    const taken = await this.prisma.accountDeletion.updateMany({
      where: {
        wawuUserId,
        status: { in: ['freezing', 'cancelled', 'purged'] },
      },
      data: {
        status: 'freezing',
        ...fields,
        cancelledAt: null,
        purgedAt: null,
        purgeBlockedAt: null,
        purgeBlockedBy: null,
        purgeAttempts: 0,
        purgeNote: null,
      },
    });
    return taken.count === 1;
  }

  /**
   * `freezing` to `scheduled` and the content hidden, in one transaction
   * under the row's lock. `lost`: the row is no longer ours (a cancel, or
   * another request's failure, took it), so nothing was hidden. `purging`:
   * the sweep has it; nothing to do.
   */
  private async promote(
    wawuUserId: string,
    f: { frozen: boolean; scheduledAt: Date; purgeAfter: Date },
  ): Promise<Promoted> {
    return this.prisma.$transaction(async (tx): Promise<Promoted> => {
      const status = await this.lockRow(tx, wawuUserId);
      if (status === 'freezing') {
        await tx.accountDeletion.updateMany({
          where: { wawuUserId, status: 'freezing' },
          data: {
            status: 'scheduled',
            scheduledAt: f.scheduledAt,
            purgeAfter: f.purgeAfter,
            walletFrozenAt: f.frozen ? f.scheduledAt : null,
          },
        });
        await this.hideContent(tx, wawuUserId);
        return { outcome: 'scheduled', purgeAfter: f.purgeAfter };
      }
      const row = await tx.accountDeletion.findUnique({
        where: { wawuUserId },
      });
      const purgeAfter = row?.purgeAfter ?? f.purgeAfter;
      if (status === 'scheduled') {
        // Another request promoted it first: this one only makes sure the
        // content is hidden, and the date is theirs.
        await this.hideContent(tx, wawuUserId);
        return { outcome: 'scheduled', purgeAfter };
      }
      if (status === 'purging') return { outcome: 'purging', purgeAfter };
      return { outcome: 'lost', purgeAfter };
    });
  }

  /** Repeat request on a scheduled deletion: the date stays, the steps run again. */
  private async finishScheduled(
    wawuUserId: string,
    purgeAfter: Date,
  ): Promise<AccountDeletionResponse> {
    const inForce = await this.prisma.$transaction(async (tx) => {
      // Under the lock, and only while the row is still scheduled: a cancel
      // that got in first has restored the content, and this must not hide
      // it again.
      const status = await this.lockRow(tx, wawuUserId);
      if (status !== 'scheduled') return false;
      await this.hideContent(tx, wawuUserId);
      return true;
    });
    if (inForce) await this.stopPushAndTell(wawuUserId);
    return { deletionScheduledAt: purgeAfter.toISOString() };
  }

  /** Hide the content, and remember which pieces and what each was, so a cancel restores exactly these. */
  private async hideContent(
    tx: Prisma.TransactionClient,
    wawuUserId: string,
  ): Promise<void> {
    const pieces = await tx.contentPiece.findMany({
      where: { creatorWawuId: wawuUserId, status: { not: 'removed' } },
      select: { id: true, status: true },
    });
    if (pieces.length === 0) return;
    await tx.accountDeletionContent.createMany({
      data: pieces.map((p) => ({
        wawuUserId,
        contentPieceId: p.id,
        priorStatus: p.status,
      })),
      skipDuplicates: true,
    });
    await tx.contentPiece.updateMany({
      where: { id: { in: pieces.map((p) => p.id) } },
      data: { status: 'removed' },
    });
    this.logger.log(
      `Hid ${pieces.length} content piece(s) for account ${wawuUserId} until its deletion is cancelled or runs`,
    );
  }

  /** Locks the person's deletion row and returns its status (null: none). */
  private async lockRow(
    tx: Prisma.TransactionClient,
    wawuUserId: string,
  ): Promise<string | null> {
    const rows = await tx.$queryRaw<
      { status: string }[]
    >`SELECT "status" FROM "AccountDeletion" WHERE "wawuUserId" = ${wawuUserId} FOR UPDATE`;
    return rows[0]?.status ?? null;
  }

  /**
   * Lets the wallet go after a request that will not be scheduled, and closes
   * its `freezing` row. The row goes first (one conditional delete), then the
   * wallet is let go, unless a deletion is in force by now: a request that got
   * in after this one froze the wallet for its own 30 days, and letting it go
   * would break that promise. If the provider does not answer the unfreeze,
   * the `freezing` row is put back (or written, if the request that failed
   * had none) so the hourly sweep, a cancel or a new request finishes the
   * job. `surface`: the person must be told to try again (503) instead of
   * what went wrong, because the wallet stays frozen; otherwise the caller
   * rethrows its own error.
   */
  private async abandon(
    wawuUserId: string,
    wallet: { walletId: string; provider: string } | null,
    when: { scheduledAt: Date; purgeAfter: Date },
    surface: boolean,
  ): Promise<void> {
    await this.prisma.accountDeletion.deleteMany({
      where: { wawuUserId, status: 'freezing' },
    });
    if (!wallet) return;
    const inForce = await this.prisma.accountDeletion.findFirst({
      where: { wawuUserId, status: { in: ['scheduled', 'purging'] } },
      select: { wawuUserId: true },
    });
    if (inForce) return;
    try {
      await this.money.unfreeze(wallet.walletId);
    } catch (error) {
      this.logger.error(
        `The wallet of ${wawuUserId} may be frozen and could not be unfrozen after a deletion request that did not go through: ${(error as Error).message}. The request is recorded (freezing); the hourly sweep, a cancel or a new request lets it go.`,
      );
      try {
        await this.record(wawuUserId, wallet, when);
      } catch (writeError) {
        this.logger.error(
          `Could not record the stranded wallet of ${wawuUserId}: ${(writeError as Error).message}`,
        );
      }
      if (surface) throw error;
    }
  }

  private async refreeze(wawuUserId: string, walletId: string): Promise<void> {
    try {
      await this.money.freeze(walletId);
    } catch (error) {
      this.logger.error(
        `Could not freeze the wallet of ${wawuUserId} again after a refused cancel: ${(error as Error).message}`,
      );
    }
  }

  private async stopPushAndTell(wawuUserId: string): Promise<void> {
    // INBOX-03 (lead ruling, 7 Oct 2026): no phone push to an account whose
    // deletion is scheduled. Its push tokens and queued pushes are deleted
    // now, a token it registers later is not stored, and the sender skips it.
    // Loud, not fatal.
    try {
      await this.pushTokens.stopAccount(wawuUserId);
    } catch (error) {
      this.logger.error(
        `Could not stop phone push for deleted account ${wawuUserId}: ${(error as Error).message}`,
      );
    }
    await this.tellWawuId(wawuUserId);
  }

  /** Starts (or restarts) WAWU ID's own grace period. Loud, not fatal. */
  private async tellWawuId(wawuUserId: string): Promise<void> {
    try {
      await this.wawuIdGateway.scheduleAccountDeletion(wawuUserId);
    } catch (error) {
      // Never silently swallow: log loudly. The Hub's own record of the
      // deletion stands even if WAWU ID's call fails, and asking again calls
      // WAWU ID again.
      this.logger.error(
        `WAWU ID account deletion orchestration failed for ${wawuUserId}: ${(error as Error).message}`,
      );
    }
  }
}
