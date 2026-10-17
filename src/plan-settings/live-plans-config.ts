import type {
  EventOffer,
  PlanAction,
  PlanEventPass,
  PlanPack,
  PlansConfig,
  PlanTier,
} from '../plans/plans-config';

/** Anything that can say what the plan is right now. */
export interface PlansSource {
  current(): PlansConfig;
}

/**
 * The plan as it stands now, behind the same `PlansConfig` shape every reader
 * already takes (TIER-06, R-65). Each field is read from the source on each
 * access, so a figure an admin changes is the one the next request reads,
 * with no restart and no reader changed: PlansService, the purchases, the
 * tier grant, the points convert and the waitlist keep injecting PLANS_CONFIG.
 *
 * A reader that needs two fields to agree (a price and the points it buys)
 * should take `current()` once and read both from that.
 */
export class LivePlansConfig implements PlansConfig {
  constructor(private readonly source: PlansSource) {}

  get provisional(): Readonly<Record<string, string>> {
    return this.source.current().provisional;
  }
  get eventPasses(): readonly PlanEventPass[] {
    return this.source.current().eventPasses;
  }
  get tiers(): readonly PlanTier[] {
    return this.source.current().tiers;
  }
  get eventOffers(): readonly EventOffer[] {
    return this.source.current().eventOffers;
  }
  get eventDate(): string | null | undefined {
    return this.source.current().eventDate;
  }
  get preselectedTier(): string {
    return this.source.current().preselectedTier;
  }
  get tierEndingDays(): number {
    return this.source.current().tierEndingDays;
  }
  get extraProducts(): PlansConfig['extraProducts'] {
    return this.source.current().extraProducts;
  }
  get packs(): readonly PlanPack[] {
    return this.source.current().packs;
  }
  get checkoutBump(): PlansConfig['checkoutBump'] {
    return this.source.current().checkoutBump;
  }
  get points(): PlansConfig['points'] {
    return this.source.current().points;
  }
  get cashOut(): PlansConfig['cashOut'] {
    return this.source.current().cashOut;
  }
  get actions(): readonly PlanAction[] {
    return this.source.current().actions;
  }
  get caps(): PlansConfig['caps'] {
    return this.source.current().caps;
  }
  get referral(): PlansConfig['referral'] {
    return this.source.current().referral;
  }
}
