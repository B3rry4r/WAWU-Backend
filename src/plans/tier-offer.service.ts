import { Injectable } from '@nestjs/common';
import { AccountType } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { MakerTierService } from './maker-tier.service';
import type { TierOfferSeenView, TierOfferView } from './plans-view.type';

/** The admin setting that decides whether the offer has its close X (1) or a "Not now" button (0). */
export const TIER_OFFER_CLOSE_SETTING = 'tier_offer.close_button_on';

/**
 * The full-screen offer of the three tiers (TIER-OFFER, R-94). The Hub decides
 * who is shown it, so the rule is one place and the same on every phone:
 * a creator account (a professional is one), not yet shown it, holding no
 * running tier. A fan or buyer account is never shown it (tiers unlock selling).
 * "Shown" is written by the app when the screen is drawn (`markSeen`), so it is
 * once across devices.
 */
@Injectable()
export class TierOfferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiers: MakerTierService,
    private readonly settings: PlanSettingsService,
  ) {}

  async view(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<TierOfferView> {
    const closeButton = this.settings.number(TIER_OFFER_CLOSE_SETTING) === 1;
    const [profile, seen] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { accountType: true },
      }),
      this.prisma.tierOfferSeen.findUnique({ where: { wawuUserId } }),
    ]);
    if (profile?.accountType !== AccountType.creator || seen) {
      return { show: false, closeButton };
    }
    const held = await this.tiers.tierOf(wawuUserId, now);
    return {
      show: held.state !== 'active' && held.state !== 'ending',
      closeButton,
    };
  }

  /** The first write wins: a second one, from another phone or a retry, changes nothing. */
  async markSeen(wawuUserId: string): Promise<TierOfferSeenView> {
    const row = await this.prisma.tierOfferSeen.upsert({
      where: { wawuUserId },
      create: { wawuUserId },
      update: {},
    });
    return { seenAt: row.seenAt.toISOString() };
  }
}
