import { Inject, Injectable, Logger } from '@nestjs/common';
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

const CONTENT_STATUSES: ReadonlySet<string> = new Set(
  Object.values(ContentStatus),
);

/**
 * Deleting an account, and cancelling it (tasks SETTINGS-06 and SETTINGS-08,
 * R-17). Account has no Prisma model of its own (registry.json fields: []);
 * `AccountDeletion` records the 30-day wait.
 *
 * Asking to delete:
 *  1. Refused (`409 account_deletion_blocked`) while the wallet holds money, a
 *     hold is open or earnings are waiting (Z6, R-11, R-19).
 *  2. The person's wallet is frozen at the provider: it can neither send nor
 *     receive for the 30 days (G-10: money due to it waits in WAWU's account
 *     and is paid on unfreeze, as the hold and earning sweeps already do).
 *  3. Their content is hidden (status `removed`), and which pieces were hidden
 *     is remembered, so a cancel puts back those and no others.
 *  4. Phone push stops (INBOX-03), and WAWU ID starts its own grace period.
 *
 * Cancelling does the reverse, in the order that cannot lose anything: the
 * wallet first (if the provider does not answer, nothing else changed and the
 * caller tries again), then content, push and the record.
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
    const existing = await this.prisma.accountDeletion.findUnique({
      where: { wawuUserId },
    });
    // Asked again while one is waiting: the money was settled and the wallet
    // frozen the first time, and the date does not move. The steps below that
    // hide content and stop push run again (a piece made since is hidden too,
    // and a first call that stopped halfway is finished), and WAWU ID is told
    // once more (its first call may be the one that failed).
    const already = existing?.status === 'scheduled' ? existing : null;

    const scheduledAt = new Date();
    let purgeAfter = new Date(scheduledAt.getTime() + DELETION_GRACE_MS);
    let wallet: { walletId: string; provider: string } | null = null;
    let frozen = false;
    if (already) {
      purgeAfter = already.purgeAfter;
    } else {
      const check = await this.money.check(wawuUserId);
      if (check.blockers.length > 0) {
        throw new AccountDeletionBlockedError(check);
      }
      wallet = check.wallet;
      // Freeze first, then look at the balance once more: money that arrived
      // between the look and the freeze is caught here, and nothing can
      // arrive after it.
      if (wallet) {
        frozen = (await this.money.freeze(wallet.walletId)).done;
        if (frozen) {
          const after = await this.money.balanceOf(wallet.walletId);
          if (after > 0) {
            // Let the wallet go again before refusing. If the provider does
            // not answer that, the person is told to try again (503) and the
            // wallet stays frozen: the error is logged with the account id.
            try {
              await this.money.unfreeze(wallet.walletId);
            } catch (error) {
              this.logger.error(
                `The wallet of ${wawuUserId} is frozen and could not be unfrozen after money arrived: ${(error as Error).message}`,
              );
              throw error;
            }
            throw new AccountDeletionBlockedError({
              ...check,
              blockers: ['wallet_balance'],
              balanceKobo: after,
            });
          }
        }
      }
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        if (!already) {
          const frozenFields = {
            walletId: frozen ? wallet!.walletId : null,
            walletProvider: frozen ? wallet!.provider : null,
            walletFrozenAt: frozen ? scheduledAt : null,
          };
          await tx.accountDeletion.upsert({
            where: { wawuUserId },
            create: { wawuUserId, scheduledAt, purgeAfter, ...frozenFields },
            update: {
              status: 'scheduled',
              scheduledAt,
              purgeAfter,
              ...frozenFields,
              cancelledAt: null,
              purgedAt: null,
              purgeBlockedAt: null,
              purgeBlockedBy: null,
              purgeAttempts: 0,
            },
          });
        }
        // Hide the content, and remember which pieces and what each was, so
        // a cancel restores exactly these.
        const pieces = await tx.contentPiece.findMany({
          where: { creatorWawuId: wawuUserId, status: { not: 'removed' } },
          select: { id: true, status: true },
        });
        if (pieces.length > 0) {
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
      });
    } catch (e) {
      // Nothing was recorded: do not leave the wallet frozen for a deletion
      // that is not scheduled.
      if (frozen) await this.unfreezeQuietly(wawuUserId, wallet!.walletId);
      throw e;
    }

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
    return { deletionScheduledAt: purgeAfter.toISOString() };
  }

  /**
   * Cancels a scheduled deletion (SETTINGS-08 calls it when the person signs
   * in during the 30 days). Idempotent: with nothing scheduled it changes
   * nothing and answers `cancelled: false`.
   */
  async cancelDeletion(wawuUserId: string): Promise<CancelDeletionResponseDto> {
    const row = await this.prisma.accountDeletion.findUnique({
      where: { wawuUserId },
    });
    if (!row || row.status !== 'scheduled') {
      return { cancelled: false, walletUnfrozen: false, contentRestored: 0 };
    }

    // The wallet first: if the provider does not answer, nothing else has
    // changed and the same call can be made again.
    let walletUnfrozen = false;
    if (row.walletFrozenAt && row.walletId) {
      walletUnfrozen = (await this.money.unfreeze(row.walletId)).done;
    }

    let contentRestored = 0;
    await this.prisma.$transaction(async (tx) => {
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
      await tx.accountDeletion.update({
        where: { wawuUserId },
        data: {
          status: 'cancelled',
          cancelledAt: new Date(),
          walletFrozenAt: null,
        },
      });
    });
    this.logger.log(
      `Deletion cancelled for ${wawuUserId}: wallet unfrozen ${walletUnfrozen}, ${contentRestored} content piece(s) back`,
    );
    return { cancelled: true, walletUnfrozen, contentRestored };
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

  private async unfreezeQuietly(
    wawuUserId: string,
    walletId: string,
  ): Promise<void> {
    try {
      await this.money.unfreeze(walletId);
    } catch (error) {
      this.logger.error(
        `Could not unfreeze the wallet of ${wawuUserId} after a refused deletion: ${(error as Error).message}. It stays frozen until the person asks again or cancels.`,
      );
    }
  }
}
