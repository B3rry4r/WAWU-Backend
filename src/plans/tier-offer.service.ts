import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PlanSettingsService } from '../plan-settings/plan-settings.service';
import { MakerTierService } from './maker-tier.service';
import type { TierOfferSeenView, TierOfferView } from './plans-view.type';

/** The admin setting that decides whether the offer has its close X (1) or a "Not now" button (0). */
export const TIER_OFFER_CLOSE_SETTING = 'tier_offer.close_button_on';

/**
 * The admin setting that decides how often the offer comes (STORE-SEED, R-105):
 * 1 offers it on every app start to a person who holds no running tier, whether
 * or not they were shown it before; 0 offers it once per person (R-94).
 */
export const TIER_OFFER_EVERY_START_SETTING = 'tier_offer.every_start_on';

/**
 * The full-screen offer of the three tiers (TIER-OFFER, R-94; every start,
 * R-105). The Hub decides who is shown it, so the rule is one place and the
 * same on every phone: a signed-in person the Hub has a profile for, of any
 * account type, holding no running tier. The Hub lets any account hold a tier
 * (a tier is a `MakerTier` row keyed on the person alone, and no tier route
 * checks the account type), so a buyer account is offered it too (R-105
 * replaces R-94's "creator accounts only").
 *
 * How often: with `tier_offer.every_start_on` ON (the default) the offer is
 * answered on every ask, so the app shows it on every start until the person
 * holds a tier. With it OFF it is once per person: "shown" is written by the
 * app when the screen is drawn (`markSeen`) and, once there, the answer is no,
 * across devices. `markSeen` writes the row either way.
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
    const everyStart =
      this.settings.number(TIER_OFFER_EVERY_START_SETTING) === 1;
    const [profile, seen] = await Promise.all([
      this.prisma.userProfile.findUnique({
        where: { wawuUserId },
        select: { wawuUserId: true },
      }),
      this.prisma.tierOfferSeen.findUnique({ where: { wawuUserId } }),
    ]);
    // No profile yet: the person has no account type, so there is nothing to offer them
    // and nothing is marked; they are asked again once the profile is written.
    if (profile === null || (seen !== null && !everyStart)) {
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
