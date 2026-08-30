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
import { AdminRole } from '../../../generated/prisma/enums';
import { AdminAuthGuard } from '../auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../auth/guards/admin-roles.guard';
import { AdminRoles } from '../auth/decorators/admin-roles.decorator';
import { ShopAdminService } from '../../shop/shop-admin.service';
import {
  AdminListProductsDto,
  UpdateFulfilmentDto,
  UpsertProductDto,
} from '../../shop/dto/shop.dto';
import type { ShopFulfilment } from '../../../generated/prisma/enums';

/**
 * WAWU Commerce management — `/api/hub/admin/shop/*`.
 *
 * ── ROLE MATRIX ───────────────────────────────────────────────────────────
 *   read  (products, orders)     — superadmin, reviewer, support
 *   write (create/edit a product,
 *          dispatch an order)    — superadmin, reviewer
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

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Post('products')
  create(@Body() dto: UpsertProductDto) {
    return this.service.create(dto);
  }

  @AdminRoles(AdminRole.superadmin, AdminRole.reviewer)
  @Put('products/:id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertProductDto,
  ) {
    return this.service.update(id, dto);
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
