import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import type { EvgScore } from '../common/types';

/**
 * EVG (engagement/value/growth) score — a single rolling number per creator
 * derived from views + purchases*weight + comments (registry.json note).
 * This wave only exposes the read; the write path (recompute on
 * view/purchase/comment events) belongs to whichever resource owns those
 * events and is out of scope for this module.
 */
@Injectable()
export class EvgScoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blockedAccounts: BlockedAccountService,
  ) {}

  async getForCreator(
    creatorWawuId: string,
    viewerWawuId?: string,
  ): Promise<EvgScore> {
    // SETTINGS-04: a hidden creator's score is as absent as their profile.
    await this.blockedAccounts.assertVisible(
      viewerWawuId,
      creatorWawuId,
      `No EVG score found for creator ${creatorWawuId}`,
    );
    const score = await this.prisma.evgScore.findUnique({
      where: { creatorWawuId },
    });

    if (!score) {
      throw new NotFoundException(`No EVG score found for creator ${creatorWawuId}`);
    }

    return score;
  }
}
