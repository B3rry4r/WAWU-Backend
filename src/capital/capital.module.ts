import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { LedgerModule } from '../money/ledger/ledger.module';
import { MoneyModule } from '../money/money.module';
import { PlanSettingsModule } from '../plan-settings/plan-settings.module';
import { WalletProviderModule } from '../wallet-provider/wallet-provider.module';
import { AdminCapitalController } from './admin-capital.controller';
import { AdminCapitalService } from './admin-capital.service';
import { CapitalSettings } from './capital-config';
import { CapitalConfirmGuard, CapitalWithdrawGuard } from './capital-guards';
import { CapitalLedger } from './capital-ledger';
import { CapitalSweepService } from './capital-sweep.service';
import { CapitalController } from './capital.controller';
import { CapitalService } from './capital.service';

/**
 * Capital (task NUV-12, R-84): `/capital/*` for the app and
 * `/admin/capital/orders/*` for the dashboard. It sits beside MoneyModule,
 * not in it: it needs the wallet, the PIN and the ledger, and nothing in the
 * wallet needs Capital. The provider is reached only through
 * `WALLET_PROVIDER` (a provider with no `capital` leaves the routes
 * answering `409 capital_unavailable`). Mounting it in AppModule is
 * SHARED-CHANGES NUV-12 #1.
 */
@Module({
  imports: [
    ConfigModule,
    WawuAuthModule,
    AdminAuthModule,
    MoneyModule,
    LedgerModule,
    PlanSettingsModule,
    WalletProviderModule,
  ],
  controllers: [CapitalController, AdminCapitalController],
  providers: [
    CapitalSettings,
    CapitalLedger,
    CapitalService,
    CapitalSweepService,
    CapitalConfirmGuard,
    CapitalWithdrawGuard,
    AdminCapitalService,
  ],
  exports: [CapitalService, CapitalLedger],
})
export class CapitalModule {}
