import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { ADS_CLOCK, type AdsClock } from './ads-clock';
import { servableCampaigns } from './ads-serving';
import type { AdCardView } from './ads-view.type';
import type { AdPlacementName } from './dto/ads.dto';

/**
 * Task ADS-04. Reads only: nothing here writes a row. The rule is written in
 * ads-serving.ts.
 */
@Injectable()
export class AdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocked: BlockedAccountService,
    @Inject(ADS_CLOCK) private readonly clock: AdsClock,
  ) {}

  /** The one card to show for a placement, or null when nothing is eligible. */
  async serve(
    viewerWawuId: string,
    placement: AdPlacementName,
  ): Promise<AdCardView | null> {
    // One reading of the clock decides the whole answer.
    const now = this.clock();

    const [first] = await servableCampaigns(
      { prisma: this.prisma, blocked: this.blocked },
      viewerWawuId,
      now,
      { placement },
    );
    if (!first) return null;
    const creative = first.creative;
    return {
      id: first.id,
      advertiser: first.advertiser,
      headline: creative.headline,
      subline: creative.subline,
      ctaLabel: creative.ctaLabel,
      ctaDestination: creative.ctaDestination,
      ctaDestinationId: creative.ctaDestinationId,
      artworkUrl: creative.artworkUrl,
    };
  }
}
