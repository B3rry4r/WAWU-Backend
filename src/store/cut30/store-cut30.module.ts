import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { PlanSettingsModule } from '../../plan-settings/plan-settings.module';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { StorePayoutModule } from '../payout/store-payout.module';
import { AdminStoreCut30Controller } from './admin-store-cut30.controller';
import { StoreCut30Service } from './store-cut30.service';
import {
  loadStorePriceConfig,
  STORE_PRICE_CONFIG,
  StorePriceSync,
} from './store-price-sync';
import { StoreUsdRateService } from './store-usd-rate.service';

/**
 * The stores' cut from 15% to 30% (task STORE-CUT30, R-101 point 9). Beside
 * StoreModule, like StorePayoutModule, whose owner notices it uses. Mounting it
 * in AppModule is SHARED-CHANGES STORE-PAYOUT #1.
 */
@Module({
  imports: [
    AdminAuthModule,
    PlanSettingsModule,
    WalletProviderModule,
    StorePayoutModule,
  ],
  controllers: [AdminStoreCut30Controller],
  providers: [
    { provide: STORE_PRICE_CONFIG, useFactory: () => loadStorePriceConfig() },
    StorePriceSync,
    StoreUsdRateService,
    StoreCut30Service,
  ],
  exports: [StoreCut30Service],
})
export class StoreCut30Module {}
