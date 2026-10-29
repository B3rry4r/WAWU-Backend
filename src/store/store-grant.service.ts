import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type {
  Prisma,
  StoreProduct,
  StorePurchase,
  StorePurchaseIntent,
} from '../../generated/prisma/client';
import type { StoreIntentKind } from '../../generated/prisma/enums';
import { addCreditsWithLot } from '../credit-purchase/credit-grant';
import { PACK_TABLE } from '../credit-purchase/credit-packs';
import {
  grantPassPeriod,
  storePassReference,
} from '../community/pass/community-pass-grant';
import { PASS_PERIOD_DAYS } from '../community/pass/community-pass-rules';
import { PAYEE_SHARE_BPS } from '../money/payments/payment-config';
import { MakerTierService } from '../plans/maker-tier.service';
import {
  INT4_MAX,
  PLANS_CONFIG,
  priceIn,
  tierById,
  type PlansConfig,
} from '../plans/plans-config';
import { lockPersonTier, TierGrantService } from '../plans/tier-grant.service';
import {
  PACK_NOT_ALLOWED_FLAG,
  packRefusalFor,
  packRuleOf,
} from '../plans/purchases/extra-products-cap';
import {
  EXTRA_PRODUCTS_TOO_MANY_MESSAGE,
  TIER_REQUIRED_MESSAGE,
} from '../plans/purchases/extra-products-rules';
import { pricePack } from '../plans/purchases/points-pack-rules';
import { PurchaseRefusal } from '../plans/purchases/plan-purchase-rules';
import { POINTS_NEVER_EXPIRES } from '../points/points-bought';
import { PointsService } from '../points/points.service';
import type { BuyTarget } from './store-buy-target.service';
import { StoreSaleNoticeService } from './notice/store-sale-notice.service';
import { StoreQuestionService } from './question/store-question.service';
import {
  creditScopeFor,
  QUESTION_CREDIT_SCOPE,
} from './question/store-question-rules';
import { StoreEarningService } from './store-earning.service';
import { grantsConfigOf } from './store-grants';
import { StoreError } from './store-error';
import type { StoreGrantedView } from './store-view.type';

/** The commission snapshotted on a ladder purchase's row: the one split, 85/15 (R-5), as the wallet path writes it. */
const BUY_COMMISSION_RATE = 0.15;

