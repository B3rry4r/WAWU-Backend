import type { Prisma } from '../../generated/prisma/client';
import { priceIn, tierById, type PlansConfig } from './plans-config';
import {
  lockPersonTier,
  type TierGrantOutcome,
  type TierGrantService,
} from './tier-grant.service';

/** What a paid tier purchase is made of, whichever door the money came in by. */
export interface TierPurchaseInput {
  wawuUserId: string;
  tierId: string;
  /** The reference every row the grant writes carries (`store:<id>`, `join:<id>`). Unique: a reference grants once. */
  ref: string;
  /** The `MakerPurchase.method`: `store`, or `web_join` for a /join payment. */
  method: string;
  /** What was paid, in kobo, written on the purchase record. */
  amountMinor: number;
  now: Date;
  /** Days to give instead of the tier's own (the old /join offer's 365). */
  days?: number;
}

export interface TierPurchaseOutcome {
  outcome: TierGrantOutcome;
  /** True when a bigger tier than the one that runs moved the person up. */
  upgrade: boolean;
  /** The tier held before, or null. */
  fromTierId: string | null;
}

/**
 * Gives a paid tier purchase, inside the caller's transaction: the ONE rule a
 * store purchase (IAP-01, R-86) and a /join payment (R-125) both use, so a
 * person who paid on the web is given what a person who paid in the store is.
 *
 * A bigger tier than the one that runs moves the person up (the upgrade a
 * wallet purchase makes). Anything else adds this tier's days to what runs,
 * on the tier held: the money has been paid, so it is never refused. It then
 * writes the `MakerPurchase` record (`tier`, `renew` or `upgrade`), once.
 */
export async function giveTierPurchase(
  tx: Prisma.TransactionClient,
  plans: PlansConfig,
  tierGrants: TierGrantService,
  input: TierPurchaseInput,
): Promise<TierPurchaseOutcome> {
  const tier = tierById(plans, input.tierId);
  if (tier === null)
    throw new Error(`The plans file names no tier "${input.tierId}".`);
  const userId = input.wawuUserId;
  await lockPersonTier(tx, userId);
  const held = await tx.makerTier.findUnique({
    where: { wawuUserId: userId },
  });
  const heldTier =
    held !== null && held.activeUntil.getTime() > input.now.getTime()
      ? tierById(plans, held.tierId)
      : null;
  const upgrade =
    held !== null &&
    heldTier !== null &&
    held.tierId !== tier.id &&
    priceIn(tier.price, 'NGN') > priceIn(heldTier.price, 'NGN');
  const outcome = upgrade
    ? await tierGrants.upgrade(tx, {
        wawuUserId: userId,
        fromTierId: held.tierId,
        tierId: tier.id,
        sourceRef: input.ref,
        now: input.now,
      })
    : await tierGrants.grant(tx, {
        wawuUserId: userId,
        tierId: tier.id,
        sourceRef: input.ref,
        now: input.now,
        ...(input.days !== undefined ? { days: input.days } : {}),
      });
  // A purchase record is a payment. A /join registration made free by a code
  // (paid 0) paid nothing, so it leaves no record: the grant is still made, and
  // a free join never counts as a first paid tier for a referral reward.
  if (input.amountMinor >= 1 || input.method === 'store')
    await tx.makerPurchase.createMany({
      data: [
        {
          paymentRef: input.ref,
          wawuUserId: userId,
          kind: upgrade
            ? 'upgrade'
            : held !== null && heldTier !== null && held.tierId === tier.id
              ? 'renew'
              : 'tier',
          tierId: tier.id,
          fromTierId: upgrade ? held.tierId : null,
          bump: false,
          currency: 'NGN',
          amountMinor: input.amountMinor,
          method: input.method,
        },
      ],
      skipDuplicates: true,
    });
  return {
    outcome,
    upgrade,
    fromTierId: upgrade ? held.tierId : null,
  };
}
