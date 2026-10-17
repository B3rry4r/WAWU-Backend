import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../../admin/auth/admin-auth.module';
import { LedgerModule } from '../../money/ledger/ledger.module';
import { MoneyModule } from '../../money/money.module';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { SchoolPayeeService } from './school-payee.service';
import { SchoolSettlementAdminController } from './school-settlement-admin.controller';
import { SchoolSettlementService } from './school-settlement.service';

/**
 * Paying schools their share of course fees (task SCHOOLS-11): the sweep that
 * pays a school at its class's start and sends a cancelled class's fees back,
 * the school's bank account (payee) and the dashboard's money routes. Mounted
 * by AdminSchoolsModule (which AppModule already reaches), so
 * `src/app.module.ts` is untouched. It reaches the wallet provider only
 * through the seam (`WALLET_PROVIDER`) and the holds through `MoneyModule`.
 */
@Module({
  imports: [AdminAuthModule, MoneyModule, LedgerModule, WalletProviderModule],
  controllers: [SchoolSettlementAdminController],
  providers: [SchoolPayeeService, SchoolSettlementService],
  exports: [SchoolSettlementService, SchoolPayeeService],
})
export class SchoolSettlementModule {}
