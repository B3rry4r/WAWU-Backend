import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { tierStateAt } from '../maker-tier.service';
import { PLANS_CONFIG, tierById, type PlansConfig } from '../plans-config';
import type { PersonBadgeView } from './person-badge-view.type';

/**
 * Reads the tier badge of a set of people, in one query (TIER-07).
 *
 * Every profile and card view that shows a badge asks here, so they cannot
 * disagree about who has one. A person has a badge exactly while their tier
 * runs: `tierStateAt` says `active` or `ending`, the same test the publishing
 * gate uses (`MakerTierService.hasActiveTier`). A person with no tier, an ended
 * tier, or a tier the plan no longer names is not in the map; the caller serves
 * `badge: null` for them.
 *
 * Reads WAWU's own table only and holds nothing across a call: a card page
 * asks once for all its people. The badge's name and kind come from the plan
 * (`PLANS_CONFIG`); the number is the one stored when it was given.
 */
@Injectable()
export class TierBadgeService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
  ) {}

  async forMany(
    wawuUserIds: readonly string[],
    now: Date = new Date(),
  ): Promise<Map<string, PersonBadgeView>> {
    const out = new Map<string, PersonBadgeView>();
    const unique = [...new Set(wawuUserIds)];
    if (unique.length === 0) return out;
    const rows = await this.prisma.makerTier.findMany({
      where: { wawuUserId: { in: unique } },
      select: {
        wawuUserId: true,
        tierId: true,
        activeUntil: true,
        badgeNumber: true,
      },
    });
    for (const r of rows) {
      if (
        tierStateAt(r.activeUntil, now, this.config.tierEndingDays) === 'ended'
      )
        continue;
      const tier = tierById(this.config, r.tierId);
      if (tier === null) continue;
      out.set(r.wawuUserId, {
        id: tier.badge.id,
        numbered: tier.badge.numbered,
        name: tier.name,
        number: tier.badge.numbered ? r.badgeNumber : null,
      });
    }
    return out;
  }

  async forOne(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<PersonBadgeView | null> {
    return (await this.forMany([wawuUserId], now)).get(wawuUserId) ?? null;
  }
}
