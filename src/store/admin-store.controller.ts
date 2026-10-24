import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminRole, StorePlatform } from '../../generated/prisma/enums';
import { AdminRoles } from '../admin/auth/decorators/admin-roles.decorator';
import { CurrentAdmin } from '../admin/auth/decorators/current-admin.decorator';
import { AdminAuthGuard } from '../admin/auth/guards/admin-auth.guard';
import { AdminRolesGuard } from '../admin/auth/guards/admin-roles.guard';
import type { AdminUserView } from '../admin/auth/admin-user-view.type';
import { StoreAdminService } from './store-admin.service';
import { StoreCatalogService } from './store-catalog.service';
import {
  AdminStorePurchaseQueryDto,
  CreateStoreProductDto,
  UpdateStorePlatformDto,
  UpdateStoreProductDto,
} from './store.dto';
import type {
  AdminStorePlatformListView,
  AdminStorePlatformView,
  AdminStoreProductListView,
  AdminStoreProductView,
  AdminStorePurchasePageView,
} from './store-view.type';

/**
 * The dashboard's side of buying through the app stores (task IAP-01): the
 * product map, the per-store switch and cut, and the purchases and refunds.
 *
 * ROLE MATRIX (enforced per handler; superadmin is not implicit):
 *   reads (products, platforms, purchases, refunds)   superadmin, finance
 *   writes (products, platforms)                      superadmin, finance
 * Money lists carry person ids and amounts; reviewer and support are refused.
 */
@UseGuards(AdminAuthGuard, AdminRolesGuard)
@Controller('admin/store')
export class AdminStoreController {
  constructor(
    private readonly catalog: StoreCatalogService,
    private readonly admin: StoreAdminService,
  ) {}

  /** Every product in the map, both stores, with what each gives now. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('products')
  products(): Promise<AdminStoreProductListView> {
    return this.catalog.listProducts();
  }

  /** Adds a product to the map. The store product id and the kind cannot be changed afterwards. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  createProduct(
    @CurrentAdmin() admin: AdminUserView,
    @Body() dto: CreateStoreProductDto,
  ): Promise<AdminStoreProductView> {
    return this.catalog.createProduct(admin, dto);
  }

  /** Changes a product's title, grant, reference kobo, order or on/off. Only what is sent changes. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Patch('products/:id')
  @HttpCode(HttpStatus.OK)
  updateProduct(
    @CurrentAdmin() admin: AdminUserView,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateStoreProductDto,
  ): Promise<AdminStoreProductView> {
    return this.catalog.updateProduct(admin, id, dto);
  }

  /** Both stores: the switch, whether the Hub holds the store's credentials, and the cut a new purchase records. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('platforms')
  platforms(): Promise<AdminStorePlatformListView> {
    return this.catalog.listPlatforms();
  }

  /** Switches one store's purchases on or off, and sets its cut in basis points (`-1` goes back to the config's). */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Patch('platforms/:platform')
  @HttpCode(HttpStatus.OK)
  updatePlatform(
    @CurrentAdmin() admin: AdminUserView,
    @Param('platform', new ParseEnumPipe(StorePlatform))
    platform: StorePlatform,
    @Body() dto: UpdateStorePlatformDto,
  ): Promise<AdminStorePlatformView> {
    return this.catalog.updatePlatform(admin, platform, dto);
  }

  /** Every store purchase, newest first. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('purchases')
  purchases(
    @Query() q: AdminStorePurchaseQueryDto,
  ): Promise<AdminStorePurchasePageView> {
    return this.admin.purchases(q);
  }

  /** The purchases a store paid back or withdrew, newest first, with what was taken back. */
  @AdminRoles(AdminRole.superadmin, AdminRole.finance)
  @Get('refunds')
  refunds(
    @Query() q: AdminStorePurchaseQueryDto,
  ): Promise<AdminStorePurchasePageView> {
    return this.admin.refunds(q);
  }
}
