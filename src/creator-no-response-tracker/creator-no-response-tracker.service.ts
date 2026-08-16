import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import type { CreatorNoResponseTrackerResponse } from '../common/types';

@Injectable()
export class CreatorNoResponseTrackerService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Single evolving row per creator, normally kept current by the
   * DM-deadline-sweep cron job (conventions.md § Scheduled/background
   * jobs — owned by the DirectMessage resource, not this one). A creator
   * who has never had a DM thread sweep run against them yet has no row —
   * upsert-create the zeroed default rather than 404ing, so this read
   * endpoint is always a genuine 200 (conventions.md § Runtime contract:
   * "empty = a genuine empty array response ... never a silently-swallowed
   * exception").
   */
  async getResponseStats(creatorWawuId: string): Promise<CreatorNoResponseTrackerResponse> {
    const row = await this.prisma.creatorNoResponseTracker.upsert({
      where: { creatorWawuId },
      update: {},
      create: {
        creatorWawuId,
        noResponseRatePct: 0,
        penaltyState: 'none',
        dmDisabledUntil: null,
      },
    });

    return {
      ...row,
      noResponseRatePct: Number(row.noResponseRatePct),
    };
  }
}
