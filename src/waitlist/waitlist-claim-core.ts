import { Inject, Injectable } from '@nestjs/common';
import type { WaitlistRegistration } from '../../generated/prisma/client';
import { WaitlistStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../common/prisma/prisma.service';
import {
  PLANS_CONFIG,
  tierById,
  type PlansConfig,
} from '../plans/plans-config';
import { TierGrantService } from '../plans/tier-grant.service';
import { giveTierPurchase } from '../plans/tier-purchase-grant';
import type { StoredClaimResult } from './waitlist-claim-result';

/** How a claim was made: the access code typed in the app, or the server's own match of a proven email or phone. */
export type ClaimVia = 'code' | 'auto';

/** The `MakerPurchase.method` a /join payment is recorded with (the store writes `store`). */
export const WEB_JOIN_METHOD = 'web_join';

/** What a paid registration turns into. */
export interface RegistrationGoods {
  tierId: string;
  /** Days to give instead of the tier's own; set only for the old offer's registrations (365). */
  days: number | undefined;
  /** The name the claim answer calls it. */
  name: string;
}

export type ClaimRowOutcome =
  | { kind: 'claimed'; told: StoredClaimResult }
  | { kind: 'taken'; current: WaitlistRegistration };

/**
 * THE ONE CLAIM TRANSACTION (JOIN-03, JOIN-TIERS-HUB R-125), used by the access
 * code (`POST /waitlist/claims`) and by the automatic match, so both do exactly
 * the same thing to a paid registration: mark it claimed with a conditional
 * UPDATE, give the tier it paid for the way a store purchase of that tier is
 * given (`giveTierPurchase`: upgrade a smaller running tier, otherwise add the
 * days; a `MakerPurchase` record with method `web_join`), and keep what the
 * claim told, all in one transaction. Two callers at once queue on the row; the
 * second changes nothing. A grant that fails leaves the registration unclaimed.
 *
 * Nothing moves in the Hub ledger: the payment was Flutterwave's.
 */
@Injectable()
export class WaitlistClaimCore {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PLANS_CONFIG) private readonly plans: PlansConfig,
    private readonly grants: TierGrantService,
  ) {}

  /**
   * The tier and days a registration turns into. A registration with a `tier`
   * is that tier at its own days; one without is the offer's tier (Verify) for
   * the offer's days, as it always was. Null when the plans file no longer
   * names the tier, or the old offer.
   */
  goodsOf(row: {
    tier: string | null;
    offerId: string;
  }): RegistrationGoods | null {
    if (row.tier !== null) {
      const tier = tierById(this.plans, row.tier);
      return tier === null
        ? null
        : { tierId: tier.id, days: undefined, name: tier.name };
    }
    const offer = this.plans.eventOffers.find((o) => o.id === row.offerId);
    return offer === undefined
      ? null
      : { tierId: offer.tier, days: offer.tierDays, name: offer.name };
  }

  async claimRow(
    wawuUserId: string,
    row: WaitlistRegistration,
    goods: RegistrationGoods,
    via: ClaimVia,
    now: Date,
  ): Promise<ClaimRowOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.waitlistRegistration.updateMany({
        where: {
          id: row.id,
          status: WaitlistStatus.paid,
          claimedByWawuId: null,
        },
        data: { claimedByWawuId: wawuUserId, claimedAt: now, claimedVia: via },
      });
      if (claimed.count === 0) {
        // Lost the race: the row is claimed now, and by whom decides the answer.
        return {
          kind: 'taken' as const,
          current: await tx.waitlistRegistration.findUniqueOrThrow({
            where: { id: row.id },
          }),
        };
      }
      const given = await giveTierPurchase(tx, this.plans, this.grants, {
        wawuUserId,
        tierId: goods.tierId,
        ref: `join:${row.id}`,
        method: WEB_JOIN_METHOD,
        amountMinor: row.paidKobo ?? row.amountKobo,
        now,
        ...(goods.days !== undefined ? { days: goods.days } : {}),
      });
      const told: StoredClaimResult = {
        offerName: goods.name,
        days: given.outcome.daysAdded,
        extended: given.outcome.extended,
        pointsGranted: given.outcome.pointsGranted,
        pointsExpireAt: given.outcome.pointsExpireAt?.toISOString() ?? null,
      };
      await tx.waitlistRegistration.update({
        where: { id: row.id },
        data: { claimResult: told },
      });
      return { kind: 'claimed' as const, told };
    });
  }
}
