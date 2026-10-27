import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  StoreProduct,
  StorePurchaseIntent,
} from '../../generated/prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { isUniqueViolation } from '../money/prisma-unique';
import { MoneyError } from '../money/money-error';
import { neighbours } from '../price-list/price-list';
import { PriceListService } from '../price-list/price-list.service';
import {
  INTENT_KEEP_MS,
  intentCoversSale,
  intentExpiry,
  saleAfterIntent,
} from './store-buy-rules';
import { StoreBuyTargetService } from './store-buy-target.service';
import { StoreAccountService } from './store-account.service';
import { StoreCatalogService } from './store-catalog.service';
import { StoreError } from './store-error';
import type { StoreIntentDto, StorePurchaseDto } from './store.dto';
import type { StoreIntentView } from './store-view.type';

/** What `prepare` has checked, ready to open an intent from. */
export interface ReadyIntent {
  targetId: string;
  product: StoreProduct;
  accountToken: string;
  listPriceKobo: number;
}

const NOT_ON_TIP_LIST =
  'That tip is not on the tip list. Pick one of the tips shown.';

/**
 * What a ladder purchase is for, said before the store sheet opens
 * (STORE-BUY-HUB, R-101): `POST /store/intents`.
 *
 * The intent names the person, the thing (a piece, a creator to tip, a room's
 * pass) and the list price, and says which `wawu.buy.<naira>` product sells
 * it. The store purchase is then made against it, so the Hub knows what the
 * payment was for without taking the app's word at the end. Nothing is
 * charged and nothing is granted here.
 *
 * - **Checked as the wallet path checks it** (`StoreBuyTargetService`), and the
 *   price must be on the price list (`price_not_on_list`); a tip must be on the
 *   tip list.
 * - **One open intent per person, kind and target.** Asking again for the same
 *   thing at the same price in the same store returns the same intent. A
 *   different price or store replaces it (the old one becomes `replaced`; a
 *   sale already made against it still counts).
 * - **It expires** 60 minutes after it is made, and an expired one is closed
 *   the next time the person asks. It is judged at the time of the STORE SALE
 *   (`intentCoversSale`), not the time the app posts the purchase, so a
 *   payment that was slow to arrive is never lost.
 */
