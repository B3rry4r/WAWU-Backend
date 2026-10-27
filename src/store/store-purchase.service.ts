import { createHash } from 'node:crypto';
import {
  HttpException,
  Inject,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type {
  StorePlatform,
  StoreProduct,
  StorePurchase,
  StorePurchaseIntent,
} from '../../generated/prisma/client';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUniqueViolation } from '../money/prisma-unique';
import { TIER_REQUIRED_MESSAGE } from '../plans/purchases/extra-products-rules';
import {
  APP_STORE_CLIENT,
  GOOGLE_PLAY_CLIENT,
  StorePurchaseNotFound,
  StoreUnreachable,
  type AppStoreClient,
  type GooglePlayClient,
  type VerifiedStorePurchase,
} from './clients/store-clients';
import {
  creatorShareOf,
  netOf,
  StoreGrantService,
  type BuyContext,
  type StoreGrantSnapshot,
} from './store-grant.service';
import { creatorShareOfList } from './store-buy-rules';
import { StoreBuyTargetService } from './store-buy-target.service';
import { StoreIntentService } from './store-intent.service';
import { StoreCreditService } from './store-credit.service';
import { isSubscriptionKind } from './store-grants';
import { StoreAccountService } from './store-account.service';
import { StoreCatalogService } from './store-catalog.service';
import {
  GRANT_FAILED_MESSAGE,
  OTHER_INTENT_MESSAGE,
  OTHER_ROOM_MESSAGE,
  StoreError,
  UNREACHABLE_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
} from './store-error';
import type { StoreIntentDto, StorePurchaseDto } from './store.dto';
import type { StoreIntentView, StorePurchaseView } from './store-view.type';

export const PASS_ROOM_MISSING = 'We could not find that room.';
export const PASS_NOT_SOLD = 'This room does not sell a pass.';
export const PASS_OWN_ROOM = 'You host this room, so you do not need a pass.';
export const PASS_REMOVED =
  'The host has removed you from this room. Ask the host to let you back in.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SettleArgs {
  userId: string;
  product: StoreProduct;
  verified: VerifiedStorePurchase;
  communityId: string | null;
  /** The intent a ladder purchase is made against; null for every other kind. */
  intent?: StorePurchaseIntent | null;
  /** A store credit that pays for this purchase instead of a store sale; consumed whole in the same transaction. */
  creditId?: string | null;
  /** A ladder sale that cannot be given as goods (no intent, outside its window): recorded and credited. */
  late?: 'missing' | 'before_intent' | 'expired' | 'used' | null;
}

export interface Settled {
  purchase: StorePurchase;
  /** False when this call wrote the grant; true when the store transaction had been granted before. */
  alreadyGranted: boolean;
}

/**
 * Buying through the app stores (task IAP-01, R-86): `POST /store/purchases`.
 *
 * The order is fixed, and the second step is the whole point:
 *  1. the store switch and the credentials are checked (nothing is asked of a
 *     store the Hub has no keys for);
 *  2. the purchase is asked of the STORE'S OWN SERVER (Google's API as the
 *     Hub's service account; Apple's API with its signed answer checked): the
 *     app's word is never taken, only the ids it names;
 *  3. in one short database transaction, under a lock keyed by the store
 *     transaction, the purchase row is written (unique on platform and the
 *     store's transaction id) and the SAME grant code the wallet paths use
 *     gives what was sold. A replay, a restore and a webhook that races the
 *     app each find the row and give nothing more;
 *  4. only then is a Google purchase acknowledged or consumed.
 *
 * No connection or lock is held across a call to a store.
 */
@Injectable()
export class StorePurchaseService {
  private readonly logger = new Logger(StorePurchaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StoreCatalogService,
    private readonly accounts: StoreAccountService,
    private readonly grants: StoreGrantService,
    private readonly blocked: BlockedAccountService,
    private readonly intents: StoreIntentService,
    private readonly targets: StoreBuyTargetService,
    private readonly credits: StoreCreditService,
    @Optional()
    @Inject(GOOGLE_PLAY_CLIENT)
    private readonly google: GooglePlayClient | null,
    @Optional()
    @Inject(APP_STORE_CLIENT)
    private readonly apple: AppStoreClient | null,
  ) {}

