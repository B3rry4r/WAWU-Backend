import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { AccountDeletionResponse } from '../common/types';
import { PushTokenService } from '../push/push-token.service';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from './wawu-id-account.gateway';

/** 48h soft-deletion grace period, per registry.json's Account endpoint note. */
const GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;

/**
 * Account has no Prisma model (registry.json fields: [] -- see
 * prisma/schema.prisma header comment). DELETE /account acts directly on
 * the caller's wawuUserId: nothing local to write beyond the account's own
 * content (below), only the 48h grace period marker to compute and WAWU
 * ID's own account deletion to trigger.
 */
@Injectable()
export class AccountService {
  private readonly logger = new Logger(AccountService.name);

  constructor(
    @Inject(WAWU_ID_ACCOUNT_GATEWAY)
    private readonly wawuIdGateway: WawuIdAccountGateway,
    private readonly prisma: PrismaService,
    private readonly pushTokens: PushTokenService,
  ) {}

  async deleteAccount(wawuUserId: string): Promise<AccountDeletionResponse> {
    const deletionScheduledAt = new Date(
      Date.now() + GRACE_PERIOD_MS,
    ).toISOString();

    // This is the ONLY place a deleted account's content ever gets marked
    // `removed`. AccountPurgeService (hard-delete) is a separate facility with
    // no caller since the unpaid-account reaper was removed; it has nothing to
    // do with an ordinary "delete my account". Without this, ContentPieceService.findOne()
    // keeps serving every piece an account ever posted, live, forever, to
    // everyone, because it only checks `content.status` and has no idea the
    // creator behind it no longer exists. There is no cancel-deletion
    // endpoint anywhere in this backend, so marking it removed immediately
    // (rather than waiting out the 48h grace period WAWU ID applies to the
    // identity itself) has nothing to undo if there ever is one.
    try {
      const { count } = await this.prisma.contentPiece.updateMany({
        where: { creatorWawuId: wawuUserId, status: { not: 'removed' } },
        data: { status: 'removed' },
      });
      if (count > 0) {
        this.logger.log(
          `Removed ${count} content piece(s) for deleted account ${wawuUserId}`,
        );
      }
    } catch (error) {
      // Loud, not fatal: the account deletion itself must still proceed even
      // if this write fails, same reasoning as the WAWU ID call below.
      this.logger.error(
        `Could not remove content for deleted account ${wawuUserId}: ${(error as Error).message}`,
      );
    }

    // INBOX-03 (lead ruling, 7 Oct 2026): no phone push to an account whose
    // deletion is scheduled. Its push tokens and queued pushes are deleted
    // now, a token it registers later is not stored, and the sender skips it.
    // Loud, not fatal, like the content step above.
    try {
      await this.pushTokens.stopAccount(wawuUserId);
    } catch (error) {
      this.logger.error(
        `Could not stop phone push for deleted account ${wawuUserId}: ${(error as Error).message}`,
      );
    }

    try {
      await this.wawuIdGateway.scheduleAccountDeletion(wawuUserId);
    } catch (error) {
      // Never silently swallow: log loudly, but the 48h local grace-period
      // marker still stands even if WAWU ID's own deletion call fails --
      // the two are orchestrated separately per the registry note, and a
      // WAWU ID outage should not block this backend's own soft-deletion
      // clock from starting.
      this.logger.error(
        `WAWU ID account deletion orchestration failed for ${wawuUserId}: ${(error as Error).message}`,
      );
    }

    return { deletionScheduledAt };
  }
}
