import { Module } from '@nestjs/common';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { IdentityPauseService } from './identity-pause';

/**
 * `IdentityPauseService` for the publishing gate (S7 round 2, F3). A leaf on
 * purpose, like TierBadgeModule: it imports only the provider seam, so the
 * plans module can take it without importing MoneyModule (which would close a
 * cycle through the purchases).
 */
@Module({
  imports: [WalletProviderModule],
  providers: [IdentityPauseService],
  exports: [IdentityPauseService],
})
export class IdentityPauseModule {}
