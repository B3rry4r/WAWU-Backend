import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { NotificationModule } from '../notification/notification.module';
import { AppClientMiddleware } from './app-client';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { PriceListController } from './price-list.controller';
import { PriceListService } from './price-list.service';
import { PriceMoveNoticeService } from './price-move-notice.service';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';

/**
 * PRICE-LIST (R-101): the price list and the tip list, the rule that a price
 * a person sets is on the list, `GET /prices`, and the one-time notices for
 * prices the migration moved. Imported by the modules whose routes set a
 * price; the route registers through them, so AppModule is unchanged.
 */
@Module({
  imports: [
    PlanSettingsModule,
    WawuAuthModule,
    // PriceMoveNoticeService writes the notices; a testing module built from a resource's own module has no global one.
    NotificationModule,
  ],
  controllers: [PriceListController],
  providers: [PriceListService, PriceMoveNoticeService],
  exports: [PriceListService],
})
export class PriceListModule implements NestModule {
  /** Every route learns whether the request is the app's (`X-Wawu-Client: app`), the way X-Pay-Source-Currency is read. */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AppClientMiddleware).forRoutes('*');
  }
}
