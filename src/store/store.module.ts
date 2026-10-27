import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { BlockedAccountModule } from '../blocked-account/blocked-account.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { PlansModule } from '../plans/plans.module';
import { PointsModule } from '../points/points.module';
import { PriceListModule } from '../price-list/price-list.module';
import { RealAppStoreClient } from './clients/app-store.client';
import { RealGooglePlayClient } from './clients/google-play.client';
import { APP_STORE_CLIENT, GOOGLE_PLAY_CLIENT } from './clients/store-clients';
import { AdminStoreController } from './admin-store.controller';
import {
  loadStoreConfig,
  STORE_CONFIG,
  type StoreConfig,
} from './store-config';
import { StoreAccountService } from './store-account.service';
import { StoreAdminService } from './store-admin.service';
import { StoreBuyTargetService } from './store-buy-target.service';
import { StoreCatalogService } from './store-catalog.service';
import { StoreCreditService } from './store-credit.service';
import { StoreEarningService } from './store-earning.service';
import { StoreIntentService } from './store-intent.service';
import { StoreIntentSweepService } from './store-intent-sweep.service';
import { StoreGrantService } from './store-grant.service';
import { StoreNotificationService } from './store-notification.service';
import { StorePurchaseService } from './store-purchase.service';
import { StoreController } from './store.controller';
import { StoreWebhookController } from './store-webhook.controller';

/**
 * Buying through Google Play and the App Store (task IAP-01, R-86). Mounted in
 * AppModule (SHARED-CHANGES IAP-01 #1: one import and one entry). The store
 * clients are real: with no credentials set they are `null` and every store
 * route answers `store_not_configured`; the tests provide stand-ins for both
 * stores under the same two tokens.
 */
@Module({
  imports: [
    WawuAuthModule,
    AdminAuthModule,
    PlansModule,
    PointsModule,
    BlockedAccountModule,
    PriceListModule,
  ],
  controllers: [StoreController, StoreWebhookController, AdminStoreController],
  providers: [
    { provide: STORE_CONFIG, useFactory: () => loadStoreConfig() },
    {
      provide: GOOGLE_PLAY_CLIENT,
      useFactory: (config: StoreConfig) =>
        config.google === null ? null : new RealGooglePlayClient(config.google),
      inject: [STORE_CONFIG],
    },
    {
      provide: APP_STORE_CLIENT,
      useFactory: (config: StoreConfig) =>
        config.apple === null ? null : new RealAppStoreClient(config.apple),
      inject: [STORE_CONFIG],
    },
    StoreAccountService,
    StoreBuyTargetService,
    StoreCatalogService,
    StoreCreditService,
    StoreEarningService,
    StoreGrantService,
    StoreIntentService,
    StoreIntentSweepService,
    StorePurchaseService,
    StoreNotificationService,
    StoreAdminService,
  ],
  exports: [StoreCatalogService, StorePurchaseService],
})
export class StoreModule {}