/** What a ladder purchase is made against: its intent and what the intent names, checked just before the grant. */
export interface BuyContext {
  /** Null for a late sale that has no intent of its own (STORE-BUY-HUB round 4). */
  intent: StorePurchaseIntent | null;
  /** Null when the piece, creator or room can no longer be bought: the fan is given a store credit and nothing else. */
  target: BuyTarget | null;
  /** True when the price on the piece or room has moved since the intent: the intent's price is still what is granted, flagged. */
  priceChanged?: boolean;
  /** Set when a store credit pays for this purchase instead of a store sale: consumed whole in the same transaction. */
  creditId?: string | null;
  /**
   * Set when a verified store sale cannot be given as goods because its intent
   * is missing, expired or used, or the sale came before it: the fan is credited
   * the product's list price instead (STORE-BUY-HUB round 4, M3).
   */
  late?: 'missing' | 'expired' | 'used' | 'before_intent' | null;
}

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
  /** Set on a snapshot written before R-101 point 7; bought points no longer end, so new ones carry none. */
  pointsExpireAt?: string;
  credits?: number;
  creditPurchaseId?: string;
  tierId?: string;
  fromTierId?: string | null;
  days?: number;
  until?: string;
  bonusPoints?: number;
  /** Products an upload pack added to the tier row (IAP-03). */
  extraProducts?: number;
  communityId?: string;
  /** A ladder purchase (STORE-BUY-HUB): what it was for, the piece, creator or room, and the creator's earning. */
  buyKind?: StoreIntentKind;
  targetId?: string;
  earningId?: string;
  /** A ladder question that was sent: its id, which is the direct message's (STORE-QUESTION). Its earning is recorded when it is answered. */
  questionId?: string;
  /** A ladder purchase that could not be given: the store credit the fan has instead, worth the list price. */
  creditId?: string;
  creditKobo?: number;
  /** A ladder purchase paid with a store credit: the credit it consumed. */
  paidWithCredit?: string;
  /** Given, but an admin or the fan should know why: `price_changed`. */
  note?: string;
  /** Set when the purchase was recorded and nothing was given: `member_removed`, `pack_not_allowed` (R-100) or `target_unavailable` (a ladder purchase whose piece, creator or room can no longer be bought). */
  skipped?: string;
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
 *  - passes: `grantPassPeriod` (the chained period and the membership);
 *  - upload packs (IAP-03): the count is added to the tier row's
 *    `extraProducts` and written to `MakerExtraProducts` (keyed `store:<id>`),
 *    as the wallet's `extra_products` payment writes them.
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
    private readonly earnings: StoreEarningService,
    private readonly questions: StoreQuestionService,
    private readonly notices: StoreSaleNoticeService,
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
    buy: BuyContext | null = null,
  ): Promise<StoreGrantSnapshot> {
    const grants = grantsConfigOf(product.grants);
    const userId = purchase.wawuUserId;
    if (userId === null)
      throw new Error(`Purchase ${purchase.id} has no buyer to give to.`);
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
        await this.points.grant(
          {
            wawuUserId: userId,
            source: 'pack',
            sourceRef: ref,
            points: plan.totalPoints,
            // Bought points never end (R-101 point 7), on every platform.
            expiresAt: POINTS_NEVER_EXPIRES,
          },
          { tx, now },
        );
        return { kind: 'points', points: plan.totalPoints };
      }
      case 'credits': {
        const pack = grants.pack;
        if (pack === null || !(pack in PACK_TABLE))
          throw new Error(`Product ${product.id} names no credit pack.`);
        const info = PACK_TABLE[pack];
        // The lot's gross is what the host's share of spent credits is worked
        // on. After a store's cut moved to 30% (STORE-CUT30) it stays on the cut
        // that applied before (`shareFeeBps`), while `purchase.netKobo` is WAWU's
        // own true net: WAWU absorbs the extra, the host's share is unchanged.
        const gross = netOf(
          purchase.referenceKobo ?? 0,
          purchase.shareFeeBps ?? purchase.storeFeeBps,
        );
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
      case 'extra_products': {
        const count = grants.extraProducts;
        if (count === null || count === undefined || count < 1)
          throw new Error(`Product ${product.id} names no products.`);
        // What the wallet path does, under the same lock. The store has been
        // paid, so a tier that has ended still takes the products (they wait
        // for the next tier, as a late wallet payment's do); a person who has
        // never held a tier has nowhere to keep them and is refused, which
        // leaves the purchase unfinished in the store.
        await lockPersonTier(tx, userId);
        const held = await tx.makerTier.findUnique({
          where: { wawuUserId: userId },
          select: { tierId: true, extraProducts: true },
        });
        if (held === null) throw grantFailed(TIER_REQUIRED_MESSAGE);
        // PACK-CAP (R-100): the pack is sold only on a tier the settings name,
        // and only up to the most packs a profile holds. A purchase that
        // arrives against the rule (the store has taken the money) is recorded
        // with a flag and gives nothing, as a removed member's pass renewal is:
        // it is never thrown into a retry loop, and an admin looks.
        if (
          packRefusalFor(
            packRuleOf(this.plans),
            held.tierId,
            held.extraProducts,
          ) !== null
        )
          return { kind: 'extra_products', skipped: PACK_NOT_ALLOWED_FLAG };
        if (held.extraProducts + count > INT4_MAX)
          throw grantFailed(EXTRA_PRODUCTS_TOO_MANY_MESSAGE);
        // The store purchase row is the once-only gate; this key makes the
        // record itself once-only too.
        const { count: written } = await tx.makerExtraProducts.createMany({
          data: [
            {
              paymentRef: ref,
              wawuUserId: userId,
              tierId: held.tierId,
              products: count,
              currency: 'NGN',
              amountMinor:
                purchase.referenceKobo ??
                priceIn(this.plans.extraProducts.price, 'NGN'),
            },
          ],
          skipDuplicates: true,
        });
        if (written > 0)
          await tx.makerTier.update({
            where: { wawuUserId: userId },
            data: { extraProducts: { increment: count } },
          });
        return { kind: 'extra_products', extraProducts: count };
      }
      case 'buy': {
        if (buy === null)
          throw new Error(`Purchase ${purchase.id} has no intent.`);
        return this.giveBuy(tx, purchase, buy, now);
      }
      case 'pass': {
        const days = grants.days ?? 0;
        const communityId = purchase.communityId;
        if (communityId === null || days < 1)
          throw new Error(`Purchase ${purchase.id} names no room or no days.`);
        // A member the host removed (a pending row) is not let back in by a
        // renewal the store bills them for: the purchase is recorded, flagged for
        // an admin, and no period is written. They cancel in the store. The row
        // is locked, so a removal landing now waits for this decision.
        const rows = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status"::text AS "status" FROM "CommunityMembership"
          WHERE "userWawuId" = ${userId} AND "communityId" = ${communityId}
          FOR UPDATE`;
        if (rows[0]?.status === 'pending')
          return {
            kind: 'pass',
            communityId,
            days,
            skipped: 'member_removed',
          };
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
   * now) and its bonus points lot; a pass period ends now (and the periods
   * stacked behind it move up by what it had left). Returns what was
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
    // The buyer's account is gone (the purge keeps this purchase with the buyer
    // cleared so a refund still finds it): everything of theirs went with the
    // account, and what is left to take back is the creator's share and a
    // credit the fan never spent.
    if (userId === null) return this.takeBackForGoneBuyer(tx, purchase, now);
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
      case 'extra_products': {
        // The products come off the tier row, never below none: an admin may
        // have changed the account since, and what is not there is not taken.
        await lockPersonTier(tx, userId);
        const given = snap.extraProducts ?? 0;
        const held = await tx.makerTier.findUnique({
          where: { wawuUserId: userId },
          select: { extraProducts: true },
        });
        const taken = held === null ? 0 : Math.min(given, held.extraProducts);
        if (taken > 0)
          await tx.makerTier.update({
            where: { wawuUserId: userId },
            data: { extraProducts: { decrement: taken } },
          });
        return { extraProducts: taken, grantedExtraProducts: given };
      }
      case 'pass':
        return this.takeBackPass(tx, purchase, userId, now);
      case 'buy': {
        // What the ladder purchase gave is taken back by what it was for, and
        // the creator's 85% with it (R-101 point 5). A tip has no access to
        // take away; its record stops counting as one.
        let given: Record<string, unknown> = {};
        if (snap.skipped === undefined) {
          if (purchase.buyKind === 'content' || purchase.buyKind === 'tip') {
            const { count } = await tx.purchase.updateMany({
              where: { flutterwaveTxRef: ref, status: 'completed' },
              data: { status: 'failed' },
            });
            given = { purchaseRowsEnded: count };
          } else if (purchase.buyKind === 'pass') {
            given = await this.takeBackPass(tx, purchase, userId, now);
          } else if (purchase.buyKind === 'question') {
            // Before the answer the question is withdrawn; after it, the answer
            // stays and the earning below is taken back (STORE-QUESTION).
            given = await this.questions.cancel(tx, purchase, now);
          }
        }
        const earning = await this.earnings.takeBack(tx, purchase, now);
        const credit = await this.creditTakeBack(tx, purchase, now);
        return { ...given, earning, ...credit };
      }
    }
  }

  /**
   * Ends every pass period a store purchase gave (the purchase's own, and any
   * a reversed refund gave back), now, and moves the periods stacked behind
   * them up by what they had left.
   */
  private async takeBackPass(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    userId: string,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const reference = storePassReference(purchase.id);
    const rows = await tx.communityPass.findMany({
      where: {
        OR: [
          { walletPaymentId: reference },
          { walletPaymentId: { startsWith: `${reference}:restored:` } },
        ],
      },
      orderBy: { startsAt: 'asc' },
    });
    if (rows.length === 0) return { passEnded: false };
    let daysRemoved = 0;
    for (const pass of rows) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`community-pass:${pass.communityId}:${userId}`}))`;
      if (pass.endsAt.getTime() <= now.getTime()) continue;
      const startsBefore = pass.startsAt.getTime() < now.getTime();
      // What this purchase had left to give: the unexpired part of its period.
      const leftMs =
        pass.endsAt.getTime() -
        Math.max(now.getTime(), pass.startsAt.getTime());
      await tx.communityPass.update({
        where: { id: pass.id },
        data: {
          endsAt: now,
          ...(startsBefore ? {} : { startsAt: new Date(now.getTime() - 1) }),
        },
      });
      // A pass is bought once, so renewing stacks a later period behind this
      // one. Those periods move up by what this purchase had left, or the
      // person would keep its days (access follows the latest end) after the
      // store paid them back.
      await tx.$executeRaw`
        UPDATE "CommunityPass"
           SET "startsAt" = "startsAt" - (${leftMs}::double precision * interval '1 millisecond'),
               "endsAt" = "endsAt" - (${leftMs}::double precision * interval '1 millisecond')
         WHERE "communityId" = ${pass.communityId}
           AND "userWawuId" = ${userId}
           AND "id" <> ${pass.id}
           AND "refundId" IS NULL
           AND "startsAt" >= ${pass.endsAt}`;
      daysRemoved += Math.round(leftMs / DAY_MS);
    }
    return {
      passEnded: true,
      communityId: rows[0].communityId,
      daysRemoved,
    };
  }

  /**
   * A refund of a purchase whose buyer has deleted the account. Only a ladder
   * purchase has anything left: the creator's share (cancelled, or a deduction)
   * and a credit the fan never spent. The buyer's own unlock, tip record or
   * pass days went with their account (and a row that survived is ended all the
   * same).
   */
  private async takeBackForGoneBuyer(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    now: Date,
  ): Promise<Record<string, unknown>> {
    if (purchase.kind !== 'buy') return { buyerGone: true };
    await tx.purchase.updateMany({
      where: { flutterwaveTxRef: storeRef(purchase.id), status: 'completed' },
      data: { status: 'failed' },
    });
    if (purchase.buyKind === 'question')
      await this.questions.cancel(tx, purchase, now);
    const earning = await this.earnings.takeBack(tx, purchase, now);
    const credit = await this.creditTakeBack(tx, purchase, now);
    return { buyerGone: true, earning, ...credit };
  }

  /**
   * The store paid a purchase back, so every credit made of its payment goes
   * with it (the credit it made, and the rest of any larger one). An unspent
   * credit is voided. A SPENT one is not left standing: what it paid for is
   * taken back exactly as if that sale had been refunded itself (its grant ends
   * and its creator share is cancelled, or becomes a deduction when it was
   * paid), once; otherwise a fan and a creator could take 85% of the price per
   * cycle (STORE-BUY-HUB round 4, H2). Both purchases are flagged for the record.
   */
  private async creditTakeBack(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const credits = await tx.storeCredit.findMany({
      where: { originPurchaseId: purchase.id },
      orderBy: { createdAt: 'asc' },
    });
    // The sales this payment's credits paid for: from the credit rows, and from
    // the sales themselves (`creditOriginId`), which survive the fan's account
    // being deleted when the credit rows do not.
    const spentIds = await this.spentSalesOf(tx, purchase.id, credits);
    if (credits.length === 0 && spentIds.length === 0) return {};
    let voided = 0;
    const takenBack: string[] = [];
    const review: string[] = [];
    for (const credit of credits) {
      if (credit.status === 'open') {
        await tx.storeCredit.update({
          where: { id: credit.id },
          data: { status: 'void', voidedAt: now },
        });
        voided += 1;
      }
    }
    for (const spentId of spentIds) {
      const out = await this.takeBackSpentSale(tx, spentId, purchase.id, now);
      if (out === 'review') review.push(spentId);
      else if (out === 'taken_back') takenBack.push(spentId);
    }
    if (takenBack.length > 0 || review.length > 0)
      await tx.storePurchase.update({
        where: { id: purchase.id },
        data: { flag: 'credit_spent_taken_back', flaggedAt: now },
      });
    return {
      credit:
        review.length > 0
          ? 'review'
          : takenBack.length > 0
            ? 'spent_taken_back'
            : 'voided',
      creditsVoided: voided,
      spentSalesTakenBack: takenBack,
    };
  }

  /** The ids of the sales that credits made of this purchase's payment paid for, however they are still linked. */
  private async spentSalesOf(
    tx: Prisma.TransactionClient,
    originId: string,
    credits: Array<{ status: string; spentPurchaseId: string | null }>,
  ): Promise<string[]> {
    const ids = new Set(
      credits
        .filter((c) => c.status === 'spent' && c.spentPurchaseId !== null)
        .map((c) => c.spentPurchaseId as string),
    );
    const linked = await tx.storePurchase.findMany({
      where: { creditOriginId: originId },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const l of linked) ids.add(l.id);
    return [...ids];
  }

  /** Takes back a sale a store credit paid for, as if the sale itself had been refunded. Once: only a granted sale is touched. */
  private async takeBackSpentSale(
    tx: Prisma.TransactionClient,
    spentPurchaseId: string,
    originId: string,
    now: Date,
  ): Promise<'taken_back' | 'already' | 'review'> {
    const sale = await tx.storePurchase.findUnique({
      where: { id: spentPurchaseId },
    });
    if (sale === null || sale.status !== 'granted') return 'already';
    const taken = await this.takeBack(tx, sale, now);
    const earning = taken.earning as { earning?: string } | undefined;
    await tx.storePurchase.update({
      where: { id: sale.id },
      data: {
        status: 'refunded',
        endedAt: now,
        endReason: 'credit_source_refunded',
        takenBack: { ...taken, creditOrigin: originId } as never,
        flag:
          earning?.earning === 'review'
            ? 'earning_review'
            : 'credit_source_refunded',
        flaggedAt: now,
      },
    });
    return earning?.earning === 'review' ? 'review' : 'taken_back';
  }

  /** Puts back what `creditTakeBack` took: voided credits are open again, and the sales a spent credit paid for are restored. */
  private async creditRestore(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const reopened = await tx.storeCredit.updateMany({
      where: { originPurchaseId: purchase.id, status: 'void' },
      data: { status: 'open', voidedAt: null },
    });
    const credits = await tx.storeCredit.findMany({
      where: { originPurchaseId: purchase.id },
    });
    const spent = await this.spentSalesOf(tx, purchase.id, credits);
    const restoredSales: string[] = [];
    for (const spentId of spent) {
      const sale = await tx.storePurchase.findUnique({
        where: { id: spentId },
      });
      if (
        sale === null ||
        sale.status !== 'refunded' ||
        sale.endReason !== 'credit_source_refunded'
      )
        continue;
      const restored = await this.restore(tx, sale, now);
      await tx.storePurchase.update({
        where: { id: sale.id },
        data: {
          status: 'granted',
          endedAt: null,
          endReason: null,
          takenBack: {
            ...((sale.takenBack ?? {}) as Record<string, unknown>),
            restoredAt: now.toISOString(),
            restored,
          } as never,
        },
      });
      restoredSales.push(sale.id);
    }
    return { creditRestored: reopened.count, salesRestored: restoredSales };
  }

  /**
   * Puts back what a refund took, because Apple reversed it (REFUND_REVERSED,
   * G-IAP-01-5). Only a ladder purchase is restored (STORE-BUY-HUB): the other
   * kinds' take-backs are partial (a spent point stays spent), so a reversal
   * of those is left to a person.
   */
  async restore(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    now: Date,
  ): Promise<Record<string, unknown>> {
    const snap = (purchase.grant ?? {}) as unknown as StoreGrantSnapshot;
    const ref = storeRef(purchase.id);
    if (purchase.kind !== 'buy') return { restored: false };
    if (snap.skipped !== undefined) {
      // Nothing was given, but the fan was credited: the credits the refund
      // voided are put back, and the sales a spent one paid for are restored.
      const back = await this.creditRestore(tx, purchase, now);
      return { restored: true, ...back };
    }
    let given: Record<string, unknown> = {};
    if (purchase.buyKind === 'content' || purchase.buyKind === 'tip') {
      const { count } = await tx.purchase.updateMany({
        where: { flutterwaveTxRef: ref, status: 'failed' },
        data: { status: 'completed' },
      });
      given = { purchaseRowsRestored: count };
    } else if (
      purchase.buyKind === 'pass' &&
      purchase.communityId !== null &&
      purchase.wawuUserId !== null
    ) {
      // The days the refund took are given again, from the later of now and
      // the end of whatever the person holds, as one more period.
      const taken = (purchase.takenBack ?? {}) as { daysRemoved?: number };
      const days = Math.floor(taken.daysRemoved ?? 0);
      let granted = false;
      if (days > 0) {
        const rows = await tx.$queryRaw<{ status: string }[]>`
          SELECT "status"::text AS "status" FROM "CommunityMembership"
          WHERE "userWawuId" = ${purchase.wawuUserId} AND "communityId" = ${purchase.communityId}
          FOR UPDATE`;
        if (rows[0]?.status !== 'pending')
          granted = await grantPassPeriod(tx, {
            communityId: purchase.communityId,
            userWawuId: purchase.wawuUserId,
            reference: `${storePassReference(purchase.id)}:restored:${now.getTime()}`,
            priceKobo: BigInt(purchase.referenceKobo ?? 1),
            days,
            now,
          });
      }
      given = { passDaysRestored: granted ? days : 0 };
    } else if (purchase.buyKind === 'question') {
      // The question the refund withdrew is open again (or unanswered, if its
      // deadline has passed), and the credit it made is open again.
      given = {
        ...(await this.questions.reopen(tx, purchase, now)),
        ...(await this.creditRestore(tx, purchase, now)),
      };
    }
    const earning = await this.earnings.restore(tx, purchase, now);
    return { ...given, earning };
  }

  /** Gives a ladder purchase what its intent names, once, and records the creator's 85%. */
  private async giveBuy(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    buy: BuyContext,
    now: Date,
  ): Promise<StoreGrantSnapshot> {
    const { intent, target } = buy;
    const userId = purchase.wawuUserId;
    if (userId === null)
      throw new Error(`Purchase ${purchase.id} has no buyer to give to.`);
    // A verified sale that cannot be given as goods because its intent is gone,
    // ran out or was used, or the sale came before it: the money is not lost, the
    // fan is credited the product's list price (no creator earning).
    if (buy.late || intent === null)
      return this.credited(
        tx,
        purchase,
        userId,
        purchase.referenceKobo ?? 0,
        null,
        null,
        'late_sale',
      );
    const base = {
      kind: 'buy' as const,
      buyKind: intent.kind,
      targetId: intent.targetId,
    };
    // The piece, creator or room cannot be bought any more (taken down, free
    // now, already the person's, the person blocked or removed, the pass
    // withdrawn). The store has the payment: the fan gets a store credit worth
    // the list price and nothing is given or earned (R-101, round 3). A credit
    // that was meant to pay for it is never spent on nothing: the whole
    // purchase is undone and the fan told.
    if (target === null) {
      if (buy.creditId) throw notPayableNow();
      if (intent.kind === 'question')
        await this.questions.clearWords(tx, intent.id);
      return this.credited(
        tx,
        purchase,
        userId,
        intent.listPriceKobo,
        intent.kind,
        intent.targetId,
        'target_unavailable',
      );
    }
    let extra: Partial<StoreGrantSnapshot> = {};
    if (buy.creditId) {
      // A credit pays only for the kind its scope allows: a question credit for
      // a question, an unscoped one for a piece, a tip or a pass (R-101 point 6).
      const scope = creditScopeFor(intent.kind);
      const credit = await tx.storeCredit.findFirst({
        where: { id: buy.creditId, wawuUserId: userId, status: 'open', scope },
      });
      const { count } = await tx.storeCredit.updateMany({
        where: { id: buy.creditId, wawuUserId: userId, status: 'open', scope },
        data: { status: 'spent', spentAt: now, spentPurchaseId: purchase.id },
      });
      if (credit === null || count === 0)
        throw new StoreError(
          'store_credit_unavailable',
          'That credit has already been used.',
        );
      // Remember on the sale itself which purchase's payment paid for it, so a
      // refund of that purchase still finds it after the fan's account (and the
      // credit rows with it) is deleted.
      await tx.storePurchase.update({
        where: { id: purchase.id },
        data: {
          creditOriginId: credit.originPurchaseId ?? credit.sourcePurchaseId,
        },
      });
      // What the price did not use is not forfeited: a new open credit of the
      // rest, with the same origin (never cash, never expires).
      const rest = credit.amountKobo - intent.listPriceKobo;
      if (rest > 0)
        await tx.storeCredit.create({
          data: {
            wawuUserId: userId,
            amountKobo: rest,
            sourcePurchaseId: `${credit.sourcePurchaseId}:rem:${purchase.id}`,
            originPurchaseId:
              credit.originPurchaseId ?? credit.sourcePurchaseId,
            // The rest keeps the scope: a question credit's rest is for questions.
            scope: credit.scope,
          },
        });
    }
    if (intent.kind === 'question') {
      // The question is sent now. Its earning waits for the answer, and the
      // creator is told then (STORE-QUESTION, STORE-SALE-NOTICE). One the person
      // already has waiting on this creator cannot be sent: nothing is spent
      // (a credit's use is undone), or the payment becomes a question credit.
      const questionId = await this.questions.deliver(
        tx,
        purchase,
        intent,
        now,
      );
      if (questionId === null) {
        if (buy.creditId) throw notPayableNow();
        await this.questions.clearWords(tx, intent.id);
        return this.credited(
          tx,
          purchase,
          userId,
          intent.listPriceKobo,
          intent.kind,
          intent.targetId,
          'target_unavailable',
        );
      }
      return {
        ...base,
        questionId,
        ...(buy.creditId ? { paidWithCredit: buy.creditId } : {}),
        ...(buy.priceChanged === true ? { note: 'price_changed' } : {}),
      };
    }
    if (intent.kind === 'content' || intent.kind === 'tip') {
      // The same row the wallet path writes (UnlockWalletService, TipWalletService),
      // so every access check, the creator's tip and sale lists and the admin
      // finance streams read it as they read a wallet's.
      await tx.purchase.createMany({
        data: [
          {
            contentId: intent.kind === 'content' ? intent.targetId : null,
            type: intent.kind,
            buyerWawuId: userId,
            creatorWawuId: target.creatorWawuId,
            amount: intent.listPriceNaira,
            commissionRate: BUY_COMMISSION_RATE,
            flutterwaveTxRef: storeRef(purchase.id),
            flutterwaveTxId: null,
            status: 'completed',
            note: null,
          },
        ],
        skipDuplicates: true,
      });
    } else {
      // A member the host removed (a pending row) is not let back in by a
      // payment: recorded, flagged, nothing given. The row is locked, so a
      // removal landing now waits for this decision.
      const rows = await tx.$queryRaw<{ status: string }[]>`
        SELECT "status"::text AS "status" FROM "CommunityMembership"
        WHERE "userWawuId" = ${userId} AND "communityId" = ${intent.targetId}
        FOR UPDATE`;
      if (rows[0]?.status === 'pending') {
        if (buy.creditId) throw notPayableNow();
        return this.credited(
          tx,
          purchase,
          userId,
          intent.listPriceKobo,
          intent.kind,
          intent.targetId,
          'member_removed',
        );
      }
      await grantPassPeriod(tx, {
        communityId: intent.targetId,
        userWawuId: userId,
        reference: storePassReference(purchase.id),
        priceKobo: BigInt(intent.listPriceKobo),
        days: PASS_PERIOD_DAYS,
        now,
      });
      const pass = await tx.communityPass.findUniqueOrThrow({
        where: { walletPaymentId: storePassReference(purchase.id) },
        select: { endsAt: true },
      });
      extra = {
        communityId: intent.targetId,
        days: PASS_PERIOD_DAYS,
        until: pass.endsAt.toISOString(),
      };
    }
    const earningId = await this.earnings.record(tx, {
      purchase,
      payeeWawuUserId: target.creatorWawuId,
      buyKind: intent.kind,
      targetId: intent.targetId,
      title: target.title,
      listPriceKobo: intent.listPriceKobo,
      soldAt: purchase.purchasedAt,
    });
    // The creator is told of the sale, once, with the earning (STORE-SALE-NOTICE).
    await this.notices.told(tx, {
      purchaseId: purchase.id,
      kind: intent.kind,
      creatorWawuId: target.creatorWawuId,
      buyerWawuId: userId,
      targetId: intent.targetId,
      title: target.title,
      listPriceKobo: intent.listPriceKobo,
    });
    return {
      ...base,
      ...extra,
      earningId,
      ...(buy.creditId ? { paidWithCredit: buy.creditId } : {}),
      // The price on the piece or the room moved after the intent: the fan gets
      // what they paid for, at the price they were shown.
      ...(buy.priceChanged === true ? { note: 'price_changed' } : {}),
    };
  }

  /** The fan paid and cannot be given what they bought: a store credit worth the list price, once per purchase. */
  private async credited(
    tx: Prisma.TransactionClient,
    purchase: StorePurchase,
    userId: string,
    amountKobo: number,
    buyKind: StoreIntentKind | null,
    targetId: string | null,
    why: 'target_unavailable' | 'member_removed' | 'late_sale',
  ): Promise<StoreGrantSnapshot> {
    await tx.storeCredit.createMany({
      data: [
        {
          wawuUserId: userId,
          amountKobo,
          sourcePurchaseId: purchase.id,
          originPurchaseId: purchase.id,
          // A question that could not be sent is a question credit (R-101 point 6).
          scope: buyKind === 'question' ? QUESTION_CREDIT_SCOPE : null,
        },
      ],
      skipDuplicates: true,
    });
    const credit = await tx.storeCredit.findUniqueOrThrow({
      where: { sourcePurchaseId: purchase.id },
      select: { id: true },
    });
    return {
      kind: 'buy',
      ...(buyKind === null ? {} : { buyKind }),
      ...(targetId === null ? {} : { targetId }),
      skipped: why,
      creditId: credit.id,
      creditKobo: amountKobo,
    };
  }

  /** What a purchase gave, for the app. */
  grantedView(
    snap: StoreGrantSnapshot,
    communityId: string | null,
  ): StoreGrantedView {
    // A ladder payment that became a store credit gave nothing: no piece,
    // creator or room in the answer.
    const gave = snap.creditId === undefined;
    return {
      points: snap.points ?? null,
      credits: snap.credits ?? null,
      tierId: snap.tierId ?? null,
      extraProducts: snap.extraProducts ?? null,
      until: snap.until ?? null,
      communityId: gave ? (snap.communityId ?? communityId) : null,
      ...(snap.buyKind === undefined && gave
        ? {}
        : {
            contentId:
              gave && snap.buyKind === 'content'
                ? (snap.targetId ?? null)
                : null,
            creatorWawuId:
              gave && (snap.buyKind === 'tip' || snap.buyKind === 'question')
                ? (snap.targetId ?? null)
                : null,
            ...(snap.questionId === undefined
              ? {}
              : { questionId: snap.questionId }),
          }),
    };
  }
}

/** A purchase a store credit was to pay for can no longer be given: nothing is spent. */
function notPayableNow(): StoreError {
  return new StoreError(
    'store_intent_not_payable',
    'This is no longer available, so nothing was taken from your credit.',
  );
}

/** Refuses the way every store route does when the grant cannot be made at all. */
export function grantFailed(message: string): StoreError {
  return new StoreError('store_purchase_invalid', message);
}
