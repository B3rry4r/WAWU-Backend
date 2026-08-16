import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
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
  constructor(private readonly prisma: PrismaService) {}

  async getForCreator(creatorWawuId: string): Promise<EvgScore> {
    const score = await this.prisma.evgScore.findUnique({
      where: { creatorWawuId },
    });

    if (!score) {
      throw new NotFoundException(`No EVG score found for creator ${creatorWawuId}`);
    }

    return score;
  }
}