@Injectable()
export class StoreIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: StoreCatalogService,
    private readonly accounts: StoreAccountService,
    private readonly targets: StoreBuyTargetService,
    private readonly prices: PriceListService,
  ) {}

  async create(userId: string, dto: StoreIntentDto): Promise<StoreIntentView> {
    const ready = await this.prepare(userId, dto);
    const intent = await this.openIntent(userId, dto, ready);
    return {
      intentId: intent.id,
      productId: intent.storeProductId,
      accountToken: ready.accountToken,
      expiresAt: intent.expiresAt.toISOString(),
    };
  }

  /**
   * Everything an intent needs checked before a row is made: the store is open,
   * the price is on the list (a tip: on the tip list), a ladder product sells it
   * in that store, and the piece, creator or room can be bought by this person at
   * that price. Nothing is written.
   */
  async prepare(userId: string, dto: StoreIntentDto): Promise<ReadyIntent> {
    await this.catalog.assertOpen(dto.platform);
    const targetId = this.targetIdOf(dto);
    this.prices.assertOnList(dto.listPriceNaira);
    if (dto.kind === 'tip') this.assertOnTipList(dto.listPriceNaira);
    const listPriceKobo = dto.listPriceNaira * 100;
    const product = await this.catalog.activeBuyProduct(
      dto.platform,
      listPriceKobo,
    );
    if (product === null)
      throw new StoreError(
        'store_product_unknown',
        'That price is not sold in the store yet.',
      );
    const checked = await this.targets.check(userId, dto.kind, targetId, {
      listNaira: dto.listPriceNaira,
    });
    if (!checked.ok) throw new StoreError(checked.code, checked.message);
    const accountToken = await this.accounts.tokenFor(userId);
    return { targetId, product, accountToken, listPriceKobo };
  }

  /** The open intent for this thing: made now, or the one already open. */
  async openIntent(
    userId: string,
    dto: StoreIntentDto,
    ready: ReadyIntent,
  ): Promise<StorePurchaseIntent> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.open(userId, dto, ready.targetId, ready.product);
      } catch (e) {
        // The partial unique index is the backstop for two asks at once.
        if (isUniqueViolation(e) && attempt === 0) continue;
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  /** Deletes intents that were never used, 7 days after they ran out (STORE-BUY-HUB round 3). Used intents are kept: a purchase names them. */
  async sweepUnused(now = new Date()): Promise<number> {
    const { count } = await this.prisma.storePurchaseIntent.deleteMany({
      where: {
        status: { in: ['open', 'expired', 'replaced'] },
        expiresAt: { lt: new Date(now.getTime() - INTENT_KEEP_MS) },
      },
    });
    return count;
  }

  /**
   * The intent a purchase is made against, found before the store is asked:
   * the person's own, in this store, and for the product the app posted. An
   * intent that is not there, is not theirs or was not posted is `null`: the
   * payment is then credited rather than refused (a verified sale is never
   * lost, STORE-BUY-HUB round 4, M3). An intent that is theirs but for another
   * store or product is still refused.
   */
  async resolveForPurchase(
    userId: string,
    dto: StorePurchaseDto,
    product: StoreProduct,
  ): Promise<StorePurchaseIntent | null> {
    if (!dto.intentId) return null;
    const intent = await this.prisma.storePurchaseIntent.findUnique({
      where: { id: dto.intentId },
    });
    if (intent === null || intent.wawuUserId !== userId) return null;
    if (
      intent.platform !== dto.platform ||
      intent.productId !== product.id ||
      intent.storeProductId !== product.storeProductId
    )
      throw new StoreError(
        'store_purchase_invalid',
        'That purchase is for another product.',
      );
    return intent;
  }

  /**
   * Why a verified sale cannot be given as goods, or null when it can: there is
   * no intent, the sale came before the intent was made (an older transaction
   * re-posted under a fresh intent), or after its time ran out. The money is
   * credited in each case; goods are only granted inside the intent's window.
   */
  lateReason(
    intent: StorePurchaseIntent | null,
    soldAt: Date,
  ): 'missing' | 'before_intent' | 'expired' | null {
    if (intent === null) return 'missing';
    if (!saleAfterIntent(intent.createdAt, soldAt)) return 'before_intent';
    if (!intentCoversSale(intent.expiresAt, soldAt)) return 'expired';
    return null;
  }

  /** Writes the open intent, or returns the one already open for this thing. */
  private open(
    userId: string,
    dto: StoreIntentDto,
    targetId: string,
    product: StoreProduct,
  ): Promise<StorePurchaseIntent> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`store-intent:${userId}:${dto.kind}:${targetId}`}, 0))`;
      const now = new Date();
      // An intent whose time ran out is closed, so it does not stand in the
      // way of a new one.
      await tx.storePurchaseIntent.updateMany({
        where: {
          wawuUserId: userId,
          kind: dto.kind,
          targetId,
          status: 'open',
          expiresAt: { lte: now },
        },
        data: { status: 'expired' },
      });
      const open = await tx.storePurchaseIntent.findFirst({
        where: {
          wawuUserId: userId,
          kind: dto.kind,
          targetId,
          status: 'open',
        },
      });
      if (
        open !== null &&
        open.platform === dto.platform &&
        open.listPriceNaira === dto.listPriceNaira
      )
        return open;
      if (open !== null)
        await tx.storePurchaseIntent.update({
          where: { id: open.id },
          data: { status: 'replaced' },
        });
      return tx.storePurchaseIntent.create({
        data: {
          wawuUserId: userId,
          platform: dto.platform,
          kind: dto.kind,
          targetId,
          listPriceNaira: dto.listPriceNaira,
          listPriceKobo: dto.listPriceNaira * 100,
          productId: product.id,
          storeProductId: product.storeProductId,
          expiresAt: intentExpiry(now),
        },
      });
    });
  }

  /** The one id the kind is about; the others must not be sent. */
  private targetIdOf(dto: StoreIntentDto): string {
    const named = {
      content: dto.contentId,
      tip: dto.creatorWawuId,
      pass: dto.communityId,
    };
    const others = (Object.keys(named) as (keyof typeof named)[]).filter(
      (k) => k !== dto.kind && named[k] !== undefined,
    );
    const id = named[dto.kind];
    if (id === undefined || others.length > 0)
      throw new BadRequestException(
        'Name only the piece, creator or room this purchase is for.',
      );
    return id;
  }

  private assertOnTipList(listNaira: number): void {
    const tips = this.prices.tipList();
    if (tips.includes(listNaira)) return;
    const { lower, higher } = neighbours(tips, listNaira);
    throw new MoneyError('price_not_on_list', NOT_ON_TIP_LIST, {
      nearestLowerNaira: lower,
      nearestHigherNaira: higher,
    });
  }
}
