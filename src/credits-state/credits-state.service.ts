import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreditsState } from '../common/types';

@Injectable()
export class CreditsStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the caller's CreditsState, lazily creating it on first read.
   * No other endpoint in this backend's contract creates a CreditsState row
   * (CreditPurchase.verify and CommunityMessage.create both mutate an
   * existing balance) so first-touch-creates here is the only sane place for
   * the row to originate.
   *
   * It used to open the row with a 7-day free trial. The product owner
   * removed the trial on 21 Sep 2026 ("no 7 day silly trials"), so a new row
   * starts at zero credits and `trialEndsAt` is never written.
   *
   * `trialEndsAt` is NULLABLE rather than dropped, and that is the finished
   * state of this change, not an unfinished one: during a rolling deploy an
   * older instance still selects the column, and dropping it out from under
   * that instance takes production down. Rows that already carry a date keep
   * it harmlessly. Its eventual removal is recorded where it belongs, in
   * prisma/migrations/20260921170000_remove_credits_trial/migration.sql.
   */
  async getOrCreate(userWawuId: string): Promise<CreditsState> {
    const existing = await this.prisma.creditsState.findUnique({
      where: { userWawuId },
    });
    if (existing) {
      return existing;
    }
    return this.prisma.creditsState.create({
      data: {
        userWawuId,
        creditBalance: 0,
      },
    });
  }
}
