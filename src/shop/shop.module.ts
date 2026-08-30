import { Module } from '@nestjs/common';
import { PrismaModule } from '../common/prisma/prisma.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { DirectMessageModule } from '../direct-message/direct-message.module';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { ShopController } from './shop.controller';
import { AdminShopController } from '../admin/shop/admin-shop.controller';
import { ShopService } from './shop.service';
import { ShopAdminService } from './shop-admin.service';

/**
 * WAWU Commerce.
 *
 * DirectMessageModule is imported for its FLUTTERWAVE_CLIENT, exactly as event
 * ticketing does — one payment adapter across the platform, so its retry
 * semantics and its "accepted is not settled" distinction are the same
 * everywhere money moves. A second Flutterwave client would be a second set of
 * edge cases to get right.
 */
@Module({
  imports: [PrismaModule, WawuAuthModule, DirectMessageModule, AdminAuthModule],
  controllers: [ShopController, AdminShopController],
  providers: [ShopService, ShopAdminService],
  exports: [ShopService],
})
export class ShopModule {}
