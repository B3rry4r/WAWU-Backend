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
    const [first] = await this.eligible(viewerWawuId, placement);
    return first ?? null;
  }

  /**
   * Every card the Explore slider may show, in the serving order (heaviest
   * first, ties as in AD_TIE_BREAK), or an empty list when there are none. The
   * same rule as `serve` decides each one; the app interleaves them with the
   * featured events (R-59). Viewing and tapping a slide is counted by ADS-05
   * exactly as for any other card.
   */
  slider(viewerWawuId: string): Promise<AdCardView[]> {
    return this.eligible(viewerWawuId, 'explore_slider');
  }

  private async eligible(
    viewerWawuId: string,
    placement: AdPlacementName,
  ): Promise<AdCardView[]> {
    // One reading of the clock decides the whole answer.
    const now = this.clock();

    const found = await servableCampaigns(
      { prisma: this.prisma, blocked: this.blocked },
      viewerWawuId,
      now,
      { placement },
    );
    return found.map((c) => ({
      id: c.id,
      advertiser: c.advertiser,
      headline: c.creative.headline,
      subline: c.creative.subline,
      ctaLabel: c.creative.ctaLabel,
      ctaDestination: c.creative.ctaDestination,
      ctaDestinationId: c.creative.ctaDestinationId,
      artworkUrl: c.creative.artworkUrl,
    }));
  }
}