  // -------------------------------------------------------------------------
  // The route
  // -------------------------------------------------------------------------

  async buy(userId: string, dto: StorePurchaseDto): Promise<StorePurchaseView> {
    await this.assertOpen(dto.platform);
    const product = await this.catalog.activeProduct(
      dto.platform,
      dto.productId,
    );
    const communityId = await this.checkRequest(userId, dto, product);
    // A ladder purchase is made against an intent (STORE-BUY-HUB): the person's
    // own, for this store and this product, found before the store is asked.
    // Without one (missing, not theirs) the sale is credited after it verifies.
    const intent =
      product.kind === 'buy'
        ? await this.intents.resolveForPurchase(userId, dto, product)
        : null;
    const verified = await this.verify(dto, product);
    if (verified.storeProductId !== product.storeProductId)
      throw invalid('That purchase is for another product.');
    if (verified.state === 'pending')
      throw new StoreError(
        'store_purchase_pending',
        'The store has not finished taking the payment yet. Please check again in a moment.',
      );
    if (verified.state !== 'purchased')
      throw invalid('The store says this purchase is not in force.');
    // The purchase must be this person's: the store's answer carries the account
    // token the app bound it to (a purchase token alone proves nothing).
    await this.accounts.assertBound(userId, product.kind, verified);
    // A pass is for the room the sheet was opened for: where the store recorded
    // that room, a different one is refused, so the room on screen can never be
    // swapped in for a held transaction's own (IAP-03 round 2, F2b).
    if (
      product.kind === 'pass' &&
      verified.roomToken &&
      communityId !== null &&
      verified.roomToken.toLowerCase() !== communityId.toLowerCase()
    )
      throw new StoreError('store_purchase_other_room', OTHER_ROOM_MESSAGE);

    // The sale must fall inside the intent's window to be given as goods. It is
    // the STORE's time of sale that counts, not when the app posted it: a payment
    // that was slow to arrive is never refused for that. A verified sale outside
    // the window, or with no intent, is not lost: it is recorded and credited.
    const late =
      product.kind === 'buy'
        ? this.intents.lateReason(intent, verified.purchasedAt)
        : null;

    const settled = await this.settle({
      userId,
      product,
      verified,
      communityId,
      intent,
      late,
    });
    if (settled.purchase.wawuUserId !== userId)
      throw new StoreError(
        'store_purchase_taken',
        'That purchase was already used on another account.',
      );
    await this.acknowledge(dto, product, verified);
    return this.view(settled.purchase, product, settled.alreadyGranted);
  }

  // -------------------------------------------------------------------------
  // Shared with the notifications
  // -------------------------------------------------------------------------

  /** The store switch and credentials, as the routes answer them. */
  assertOpen(platform: StorePlatform): Promise<void> {
    return this.catalog.assertOpen(platform);
  }

