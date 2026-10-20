import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { OptionalWawuAuthGuard } from '../search-response/guards/optional-wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ShopService } from './shop.service';
import { VerifyShopOrderDto } from './dto/shop.dto';
import {
  SHOP_RETIRED_MESSAGE,
  ShopRetiredRoute,
  shopRetired,
} from './shop-retired';

/**
 * WAWU Shop, retired: `/api/hub/shop/*` (R-2, OPS-08).
 *
 * Browsing, the cart and checkout answer 410 Gone. A buyer's orders and the
 * settling of a charge opened before the shop closed still work; see
 * `shop-retired.ts` for why each one stays.
 *
 * ── ROUTE ORDER ───────────────────────────────────────────────────────────
 * Every static segment (`/cart`, `/orders`, `/categories`) is declared BEFORE
 * `:slug`, or the catch-all swallows them. The retired routes stay mounted,
 * with the guards they always had, so an old client gets a clear 410 rather
 * than a 404 that reads as a broken link.
 */
@Controller('shop')
export class ShopController {
  constructor(private readonly service: ShopService) {}

  /* ---- browsing: retired ---- */

  @ShopRetiredRoute(SHOP_RETIRED_MESSAGE)
  @UseGuards(OptionalWawuAuthGuard)
  @Get('products')
  listProducts(): never {
    throw shopRetired();
  }

  @ShopRetiredRoute(SHOP_RETIRED_MESSAGE)
  @UseGuards(OptionalWawuAuthGuard)
  @ApiParam({ name: 'category', type: String })
  @Get('categories/:category/subcategories')
  subcategories(): never {
    throw shopRetired();
  }

  /* ---- cart: retired ---- */

  @ShopRetiredRoute(SHOP_RETIRED_MESSAGE)
  @UseGuards(WawuAuthGuard)
  @Get('cart')
  cart(): never {
    throw shopRetired();
  }

  @ShopRetiredRoute(SHOP_RETIRED_MESSAGE)
  @UseGuards(WawuAuthGuard)
  @Post('cart')
  addToCart(): never {
    throw shopRetired();
  }

  @ShopRetiredRoute(SHOP_RETIRED_MESSAGE)
  @UseGuards(WawuAuthGuard)
  @ApiParam({ name: 'productId', type: String })
  @Patch('cart/:productId')
  setQuantity(): never {
    throw shopRetired();
  }

  @ShopRetiredRoute(SHOP_RETIRED_MESSAGE)
  @UseGuards(WawuAuthGuard)
  @ApiParam({ name: 'productId', type: String })
  @Delete('cart/:productId')
  removeFromCart(): never {
    throw shopRetired();
  }

  /* ---- checkout: retired ---- */

  @ShopRetiredRoute(SHOP_RETIRED_MESSAGE)
  @UseGuards(WawuAuthGuard)
  @Post('checkout')
  checkout(): never {
    throw shopRetired();
  }

  /* ---- orders: still served ---- */

  /**
   * Settles a charge opened before the shop closed. Idempotent: a paid order
   * comes back as it is.
   */
  @UseGuards(WawuAuthGuard)
  @Post('orders/:orderId/verify')
  verify(
    @CurrentUser() user: WawuJwtClaims,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: VerifyShopOrderDto,
  ) {
    return this.service.verifyOrder(user.sub, orderId, dto);
  }

  @UseGuards(WawuAuthGuard)
  @Get('orders')
  myOrders(@CurrentUser() user: WawuJwtClaims) {
    return this.service.myOrders(user.sub);
  }

  @UseGuards(WawuAuthGuard)
  @Get('orders/:orderId')
  order(
    @CurrentUser() user: WawuJwtClaims,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.service.getOrder(user.sub, orderId);
  }

  /**
   * One product by slug: retired. LAST, because `:slug` would otherwise
   * swallow `/cart`, `/orders` and `/categories`.
   */
  @ShopRetiredRoute(SHOP_RETIRED_MESSAGE)
  @UseGuards(OptionalWawuAuthGuard)
  @ApiParam({ name: 'slug', type: String })
  @Get(':slug')
  product(): never {
    throw shopRetired();
  }
}
