import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { ShopAdminService } from '../../shop/shop-admin.service';
import {
  AdminListProductsDto,
  UpdateFulfilmentDto,
} from '../../shop/dto/shop.dto';
import {
  SHOP_CATALOGUE_RETIRED_MESSAGE,
  ShopRetiredRoute,
  shopCatalogueRetired,
} from '../../shop/shop-retired';
import type { ShopFulfilment } from '../../../generated/prisma/enums';

/**
 * WAWU Shop management, `/api/hub/admin/shop/*`. The shop is retired (R-2,
 * OPS-08): creating or editing a product answers 410; reading the catalogue,
 * the order queue and dispatching a paid order stay.
 *
 * ── ROLE MATRIX ───────────────────────────────────────────────────────────
 *   read  (products, orders)     — superadmin, reviewer, support
 *   write (dispatch an order)    — superadmin, reviewer
 *   create/edit a product        — 410 for every role (guards unchanged)
 *   finance                      — refused entirely
 *
 * The same shape as admin/content and admin/events, on purpose: an admin who
 * moderates uploads manages the shop, and a third role vocabulary for a third
 * surface is how a permission model stops being reviewable.
 *
 * SUPPORT CAN READ AN ORDER because "where is my package" is the call they
 * take. They cannot mark it dispatched, because that is a claim about the
 * physical world that only the person holding the box can make.
 */
@Controller('admin/shop')
@UseGuards(AdminAuthGuard, AdminRolesGuard)
export class AdminShopController {
  constructor(private readonly service: ShopAdminService) {}

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('products')
  list(@Query() query: AdminListProductsDto) {
    return this.service.list(query);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('products/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  /** Retired with the shop: nothing new is stocked (R-2, OPS-08). */
  @ShopRetiredRoute(SHOP_CATALOGUE_RETIRED_MESSAGE)
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('products')
  create(): never {
    throw shopCatalogueRetired();
  }

  /** Retired with the shop: the catalogue is kept as it was, for past orders. */
  @ShopRetiredRoute(SHOP_CATALOGUE_RETIRED_MESSAGE)
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @ApiParam({ name: 'id', type: String })
  @Put('products/:id')
  update(): never {
    throw shopCatalogueRetired();
  }

  /**
   * The dispatch queue. Oldest paid order first — this is work to be done,
   * not a feed.
   */
  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer, AdminRole.support)
  @Get('orders')
  orders(
    @Query('fulfilment') fulfilment?: ShopFulfilment,
    @Query('page') page?: string,
    @Query('perPage') perPage?: string,
  ) {
    return this.service.orders({
      fulfilment,
      page: page ? Number(page) : undefined,
      perPage: perPage ? Number(perPage) : undefined,
    });
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Patch('orders/:id/fulfilment')
  setFulfilment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateFulfilmentDto,
  ) {
    return this.service.setFulfilment(id, dto);
  }
}
