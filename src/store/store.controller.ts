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
import { StorePurchaseService } from './store-purchase.service';
import { StoreProductsQueryDto, StorePurchaseDto } from './store.dto';
import type {
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
  ) {}

  /**
   * The products on sale in one store, from the product map an admin keeps.
   * `available` is false (with a `reason`) when the Hub has no credentials for
   * that store yet or an admin has switched it off, and then no product is
   * listed. A price is never here: the app shows the store's own, in the
   * person's own currency.
   */
  @Get('products')
  @Header('Cache-Control', 'no-store')
  products(
    @Query() query: StoreProductsQueryDto,
  ): Promise<StoreProductListView> {
    return this.catalog.listForApp(query.platform);
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
   * `store_purchase_taken` (that transaction was already used on another account),
   * `store_pass_not_available` and `store_unreachable` (503, safe to repeat).
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
