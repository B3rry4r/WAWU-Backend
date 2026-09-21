import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { WalletModule } from '../../wallet/wallet.module';
import { AdminFinanceController } from './admin-finance.controller';
import { AdminFinanceService } from './admin-finance.service';
import { AdminFinanceWalletsService } from './admin-finance-wallets.service';

/**
 * The admin money surface: what the platform took, what WAWU kept, what
 * creators are owed, what has been paid out, and every transaction behind
 * those figures.
 *
 * Imports exactly two things:
 *  - AdminAuthModule, for the guards and nothing else. It already exports
 *    AdminAuthGuard and AdminRolesGuard precisely so resource modules built
 *    after it do not re-implement or hoist them.
 *  - WalletModule, for FLUTTERWAVE_WALLET_GATEWAY. The balance on this
 *    surface has to be Flutterwave's own, and this is the provider the
 *    creator-facing `GET /wallet` already reads it through, chosen the same
 *    way (`shouldUseMockFlutterwave()` throws rather than degrading in
 *    production). Reaching for the gateway through the module that owns it
 *    is what keeps one answer to "what is in this wallet" instead of two.
 *
 * WalletModule is registered near the top of app.module.ts already, and Nest
 * dedupes, so importing it here moves no controller in the registration order
 * that file's comments protect.
 *
 * PrismaService arrives from the global PrismaModule, same as every resource
 * module. Nothing in this module writes: every provider it declares exposes
 * reads only.
 */
@Module({
  imports: [AdminAuthModule, WalletModule],
  controllers: [AdminFinanceController],
  providers: [AdminFinanceService, AdminFinanceWalletsService],
})
export class AdminFinanceModule {}
