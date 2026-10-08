import { Inject, Injectable } from '@nestjs/common';
import type { BillingCurrency } from '../../generated/prisma/enums';
import { BillingCurrencyService } from './billing-currency.service';
import { MakerTierService } from './maker-tier.service';
import {
  countIn,
  PLANS_CONFIG,
  priceIn,
  type PlanEventPass,
  type PlansConfig,
} from './plans-config';
import type {
  MyTierView,
  PlanEventPassView,
  PlansView,
} from './plans-view.type';

/**
 * GET /plans and GET /me/tier (TIER-01). Every figure comes from the checked
 * config (PLANS_CONFIG); every price is picked for the caller's billing
 * currency by `priceIn`, so one response never holds both currencies.
 */
@Injectable()
export class PlansService {
  constructor(
    @Inject(PLANS_CONFIG) private readonly config: PlansConfig,
    private readonly currency: BillingCurrencyService,
    private readonly tiers: MakerTierService,
  ) {}

  /** The plan as the caller pays for it. */
  async plansFor(
    wawuUserId: string,
    phone: string | null | undefined,
  ): Promise<PlansView> {
    const billing = await this.currency.resolve(wawuUserId, phone);
    return {
      ...planIn(this.config, billing.currency),
      currencyFixed: billing.fixed,
    };
  }

  /** The caller's tier (VF14). */
  async myTier(
    wawuUserId: string,
    now: Date = new Date(),
  ): Promise<MyTierView> {
    const held = await this.tiers.tierOf(wawuUserId, now);
    return {
      state: held.state,
      tier:
        held.tierId === null
          ? null
          : {
              id: held.tierId,
              name: held.tier?.name ?? null,
              badge: held.tier ? { ...held.tier.badge } : null,
            },
      activeFrom: held.activeFrom?.toISOString() ?? null,
      activeUntil: held.activeUntil?.toISOString() ?? null,
      productsAllowed: held.productsAllowed,
      extraProducts: held.extraProducts,
      pointsIncluded: held.pointsIncluded,
      firstVoiceIntroIncluded: held.voiceIntroIncluded,
      eventPass: held.eventPass ? passView(held.eventPass) : null,
    };
  }
}

function passView(p: PlanEventPass): PlanEventPassView {
  return { id: p.id, name: p.name };
}

/** The config in one currency: what GET /plans answers, less `currencyFixed`. */
export function planIn(
  config: PlansConfig,
  currency: BillingCurrency,
): Omit<PlansView, 'currencyFixed'> {
  const passes = new Map(config.eventPasses.map((p) => [p.id, p]));
  return {
    currency,
    tiers: config.tiers.map((t) => ({
      id: t.id,
      name: t.name,
      days: t.days,
      products: t.products,
      bonusPoints: t.bonusPoints,
      bonusPointsExpireDays: t.bonusExpiryDays,
      priceMinor: priceIn(t.price, currency),
      // The config check guarantees every tier's pass is listed.
      eventPass: passView(passes.get(t.eventPass)!),
      badge: { ...t.badge },
      packBonusPercent: t.packBonusPct,
      firstVoiceIntroIncluded: t.firstVoiceIntro,
      preselected: t.id === config.preselectedTier,
    })),
    extraProducts: {
      count: config.extraProducts.count,
      priceMinor: priceIn(config.extraProducts.price, currency),
    },
    packs: config.packs.map((p) => ({
      id: p.id,
      points: countIn(p.points, currency),
      priceMinor: priceIn(p.price, currency),
    })),
    checkoutBump: {
      points: countIn(config.checkoutBump.points, currency),
      priceMinor: priceIn(config.checkoutBump.price, currency),
    },
    actions: config.actions.map((a) => ({
      id: a.id,
      points: a.points,
      per: a.per,
    })),
    caps: {
      dailyPoints: config.caps.dailyPointsPerUser,
      maxCharactersPerJob: config.caps.maxCharsPerJob,
      maxAudioMinutesPerJob: config.caps.maxAudioMinPerJob,
    },
  };
}