  /**
   * Writes the purchase and gives what it sold, once per store transaction.
   * Returns the existing row when the transaction was granted before (whoever
   * it was granted to: the caller compares the owner).
   */
  async settle(args: SettleArgs): Promise<Settled> {
    const { userId, product, verified, communityId } = args;
    const intent = args.intent ?? null;
    const isBuy = product.kind === 'buy';
    const platform = verified.platform;
    const key = {
      platform_storeTransactionId: {
        platform,
        storeTransactionId: verified.storeTransactionId,
      },
    };
    const subscriptionKey = verified.subscriptionKey;
    const holderKey =
      subscriptionKey === null
        ? null
        : { platform_subscriptionKey: { platform, subscriptionKey } };
    // A subscription is held by the person who first bought it, whatever the
    // order id: a later order of it is refused to anyone else.
    if (holderKey !== null) {
      const holder = await this.prisma.storeSubscription.findUnique({
        where: holderKey,
      });
      if (holder !== null && holder.wawuUserId !== userId) throw taken();
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.prisma.storePurchase.findUnique({
        where: key,
      });
      if (existing !== null)
        return heldBy(existing, userId, communityId, intent);
      const fee = (await this.catalog.availability(platform)).feeBps;
      // A ladder purchase is worth the list price its intent named, whatever
      // the product row says now. The store price is made so that WAWU receives
      // at least that (R-101 point 2), so the net recorded is the list price
      // itself and the store's cut is not taken off it: the creator's 85% is of
      // the list price.
      const referenceKobo =
        intent !== null && args.late == null
          ? intent.listPriceKobo
          : product.referenceKobo;
      const netKobo =
        referenceKobo === null
          ? null
          : isBuy
            ? referenceKobo
            : netOf(referenceKobo, fee);
      let creatorWawuUserId: string | null = null;
      let buy: BuyContext | null = null;
      if (isBuy && (intent === null || args.late != null)) {
        // A late sale: credited the product's list price, no creator.
        buy = { intent: null, target: null, late: args.late ?? 'missing' };
      } else if (intent !== null) {
        // Asked again now, outside the transaction (a block is read from
        // another table): the piece may have been taken down since the intent.
        const checked = await this.targets.check(
          userId,
          intent.kind,
          intent.targetId,
          { listNaira: intent.listPriceNaira, tolerateChangedPrice: true },
        );
        buy = {
          intent,
          target: checked.ok ? checked.target : null,
          priceChanged: checked.ok && checked.priceChanged === true,
          creditId: args.creditId ?? null,
        };
        creatorWawuUserId = buy.target?.creatorWawuId ?? null;
      } else if (product.kind === 'pass' && communityId !== null) {
        const room = await this.prisma.community.findUnique({
          where: { id: communityId },
          select: { hostWawuId: true },
        });
        creatorWawuUserId = room?.hostWawuId ?? null;
      }
      const creatorShareKobo =
        creatorWawuUserId === null
          ? null
          : intent !== null && args.late == null
            ? creatorShareOfList(intent.listPriceKobo)
            : netKobo !== null
              ? creatorShareOf(netKobo)
              : null;
      try {
        return await this.prisma.$transaction(async (tx) => {
          if (holderKey !== null) {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`store-subscription:${platform}:${subscriptionKey}`}, 0))`;
            const holder = await tx.storeSubscription.findUnique({
              where: holderKey,
            });
            if (holder !== null && holder.wawuUserId !== userId) throw taken();
          }
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`store-purchase:${platform}:${verified.storeTransactionId}`}, 0))`;
          const again = await tx.storePurchase.findUnique({ where: key });
          if (again !== null) return heldBy(again, userId, communityId, intent);
          // One intent, one purchase: a second store transaction against an
          // intent already used is not refused (the store has the money): it is
          // recorded and credited, linked to no intent.
          let lateInTx = args.late ?? null;
          if (intent !== null && lateInTx === null) {
            const rows = await tx.$queryRaw<{ status: string }[]>`
              SELECT "status"::text AS "status" FROM "StorePurchaseIntent"
              WHERE "id" = ${intent.id} FOR UPDATE`;
            if (rows[0]?.status === 'used') lateInTx = 'used';
          }
          const linked = intent !== null && lateInTx === null;
          const grantBuy: BuyContext | null =
            lateInTx !== null
              ? { intent: null, target: null, late: lateInTx }
              : buy;
          if (holderKey !== null && subscriptionKey !== null)
            await tx.storeSubscription.upsert({
              where: holderKey,
              create: {
                platform,
                subscriptionKey,
                wawuUserId: userId,
                // A subscription is a tier's; a pass is bought once and has no holder row.
                communityId: null,
              },
              update: {},
            });
          const now = new Date();
          const row = await tx.storePurchase.create({
            data: {
              wawuUserId: userId,
              platform,
              storeTransactionId: verified.storeTransactionId,
              subscriptionKey: verified.subscriptionKey,
              productId: product.id,
              storeProductId: product.storeProductId,
              kind: product.kind,
              environment: verified.environment,
              communityId: linked
                ? intent.kind === 'pass'
                  ? intent.targetId
                  : null
                : product.kind === 'pass'
                  ? communityId
                  : null,
              ...(linked
                ? {
                    intentId: intent.id,
                    buyKind: intent.kind,
                    targetId: intent.targetId,
                  }
                : {}),
              grant: {},
              referenceKobo,
              storeFeeBps: fee,
              netKobo,
              creatorWawuUserId,
              creatorShareKobo,
              currency: verified.currency,
              priceMicros: verified.priceMicros,
              purchasedAt: verified.purchasedAt,
              expiresAt: verified.expiresAt,
            },
          });
          const snap = await this.grants.give(tx, row, product, now, grantBuy);
          if (linked)
            await tx.storePurchaseIntent.update({
              where: { id: intent.id },
              data: { status: 'used', usedAt: now },
            });
          const done = await tx.storePurchase.update({
            where: { id: row.id },
            data: {
              grant: snap as unknown as Prisma.InputJsonValue,
              // Paid but not given (a pass renewal for a removed member, a ladder
              // purchase whose target is gone, which became a store credit), or
              // given at the intent's price after the price moved: an admin looks.
              ...(snap.skipped === undefined && snap.note === undefined
                ? {}
                : { flag: snap.skipped ?? snap.note, flaggedAt: now }),
            },
          });
          return { purchase: done, alreadyGranted: false };
        });
      } catch (e) {
        // A racing grant of the same store transaction won; read it next time round.
        if (isUniqueViolation(e) && attempt === 0) continue;
        // A refusal is the caller's answer; anything else is a fault on our side
        // after the store took the payment. Named, logged by kind only, and
        // retried by the next post or the store's next notice (nothing was kept).
        if (e instanceof HttpException) throw e;
        this.logger.error(
          `store purchase ${platform} ${hashOf(verified.storeTransactionId)}: the grant failed (${e instanceof Error ? e.name : 'error'}: ${e instanceof Error ? e.message.slice(0, 160) : ''}); nothing was kept, the next ask tries again`,
        );
        throw new StoreError('store_grant_failed', GRANT_FAILED_MESSAGE);
      }
    }
    throw new Error('unreachable');
  }

  /** Google: tells the store the purchase is delivered (consume a pack, acknowledge a subscription). Never fails the purchase. */
  async acknowledge(
    dto: Pick<StorePurchaseDto, 'platform' | 'purchaseToken'>,
    product: StoreProduct,
    verified: VerifiedStorePurchase,
  ): Promise<void> {
    if (dto.platform !== 'android' || !verified.needsAcknowledge) return;
    if (this.google === null || !dto.purchaseToken) return;
    try {
      if (isSubscriptionKind(product.kind))
        await this.google.acknowledgeSubscription(
          product.storeProductId,
          dto.purchaseToken,
        );
      else await this.google.consume(product.storeProductId, dto.purchaseToken);
    } catch {
      // The grant stands. The next ask of this purchase (the app's restore, or
      // Google's notification) tries again; Google pays back an unacknowledged
      // purchase after three days, which arrives here as a take-back.
      this.logger.warn(
        `store purchase ${hashOf(dto.purchaseToken)}: it was granted but Google would not take the acknowledgement; it is tried again on the next ask`,
      );
    }
  }

  /** The app's view of a purchase. */
  view(
    purchase: StorePurchase,
    product: Pick<StoreProduct, 'storeProductId' | 'kind'>,
    alreadyGranted: boolean,
  ): StorePurchaseView {
    const snap = (purchase.grant ?? {}) as unknown as StoreGrantSnapshot;
    const credited =
      snap.creditId !== undefined && purchase.status === 'granted';
    return {
      id: purchase.id,
      platform: purchase.platform,
      storeProductId: product.storeProductId,
      kind: product.kind,
      status: credited ? 'credited' : purchase.status,
      alreadyGranted,
      grant: this.grants.grantedView(snap, purchase.communityId),
      purchasedAt: purchase.purchasedAt.toISOString(),
      expiresAt: purchase.expiresAt?.toISOString() ?? null,
      flag: purchase.flag,
      ...(purchase.kind === 'buy'
        ? {
            buyKind: purchase.buyKind,
            intentId: purchase.intentId,
            targetId: purchase.targetId,
            credit:
              snap.creditId === undefined
                ? null
                : {
                    id: snap.creditId,
                    amountKobo: snap.creditKobo ?? 0,
                    message: creditMessage(
                      purchase.buyKind,
                      snap.creditKobo ?? 0,
                      purchase.flag === 'late_sale',
                    ),
                  },
            paidWithCredit: snap.paidWithCredit ?? null,
          }
        : {}),
    };
  }

  /**
   * Pays for a ladder purchase with a store credit (STORE-BUY-HUB round 3):
   * `POST /store/intents` with `payWith: credit`. The thing is checked as for a
   * store purchase; a credit worth at least the price (the smallest that fits)
   * is consumed whole and the purchase is granted at once, in one transaction,
   * with no store sheet. The creator's 85% of the list price is recorded as for
   * any sale. If the piece, creator or room is gone by then, nothing is spent.
   */
  async payWithCredit(
    userId: string,
    dto: StoreIntentDto,
  ): Promise<StoreIntentView> {
    const ready = await this.intents.prepare(userId, dto);
    const credit = await this.credits.pick(userId, ready.listPriceKobo);
    const intent = await this.intents.openIntent(userId, dto, ready);
    const now = new Date();
    const verified: VerifiedStorePurchase = {
      platform: dto.platform,
      environment: 'production',
      storeProductId: ready.product.storeProductId,
      // One credit, one purchase: the unique key on the transaction id is the
      // once-only gate, as a store's own id is for a store sale.
      storeTransactionId: `credit:${credit.id}`,
      subscriptionKey: null,
      purchasedAt: now,
      expiresAt: null,
      currency: null,
      priceMicros: null,
      state: 'purchased',
      needsAcknowledge: false,
      accountToken: ready.accountToken,
    };
    const settled = await this.settle({
      userId,
      product: ready.product,
      verified,
      communityId: null,
      intent,
      creditId: credit.id,
    });
    return {
      intentId: intent.id,
      productId: intent.storeProductId,
      accountToken: ready.accountToken,
      expiresAt: intent.expiresAt.toISOString(),
      purchase: this.view(
        settled.purchase,
        ready.product,
        settled.alreadyGranted,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // Steps
  // -------------------------------------------------------------------------

  /** What the request must name for its store and product; returns the room of a pass. */
  private async checkRequest(
    userId: string,
    dto: StorePurchaseDto,
    product: StoreProduct,
  ): Promise<string | null> {
    if (dto.platform === 'android' && !dto.purchaseToken)
      throw new StoreError(
        'store_receipt_missing',
        'A Google Play purchase needs its purchase token.',
      );
    if (dto.platform === 'ios' && !dto.transactionId)
      throw new StoreError(
        'store_receipt_missing',
        'An App Store purchase needs its transaction id.',
      );
    if (dto.intentId && product.kind !== 'buy')
      throw new StoreError(
        'store_purchase_invalid',
        'This product is not bought against an intent.',
      );
    if (product.kind === 'buy') return null;
    if (product.kind === 'extra_products') {
      // Checked before the store is asked: the products are kept on the
      // person's tier row, and a person who has never held a tier has none.
      const held = await this.prisma.makerTier.findUnique({
        where: { wawuUserId: userId },
        select: { wawuUserId: true },
      });
      if (held === null)
        throw new StoreError('store_purchase_invalid', TIER_REQUIRED_MESSAGE);
      return null;
    }
    if (product.kind !== 'pass') return null;
    const communityId = dto.communityId;
    if (!communityId || !UUID.test(communityId))
      throw new StoreError(
        'store_receipt_missing',
        'A community pass needs the room it is for.',
      );
    const room = await this.prisma.community.findUnique({
      where: { id: communityId },
      select: {
        hostWawuId: true,
        passPrice: { select: { communityId: true } },
      },
    });
    const na = (m: string) => new StoreError('store_pass_not_available', m);
    if (!room) throw na(PASS_ROOM_MISSING);
    if (room.hostWawuId === userId) throw na(PASS_OWN_ROOM);
    if (await this.blocked.isBlockedEitherWay(userId, room.hostWawuId))
      throw na(PASS_ROOM_MISSING);
    if (!room.passPrice) throw na(PASS_NOT_SOLD);
    const membership = await this.prisma.communityMembership.findUnique({
      where: { userWawuId_communityId: { userWawuId: userId, communityId } },
      select: { status: true },
    });
    if (membership?.status === 'pending') throw na(PASS_REMOVED);
    return communityId;
  }

  /** Asks the store's own server. A transport failure is `store_unreachable`, never a verdict. */
  private async verify(
    dto: StorePurchaseDto,
    product: StoreProduct,
  ): Promise<VerifiedStorePurchase> {
    try {
      if (dto.platform === 'android') {
        const client = this.google;
        if (client === null)
          throw new StoreError('store_not_configured', NOT_CONFIGURED_MESSAGE);
        const token = dto.purchaseToken ?? '';
        return isSubscriptionKind(product.kind)
          ? await client.verifySubscription(token)
          : await client.verifyOneTime(product.storeProductId, token);
      }
      const client = this.apple;
      if (client === null)
        throw new StoreError('store_not_configured', NOT_CONFIGURED_MESSAGE);
      return await client.verifyTransaction(dto.transactionId ?? '');
    } catch (e) {
      if (e instanceof StorePurchaseNotFound)
        throw invalid('The store does not know that purchase.');
      if (e instanceof StoreUnreachable)
        throw new StoreError('store_unreachable', UNREACHABLE_MESSAGE);
      throw e;
    }
  }
}

/**
 * A store transaction the Hub already has. It is returned as granted, with one
 * refusal: a community pass is bound to the person AND the room it first
 * granted, so the same person naming another room for it gets nothing (the
 * room on screen is never swapped in for a held transaction's own, IAP-03
 * round 2, F2b). Another person's is returned and refused by the caller.
 */
function heldBy(
  existing: StorePurchase,
  userId: string,
  communityId: string | null,
  intent: StorePurchaseIntent | null = null,
): Settled {
  // A ladder transaction is bound to the intent it first granted: the same
  // person naming another one for it gets nothing (their payment was for the
  // first). Another person's is returned and refused by the caller.
  if (
    existing.kind === 'buy' &&
    existing.wawuUserId === userId &&
    intent !== null &&
    existing.intentId !== null &&
    existing.intentId !== intent.id
  )
    throw new StoreError('store_purchase_other_intent', OTHER_INTENT_MESSAGE);
  if (
    existing.kind === 'pass' &&
    existing.wawuUserId === userId &&
    existing.communityId !== communityId
  )
    throw new StoreError('store_purchase_other_room', OTHER_ROOM_MESSAGE);
  return { purchase: existing, alreadyGranted: true };
}

function taken(): StoreError {
  return new StoreError(
    'store_purchase_taken',
    'That purchase was already used on another account.',
  );
}

function invalid(message: string): StoreError {
  return new StoreError('store_purchase_invalid', message);
}

/** A short tag for a log line that must not carry a purchase token. */
export function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

/** ₦ with thousands separators, no decimals. */
function naira(kobo: number): string {
  return `₦${Math.floor(kobo / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** The sentence the app shows when a paid purchase could not be given and became a store credit. */
export function creditMessage(
  buyKind: StorePurchase['buyKind'],
  creditKobo: number,
  late = false,
): string {
  const lead = late
    ? 'This purchase could not be finished in time.'
    : buyKind === 'tip'
      ? 'This creator can no longer be tipped.'
      : buyKind === 'pass'
        ? 'This pass is no longer available.'
        : 'This piece is no longer available.';
  return `${lead} You have a ${naira(creditKobo)} credit to use on Who Made This.`;
}
