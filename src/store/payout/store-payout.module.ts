import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { LedgerModule } from '../../money/ledger/ledger.module';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { AdminStoreNoticesController } from './admin-store-notices.controller';
import { StoreAdminNoticeService } from './store-admin-notice.service';
import { StorePayoutService } from './store-payout.service';

/**
 * Paying creators for store sales (task STORE-PAYOUT, R-101 point 4), and the
 * owner's notices about the store money. It sits beside StoreModule, not in it,
 * so the store specs and the modules that import StoreModule do not need the
 * wallet provider's settings to boot, the way CommunityPassModule sits beside
 * CommunityModule. Mounting it in AppModule is SHARED-CHANGES STORE-PAYOUT #1.
 */
@Module({
  imports: [AdminAuthModule, WalletProviderModule, LedgerModule],
  controllers: [AdminStoreNoticesController],
  providers: [StorePayoutService, StoreAdminNoticeService],
  exports: [StorePayoutService, StoreAdminNoticeService],
})
export class StorePayoutModule {}
