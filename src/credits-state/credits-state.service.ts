import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreditsState } from '../common/types';

/** 7 days, per registry.json CreditsState.trialEndsAt note ("7 days from signup"). */
const TRIAL_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class CreditsStateService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reads the caller's CreditsState, lazily creating it on first read.
   * No other endpoint in this backend's contract creates a CreditsState row
   * (CreditPurchase.verify and CommunityMessage.create both mutate an
   * existing balance) so first-touch-creates-with-a-fresh-trial here is the
   * only sane place for the row to originate.
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
        trialEndsAt: new Date(Date.now() + TRIAL_DURATION_MS),
      },
    });
  }
}
