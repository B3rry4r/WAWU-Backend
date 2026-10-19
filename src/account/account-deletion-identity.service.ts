import { Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  IDENTITY_CLAIM_LEASE_MS,
  IDENTITY_RETRY_BATCH,
  identityRetryDelayMs,
} from './account-deletion-config';
import {
  WAWU_ID_ACCOUNT_GATEWAY,
  type WawuIdAccountGateway,
} from './wawu-id-account.gateway';

/** What one pass of asking WAWU ID did, for the log and the specs. */
export interface IdentityRetryResult {
  /** Rows WAWU ID was asked about. */
  asked: number;
  /** Of those, the rows WAWU ID confirmed. */
  confirmed: number;
  /** Of those, the rows it did not (they wait, with a longer wait each time). */
  failed: number;
  /** The pass stopped asking because WAWU ID failed several times in a row. */
  outage: boolean;
}

/**
 * Telling WAWU ID that a deletion has started, until it confirms
 * (SETTINGS-08, G-SETTINGS-08-1; R-17).
 *
 * WAWU ID cancels a deletion when the person signs in during the 30 days, but
 * only if it knows the deletion is pending. So the Hub's mark-deletion call
 * carries the Hub's own `purgeAfter` and is asked again until WAWU ID answers
 * ok; `AccountDeletion.identityMarkedAt` records the answer, and the purge
 * does not start while it is null (the sweep checks, and so does the claim).
 *
 * The request that schedules a deletion makes the first call. A call that
 * fails leaves `identityMarkedAt` null, counts the failure, and sets the
 * earliest the next try (`identityMarkNextAt`, doubling from a few minutes up
 * to hours); the hourly sweep calls `retryDue`. A repeat request from the
 * person calls again at once. The call is idempotent at WAWU ID.
 *
 * Nothing is held across a call: no transaction, connection or lock. The
 * outcome is recorded afterwards in one conditional update that names the
 * deletion by its `purgeAfter` (it identifies the request), so an answer to a
 * call made for an earlier deletion never confirms a later one.
 */
@Injectable()
export class AccountDeletionIdentityService {
  private readonly logger = new Logger(AccountDeletionIdentityService.name);

  constructor(
    @Inject(WAWU_ID_ACCOUNT_GATEWAY)
    private readonly gateway: WawuIdAccountGateway,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * One mark-deletion call, carrying the deletion's `purgeAfter`, and the
   * outcome recorded. True: WAWU ID answered ok. Never throws: the Hub's own
   * record of the deletion stands whatever WAWU ID does.
   */
  async tell(wawuUserId: string, purgeAfter: Date): Promise<boolean> {
    try {
      await this.gateway.scheduleAccountDeletion(wawuUserId, purgeAfter);
    } catch (error) {
      this.logger.error(
        `WAWU ID account deletion orchestration failed for ${wawuUserId}: ${(error as Error).message}. The Hub asks again; it does not purge until WAWU ID confirms`,
      );
      await this.recordFailure(wawuUserId, purgeAfter);
      return false;
    }
    await this.recordConfirmed(wawuUserId, purgeAfter);
    return true;
  }

  /**
   * Asks WAWU ID about every deletion in force that it has not confirmed and
   * whose wait is over, due ones first. Stops after `outageAfter` failures in
   * a row (WAWU ID is down: no point spending a timeout on every row).
   */
  async retryDue(
    now: Date = new Date(),
    limit: number = IDENTITY_RETRY_BATCH,
    outageAfter = 3,
  ): Promise<IdentityRetryResult> {
    const result: IdentityRetryResult = {
      asked: 0,
      confirmed: 0,
      failed: 0,
      outage: false,
    };
    const rows = await this.prisma.accountDeletion.findMany({
      where: {
        status: { in: ['scheduled', 'purging'] },
        identityMarkedAt: null,
        OR: [
          { identityMarkNextAt: null },
          { identityMarkNextAt: { lte: now } },
        ],
      },
      orderBy: [
        { identityMarkNextAt: { sort: 'asc', nulls: 'first' } },
        { purgeAfter: 'asc' },
      ],
      take: limit,
      select: { wawuUserId: true, purgeAfter: true },
    });
    let inARow = 0;
    for (const row of rows) {
      if (inARow >= outageAfter) {
        result.outage = true;
        break;
      }
      // Hold the row for a few minutes: a second server's pass leaves it
      // alone, and a crash here is only a delay. Only a row still waiting and
      // unconfirmed is held.
      const held = await this.prisma.accountDeletion.updateMany({
        where: {
          wawuUserId: row.wawuUserId,
          purgeAfter: row.purgeAfter,
          status: { in: ['scheduled', 'purging'] },
          identityMarkedAt: null,
          OR: [
            { identityMarkNextAt: null },
            { identityMarkNextAt: { lte: now } },
          ],
        },
        data: {
          identityMarkNextAt: new Date(Date.now() + IDENTITY_CLAIM_LEASE_MS),
        },
      });
      if (held.count !== 1) continue;
      result.asked += 1;
      if (await this.tell(row.wawuUserId, row.purgeAfter)) {
        result.confirmed += 1;
        inARow = 0;
      } else {
        result.failed += 1;
        inARow += 1;
      }
    }
    return result;
  }

  /** WAWU ID confirmed: only the deletion this call was made for, and only once. */
  private async recordConfirmed(
    wawuUserId: string,
    purgeAfter: Date,
  ): Promise<void> {
    try {
      await this.prisma.accountDeletion.updateMany({
        where: {
          wawuUserId,
          purgeAfter,
          status: { in: ['scheduled', 'purging'] },
          identityMarkedAt: null,
        },
        data: {
          identityMarkedAt: new Date(),
          identityMarkAttempts: 0,
          identityMarkNextAt: null,
        },
      });
    } catch (error) {
      // Unrecorded, so the next pass asks again (idempotent at WAWU ID).
      this.logger.error(
        `WAWU ID confirmed the deletion of ${wawuUserId} but the Hub could not record it: ${(error as Error).message}`,
      );
    }
  }

  /** WAWU ID did not confirm: count it and set when to try again. */
  private async recordFailure(
    wawuUserId: string,
    purgeAfter: Date,
  ): Promise<void> {
    try {
      const where = {
        wawuUserId,
        purgeAfter,
        status: { in: ['scheduled', 'purging'] },
        identityMarkedAt: null,
      };
      const row = await this.prisma.accountDeletion.findFirst({
        where,
        select: { identityMarkAttempts: true },
      });
      if (!row) return;
      const failures = row.identityMarkAttempts + 1;
      await this.prisma.accountDeletion.updateMany({
        where,
        data: {
          identityMarkAttempts: failures,
          identityMarkNextAt: new Date(
            Date.now() + identityRetryDelayMs(failures),
          ),
        },
      });
    } catch (error) {
      this.logger.error(
        `Could not record that WAWU ID did not confirm the deletion of ${wawuUserId}: ${(error as Error).message}`,
      );
    }
  }
}
