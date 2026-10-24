import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import type {
  StorePlatform,
  StoreProduct,
  StorePurchase,
} from '../../generated/prisma/client';
import { BlockedAccountService } from '../blocked-account/blocked-account.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUniqueViolation } from '../money/prisma-unique';
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
  type StoreGrantSnapshot,
} from './store-grant.service';
import { isSubscriptionKind } from './store-grants';
import { StoreCatalogService } from './store-catalog.service';
import {
  DISABLED_MESSAGE,
  NOT_CONFIGURED_MESSAGE,
  StoreError,
  UNREACHABLE_MESSAGE,
} from './store-error';
import type { StorePurchaseDto } from './store.dto';
import type { StorePurchaseView } from './store-view.type';

export const PASS_ROOM_MISSING = 'We could not find that room.';
export const PASS_NOT_SOLD = 'This room does not sell a pass.';
export const PASS_OWN_ROOM = 'You host this room, so you do not need a pass.';
export const PASS_REMOVED =
  'The host has removed you from this room. Ask the host to let you back in.';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    private readonly grants: StoreGrantService,
    private readonly blocked: BlockedAccountService,
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

    const settled = await this.settle({
      userId,
      product,
      verified,
      communityId,
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
  async assertOpen(platform: StorePlatform): Promise<void> {
    const a = await this.catalog.availability(platform);
    if (!a.configured)
      throw new StoreError('store_not_configured', NOT_CONFIGURED_MESSAGE);
    if (!a.enabled) throw new StoreError('store_disabled', DISABLED_MESSAGE);
  }

  /**
   * Writes the purchase and gives what it sold, once per store transaction.
   * Returns the existing row when the transaction was granted before (whoever
   * it was granted to: the caller compares the owner).
   */
  async settle(args: {
    userId: string;
    product: StoreProduct;
    verified: VerifiedStorePurchase;
    communityId: string | null;
  }): Promise<Settled> {
    const { userId, product, verified, communityId } = args;
    const platform = verified.platform;
    const key = {
      platform_storeTransactionId: {
        platform,
        storeTransactionId: verified.storeTransactionId,
      },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const existing = await this.prisma.storePurchase.findUnique({
        where: key,
      });
      if (existing !== null)
        return { purchase: existing, alreadyGranted: true };
      const fee = (await this.catalog.availability(platform)).feeBps;
      const referenceKobo = product.referenceKobo;
      const netKobo = referenceKobo === null ? null : netOf(referenceKobo, fee);
      let creatorWawuUserId: string | null = null;
      if (product.kind === 'pass' && communityId !== null) {
        const room = await this.prisma.community.findUnique({
          where: { id: communityId },
          select: { hostWawuId: true },
        });
        creatorWawuUserId = room?.hostWawuId ?? null;
      }
      const creatorShareKobo =
        creatorWawuUserId !== null && netKobo !== null
          ? creatorShareOf(netKobo)
          : null;
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`store-purchase:${platform}:${verified.storeTransactionId}`}, 0))`;
          const again = await tx.storePurchase.findUnique({ where: key });
          if (again !== null) return { purchase: again, alreadyGranted: true };
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
              communityId: product.kind === 'pass' ? communityId : null,
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
          const snap = await this.grants.give(tx, row, product, now);
          const done = await tx.storePurchase.update({
            where: { id: row.id },
            data: { grant: snap as unknown as Prisma.InputJsonValue },
          });
          return { purchase: done, alreadyGranted: false };
        });
      } catch (e) {
        // A racing grant of the same store transaction won; read it next time round.
        if (isUniqueViolation(e) && attempt === 0) continue;
        throw e;
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
    return {
      id: purchase.id,
      platform: purchase.platform,
      storeProductId: product.storeProductId,
      kind: product.kind,
      status: purchase.status,
      alreadyGranted,
      grant: this.grants.grantedView(snap, purchase.communityId),
      purchasedAt: purchase.purchasedAt.toISOString(),
      expiresAt: purchase.expiresAt?.toISOString() ?? null,
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

function invalid(message: string): StoreError {
  return new StoreError('store_purchase_invalid', message);
}

/** A short tag for a log line that must not carry a purchase token. */
export function hashOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
