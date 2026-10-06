import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { ADS_CLOCK, type AdsClock } from './ads-clock';
import { AD_TIE_BREAK, SERVED_STATUSES } from './ads-serving';
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

    const candidates = await this.prisma.adCampaign.findMany({
      where: {
        placement,
        status: { in: [...SERVED_STATUSES] },
        startsAt: { lte: now },
        endsAt: { gt: now },
        creative: { isNot: null },
      },
      orderBy: [...AD_TIE_BREAK],
      select: {
        id: true,
        advertiser: true,
        creative: {
          select: {
            headline: true,
            subline: true,
            ctaLabel: true,
            ctaDestination: true,
            ctaDestinationId: true,
            artworkUrl: true,
          },
        },
      },
    });
    if (candidates.length === 0) return null;

    const open = await this.openEventIds(
      viewerWawuId,
      candidates.flatMap((c) =>
        c.creative?.ctaDestination === 'event'
          ? [c.creative.ctaDestinationId]
          : [],
      ),
      now,
    );

    for (const c of candidates) {
      const creative = c.creative;
      // Anything this code cannot check is not served.
      if (!creative || creative.ctaDestination !== 'event') continue;
      if (!open.has(creative.ctaDestinationId)) continue;
      return {
        id: c.id,
        advertiser: c.advertiser,
        headline: creative.headline,
        subline: creative.subline,
        ctaLabel: creative.ctaLabel,
        ctaDestination: creative.ctaDestination,
        ctaDestinationId: creative.ctaDestinationId,
        artworkUrl: creative.artworkUrl,
      };
    }
    return null;
  }

  /**
   * Of these Event ids, the ones a person can still open: published, not
   * cancelled, not finished (`endsAt ?? startsAt` not before now, as in
   * GET /events upcoming) and not hosted by somebody hidden from the viewer.
   */
  private async openEventIds(
    viewerWawuId: string,
    ids: string[],
    now: Date,
  ): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const hidden = await this.blocked.hiddenFrom(viewerWawuId);
    const rows = await this.prisma.event.findMany({
      where: {
        id: { in: ids },
        status: 'published',
        cancelledAt: null,
        hostWawuId: { notIn: hidden },
        OR: [
          { endsAt: { gte: now } },
          { endsAt: null, startsAt: { gte: now } },
        ],
      },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  }
}
