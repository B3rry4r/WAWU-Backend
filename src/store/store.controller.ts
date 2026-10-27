import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { StoreCatalogService } from './store-catalog.service';
import { StoreIntentService } from './store-intent.service';
import { StorePurchaseService } from './store-purchase.service';
import {
  StoreIntentDto,
  StoreProductsQueryDto,
  StorePurchaseDto,
} from './store.dto';
import type {
  StoreIntentView,
  StoreProductListView,
  StorePurchaseView,
} from './store-view.type';

/**
 * Points, WAWU Credits, verification ticks and tiers, and community passes
 * bought through Google Play and the App Store (task IAP-01, R-86). The wallet
 * routes for the same things are unchanged and stay for the website.
 */
@ApiBearerAuth('wawu-id')
@UseGuards(WawuAuthGuard)
@Controller('store')
export class StoreController {
  constructor(
    private readonly catalog: StoreCatalogService,
    private readonly purchases: StorePurchaseService,
    private readonly intents: StoreIntentService,
  ) {}

  /**
   * The products on sale in one store, from the product map an admin keeps.
   * `available` is false (with a `reason`) when the Hub has no credentials for
   * that store yet or an admin has switched it off, and then no product is
   * listed. A price is never here: the app shows the store's own, in the
   * person's own currency. `accountToken` is the signed-in person's own id
   * for the stores: the app MUST pass it to Google Play Billing as
   * `obfuscatedAccountIdAndroid` and to StoreKit as `appAccountToken` when it
   * starts a purchase; a purchase that carries another person's token, or none,
   * is refused.
   */
  @Get('products')
  @Header('Cache-Control', 'no-store')
  products(
    @CurrentUser() user: WawuJwtClaims,
    @Query() query: StoreProductsQueryDto,
  ): Promise<StoreProductListView> {
    return this.catalog.listForApp(query.platform, user.sub);
  }

  /**
   * Says what a ladder purchase is for, BEFORE the store sheet opens
   * (STORE-BUY-HUB, R-101): a piece to unlock, a creator to tip or a room's
   * community pass, at a price on the price list. Nothing is charged or given
   * here. The answer is the store product to buy (`wawu.buy.<naira>`), the
   * person's account token (hand it to the store as for every purchase) and the
   * intent's id, which `POST /store/purchases` then carries as `intentId`. One
   * open intent per person, kind and target: asking again for the same thing
   * returns the same intent. It stays open 60 minutes; a sale made before then
   * still counts however late it is posted.
   *
   * Refusals carry `reason.code`: `price_not_on_list` (400, with the nearest
   * list prices), `store_not_configured` (503), `store_disabled` (409),
   * `store_product_unknown` (404, no store product sells that price),
   * `store_intent_target_not_found` (404), `store_intent_not_payable` (409: free,
   * their own, already theirs, no pass, removed) and `store_intent_price_changed`
   * (409: the piece's or room's price is not the one named).
   */
  @Post('intents')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  intent(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: StoreIntentDto,
  ): Promise<StoreIntentView> {
    return this.intents.create(user.sub, dto);
  }

  /**
   * Hands the Hub a purchase the store has just completed. The Hub asks the
   * store's own server about it (the app's word is never taken), then gives
   * what was bought, once per store transaction: the same call again, a
   * restore, or the store's own notice arriving first all answer the same
   * purchase with `alreadyGranted: true`. Send `purchaseToken` on `android`,
   * `transactionId` on `ios`, and `communityId` for a pass.
   *
   * Refusals carry `reason.code`: `store_not_configured` (503), `store_disabled`,
   * `store_product_unknown` (404), `store_receipt_missing` (400),
   * `store_purchase_invalid` (422), `store_purchase_pending`,
   * `store_purchase_taken` (that purchase, or that subscription, was already used on another account, or was made with another account's token), `store_purchase_other_room` (409, a pass payment was first given to another room), `store_account_token_missing` (422, the purchase carries no account token),
   * `store_pass_not_available`, `store_unreachable` (503, safe to repeat) and `store_grant_failed` (500, the store has the payment but the Hub could not finish; ask again).
   *
   * A ladder product (`wawu.buy.<naira>`) also needs `intentId` from `POST
   * /store/intents`; the Hub checks the product is the intent's and the account
   * token is the person's, and grants what the intent names once per store
   * transaction. Further codes: `store_intent_not_found` (404), `store_intent_expired`
   * (409, the store sale was after the intent's time), `store_intent_used` (409) and
   * `store_purchase_other_intent` (409, this store transaction was already given for
   * another intent). When the piece, creator or room can no longer be bought the
   * purchase is recorded with `flag: target_unavailable` and nothing is given.
   */
  @Post('purchases')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  buy(
    @CurrentUser() user: WawuJwtClaims,
    @Body() dto: StorePurchaseDto,
  ): Promise<StorePurchaseView> {
    return this.purchases.buy(user.sub, dto);
  }
}
