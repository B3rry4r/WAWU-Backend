import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { LedgerModule } from '../../money/ledger/ledger.module';
import { MoneyModule } from '../../money/money.module';
import { PlansModule } from '../../plans/plans.module';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { PointsModule } from '../points.module';
import { PointsCashOutService } from './points-cash-out.service';
import { ConvertPrecheckGuard } from './points-convert-precheck.guard';
import { PointsConvertController } from './points-convert.controller';
import { PointsConvertService } from './points-convert.service';

/**
 * Convert points to cash (task POINTS-04, R-43): `GET /points/convert/quote`,
 * `POST /points/convert` and `GET /points/convert/{id}`, and the sweep that
 * finishes a conversion whose request died or whose answer was lost. It sits
 * beside PointsModule and MoneyModule, not in either: points need no wallet
 * provider to boot (POINTS-01), and the wallet needs no plan.
 *
 * Mounting it in AppModule is SHARED-CHANGES POINTS-04 #1 (one import and one
 * entry, after PlansModule).
 */
@Module({
  imports: [
    WawuAuthModule,
    MoneyModule,
    LedgerModule,
    PlansModule,
    PointsModule,
    WalletProviderModule,
  ],
  controllers: [PointsConvertController],
  providers: [PointsCashOutService, PointsConvertService, ConvertPrecheckGuard],
})
export class PointsConvertModule {}
