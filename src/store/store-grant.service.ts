import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  Prisma,
  StoreProduct,
  StorePurchase,
} from '../../generated/prisma/client';
import { addCreditsWithLot } from '../credit-purchase/credit-grant';
import { PACK_TABLE } from '../credit-purchase/credit-packs';
import {
  grantPassPeriod,
  storePassReference,
} from '../community/pass/community-pass-grant';
import { PAYEE_SHARE_BPS } from '../money/payments/payment-config';
import { MakerTierService } from '../plans/maker-tier.service';
import {
  PLANS_CONFIG,
  priceIn,
  tierById,
  type PlansConfig,
} from '../plans/plans-config';
import { lockPersonTier, TierGrantService } from '../plans/tier-grant.service';
import { pricePack } from '../plans/purchases/points-pack-rules';
import { PurchaseRefusal } from '../plans/purchases/plan-purchase-rules';
import { PointsService } from '../points/points.service';
import { grantsConfigOf } from './store-grants';
import { StoreError } from './store-error';
import type { StoreGrantedView } from './store-view.type';

const DAY_MS = 86_400_000;

/** The reference every row a store purchase writes carries (point lot, tier pass, tier purchase). */
export function storeRef(purchaseId: string): string {
  return `store:${purchaseId}`;
}

/**
 * What the store's share leaves WAWU: the reference less the store's cut. The
 * cut is rounded up, so the net (and the creator's 85% of it) is never more
 * than WAWU receives (R-86, Default (lead), owner may override).
 */
export function netOf(referenceKobo: number, feeBps: number): number {
  const cut = Math.ceil((referenceKobo * feeBps) / 10_000);
  return Math.max(0, referenceKobo - cut);
}

/** The creator's 85% of the net, rounded down as every share is (R-5). */
export function creatorShareOf(netKobo: number): number {
  return Number((BigInt(netKobo) * BigInt(PAYEE_SHARE_BPS)) / 10_000n);
}

/** What was written when a purchase was granted: kept on the row for the take-back. */
export interface StoreGrantSnapshot {
  kind: StoreProduct['kind'];
  points?: number;
  pointsExpireAt?: string;
  credits?: number;
  creditPurchaseId?: string;
  tierId?: string;
  fromTierId?: string | null;
  days?: number;
  until?: string;
  bonusPoints?: number;
  communityId?: string;
}

/**
 * Gives and takes back what a store product sells (task IAP-01, R-86). It calls
 * the SAME grant code the wallet paths call, inside the caller's transaction:
 *
 *  - points: `PointsService.grant`, the pack's points and the tier's bonus as
 *    `pricePack` works them out (one lot, source `pack`, keyed `store:<id>`);
 *  - tiers: `TierGrantService.grant` (or `upgrade` for a bigger tier than the
 *    one that runs), which also gives the tier's bonus points and event pass;
 *  - credits: `addCreditsWithLot` (the balance and the cost-basis lot), the
 *    lot's gross being WAWU's net after the store's share;
 *  - passes: `grantPassPeriod` (the chained period and the membership).
 *
 * Nothing here calls a store or any network; the caller has already verified
 * the purchase and holds no connection across that call.
 */
@Injectable()
export class StoreGrantService {
  constructor(
    @Inject(PLANS_CONFIG) private readonly plans: PlansConfig,
    private readonly points: PointsService,
    private readonly tierGrants: TierGrantService,
    private readonly tiers: MakerTierService,
  ) {}

