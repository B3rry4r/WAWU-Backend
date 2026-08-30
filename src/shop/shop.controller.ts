import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { WawuAuthGuard } from '../common/guards/wawu-auth.guard';
import { OptionalWawuAuthGuard } from '../search-response/guards/optional-wawu-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { WawuJwtClaims } from '../common/auth/wawu-jwt-claims.interface';
import { ShopService } from './shop.service';
import {
  AddToCartDto,
  CheckoutDto,
  ListProductsDto,
  SetCartQuantityDto,
  VerifyShopOrderDto,
} from './dto/shop.dto';
import type { ProductCategory } from '../../generated/prisma/enums';

/**
 * WAWU Commerce — `/api/hub/shop/*`.
 *
 * ── WHO CAN SEE WHAT ──────────────────────────────────────────────────────
 * BROWSING IS PUBLIC. A storefront a stranger cannot open sells nothing, and
 * a shared product link has to work before somebody has an account. Everything
 * that touches a cart, an order or money needs a token.
 *
 * ── ROUTE ORDER ───────────────────────────────────────────────────────────
 * Every static segment (`/cart`, `/orders`, `/categories`) is declared BEFORE
 * `:slug`, or the catch-all swallows them. This codebase has been bitten by
 * exactly that shape before.
 */
@Controller('shop')
export class ShopController {
  constructor(private readonly service: ShopService) {}

  /* ---- browsing: public ---- */

  @UseGuards(OptionalWawuAuthGuard)
  @Get('products')
  listProducts(@Query() query: ListProductsDto) {
    return this.service.listProducts(query);
  }

  /** The subcategories in an aisle that actually have stock. */
  @UseGuards(OptionalWawuAuthGuard)
  @Get('categories/:category/subcategories')
  subcategories(@Param('category') category: ProductCategory) {
    return this.service.listSubcategories(category);
  }

  /* ---- cart: the brief's "WOW" ---- */

  @UseGuards(WawuAuthGuard)
  @Get('cart')
  cart(@CurrentUser() user: WawuJwtClaims) {
    return this.service.getCart(user.sub);
  }

  @UseGuards(WawuAuthGuard)
  @Post('cart')
  addToCart(@CurrentUser() user: WawuJwtClaims, @Body() dto: AddToCartDto) {
    return this.service.addToCart(user.sub, dto.productId, dto.quantity);
  }

  @UseGuards(WawuAuthGuard)
  @Patch('cart/:productId')
  setQuantity(
    @CurrentUser() user: WawuJwtClaims,
    @Param('productId', ParseUUIDPipe) productId: string,
    @Body() dto: SetCartQuantityDto,
  ) {
    return this.service.setCartQuantity(user.sub, productId, dto.quantity);
  }

  @UseGuards(WawuAuthGuard)
  @Delete('cart/:productId')
  removeFromCart(
    @CurrentUser() user: WawuJwtClaims,
    @Param('productId', ParseUUIDPipe) productId: string,
  ) {
    return this.service.removeFromCart(user.sub, productId);
  }

  /* ---- checkout and orders ---- */

  /** Opens a charge. Nothing is reserved and no stock moves until verify. */
  @UseGuards(WawuAuthGuard)
  @Post('checkout')
  checkout(@CurrentUser() user: WawuJwtClaims, @Body() dto: CheckoutDto) {
    return this.service.checkout(user.sub, dto);
  }

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
   * One product by slug. LAST, because `:slug` would otherwise swallow
   * `/cart`, `/orders` and `/categories`.
   */
  @UseGuards(OptionalWawuAuthGuard)
  @Get(':slug')
  product(@Param('slug') slug: string) {
    return this.service.getProduct(slug);
  }
}