  /**
   * Gives what `purchase` bought, once, inside `tx`. `purchase` is the row the
   * caller has just inserted (its unique key is the once-only gate), so a
   * repeat never reaches here.
   */
  async give(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    product: StoreProduct,
    now: Date,
  ): Promise<StoreGrantSnapshot> {
    const grants = grantsConfigOf(product.grants);
    const userId = purchase.wawuUserId;
    const ref = storeRef(purchase.id);
    switch (product.kind) {
      case 'points': {
        const held = await this.tiers.tierOf(userId, now);
        let plan;
        try {
          plan = pricePack(this.plans, 'NGN', held, grants.packId ?? '');
        } catch (e) {
          if (e instanceof PurchaseRefusal) throw new Error(e.message);
          throw e;
        }
        const expiresAt = new Date(
          now.getTime() + plan.boughtExpiryDays * DAY_MS,
        );
        await this.points.grant(
          {
            wawuUserId: userId,
            source: 'pack',
            sourceRef: ref,
            points: plan.totalPoints,
            expiresAt,
          },
          { tx, now },
        );
        return {
          kind: 'points',
          points: plan.totalPoints,
          pointsExpireAt: expiresAt.toISOString(),
        };
      }
      case 'credits': {
        const pack = grants.pack;
        if (pack === null || !(pack in PACK_TABLE))
          throw new Error(`Product ${product.id} names no credit pack.`);
        const info = PACK_TABLE[pack];
        const gross = purchase.netKobo ?? 0;
        await tx.creditPurchase.create({
          data: {
            id: randomUUID(),
            userWawuId: userId,
            pack,
            creditsGranted: info.credits,
            flutterwaveTxRef: ref,
            storePurchaseId: purchase.id,
            amount: Math.round((purchase.referenceKobo ?? 0) / 100),
            status: 'completed',
            purchasedAt: purchase.purchasedAt,
          },
        });
        const row = await tx.creditPurchase.findUniqueOrThrow({
          where: { storePurchaseId: purchase.id },
          select: { id: true, purchasedAt: true },
        });
        await addCreditsWithLot(tx, {
          userWawuId: userId,
          credits: info.credits,
          grossKobo: gross,
          purchaseId: row.id,
          purchasedAt: row.purchasedAt,
        });
        return {
          kind: 'credits',
          credits: info.credits,
          creditPurchaseId: row.id,
        };
      }
      case 'tier': {
        const tier = tierById(this.plans, grants.tierId ?? '');
        if (tier === null)
          throw new Error(`Product ${product.id} names no tier.`);
        await lockPersonTier(tx, userId);
        const held = await tx.makerTier.findUnique({
          where: { wawuUserId: userId },
        });
        const heldTier =
          held !== null && held.activeUntil.getTime() > now.getTime()
            ? tierById(this.plans, held.tierId)
            : null;
        // A bigger tier than the one that runs moves the person up (the same
        // upgrade a wallet purchase makes). Anything else adds this tier's
        // days to what runs: the store has been paid, so it is never refused.
        const upgrade =
          held !== null &&
          heldTier !== null &&
          held.tierId !== tier.id &&
          priceIn(tier.price, 'NGN') > priceIn(heldTier.price, 'NGN');
        const outcome = upgrade
          ? await this.tierGrants.upgrade(tx, {
              wawuUserId: userId,
              fromTierId: held.tierId,
              tierId: tier.id,
              sourceRef: ref,
              now,
            })
          : await this.tierGrants.grant(tx, {
              wawuUserId: userId,
              tierId: tier.id,
              sourceRef: ref,
              now,
            });
        await tx.makerPurchase.createMany({
          data: [
            {
              paymentRef: ref,
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
              amountMinor: purchase.referenceKobo ?? priceIn(tier.price, 'NGN'),
              method: 'store',
            },
          ],
          skipDuplicates: true,
        });
        return {
          kind: 'tier',
          tierId: outcome.tierId,
          fromTierId: upgrade ? held.tierId : null,
          days: outcome.daysAdded > 0 ? outcome.daysAdded : tier.days,
          until: outcome.activeUntil.toISOString(),
          bonusPoints: outcome.pointsGranted,
        };
      }
      case 'pass': {
        const days = grants.days ?? 0;
        const communityId = purchase.communityId;
        if (communityId === null || days < 1)
          throw new Error(`Purchase ${purchase.id} names no room or no days.`);
        await grantPassPeriod(tx, {
          communityId,
          userWawuId: userId,
          reference: storePassReference(purchase.id),
          priceKobo: BigInt(purchase.referenceKobo ?? 1),
          days,
          now,
        });
        const pass = await tx.communityPass.findUniqueOrThrow({
          where: { walletPaymentId: storePassReference(purchase.id) },
          select: { endsAt: true },
        });
        return {
          kind: 'pass',
          communityId,
          days,
          until: pass.endsAt.toISOString(),
        };
      }
    }
  }

  /**
   * Takes back what `purchase` gave, inside `tx`, because the store paid it
   * back or withdrew it. Points and credits not yet spent are taken; what was
   * spent stays spent. A tier loses the days this purchase added (never past
   * now) and its bonus points lot; a pass period ends now. Returns what was
   * actually taken, which the row keeps.
   */
  async takeBack(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const snap = (purchase.grant ?? {}) as unknown as StoreGrantSnapshot;
    const ref = storeRef(purchase.id);
    const userId = purchase.wawuUserId;
    switch (purchase.kind) {
      case 'points': {
        const r = await this.points.revokeLot('pack', ref, { tx, now });
        return { points: r.taken, grantedPoints: r.granted };
      }
      case 'credits': {
        const lots = await tx.$queryRaw<
          Array<{ id: string; remaining: number }>
        >`
          SELECT l."id", l."creditsRemaining" AS "remaining"
            FROM "CreditLot" l
            JOIN "CreditPurchase" p ON p."id" = l."creditPurchaseId"
           WHERE p."storePurchaseId" = ${purchase.id}
           FOR UPDATE OF l`;
        const lot = lots[0];
        if (!lot) return { credits: 0, grantedCredits: snap.credits ?? 0 };
        await tx.$executeRaw`UPDATE "CreditLot" SET "creditsRemaining" = 0 WHERE "id" = ${lot.id}`;
        await tx.$executeRaw`UPDATE "CreditsState" SET "creditBalance" = GREATEST("creditBalance" - ${lot.remaining}, 0) WHERE "userWawuId" = ${userId}`;
        await tx.creditPurchase.updateMany({
          where: { storePurchaseId: purchase.id },
          data: { status: 'failed' },
        });
        return { credits: lot.remaining, grantedCredits: snap.credits ?? 0 };
      }
      case 'tier': {
        await lockPersonTier(tx, userId);
        const r = await this.points.revokeLot('tier_bonus', ref, { tx, now });
        const held = await tx.makerTier.findUnique({
          where: { wawuUserId: userId },
        });
        let daysRemoved = 0;
        if (held !== null && held.activeUntil.getTime() > now.getTime()) {
          const days = snap.days ?? 0;
          const floor = Math.max(now.getTime(), held.activeFrom.getTime() + 1);
          const cut = new Date(
            Math.max(floor, held.activeUntil.getTime() - days * DAY_MS),
          );
          daysRemoved = Math.round(
            (held.activeUntil.getTime() - cut.getTime()) / DAY_MS,
          );
          await tx.makerTier.update({
            where: { wawuUserId: userId },
            data: { activeUntil: cut },
          });
        }
        return { daysRemoved, bonusPoints: r.taken };
      }
      case 'pass': {
        const reference = storePassReference(purchase.id);
        const pass = await tx.communityPass.findUnique({
          where: { walletPaymentId: reference },
        });
        if (pass === null) return { passEnded: false };
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`community-pass:${pass.communityId}:${userId}`}))`;
        if (pass.endsAt.getTime() > now.getTime()) {
          const startsBefore = pass.startsAt.getTime() < now.getTime();
          await tx.communityPass.update({
            where: { id: pass.id },
            data: {
              endsAt: now,
              ...(startsBefore
                ? {}
                : { startsAt: new Date(now.getTime() - 1) }),
            },
          });
        }
        return { passEnded: true, communityId: pass.communityId };
      }
    }
  }

  /** What a purchase gave, for the app. */
  grantedView(
    snap: StoreGrantSnapshot,
    communityId: string | null,
  ): StoreGrantedView {
    return {
      points: snap.points ?? null,
      credits: snap.credits ?? null,
      tierId: snap.tierId ?? null,
      until: snap.until ?? null,
      communityId: snap.communityId ?? communityId,
    };
  }
}

/** Refuses the way every store route does when the grant cannot be made at all. */
export function grantFailed(message: string): StoreError {
  return new StoreError('store_purchase_invalid', message);
}
