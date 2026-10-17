import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { MoneyModule } from '../../money/money.module';
import { PlansModule } from '../../plans/plans.module';
import { WalletProviderModule } from '../../wallet-provider/wallet-provider.module';
import { PointsModule } from '../points.module';
import { PointsHoldSweepService } from './points-hold-sweep.service';
import { PointsQuoteService } from './points-quote.service';
import { PointsShortfallService } from './points-shortfall.service';
import {
  PointsSettingsController,
  PointsSpendController,
} from './points-spend.controller';
import { PointsSpendService } from './points-spend.service';

/**
 * Spend points on AI tools (task POINTS-03, R-43): `POST /points/quote`,
 * `POST /points/shortfall`, `GET /points/shortfall/{id}`, `GET` and `PUT
 * /me/points/settings`, the internal `PointsSpendService` (`hold`, `commit`,
 * `release`) the AI tools' server code calls, and the sweep that gives back
 * AI holds a dead job left behind. It sits beside PointsModule, as the
 * convert module does: points need no wallet provider to boot (POINTS-01).
 * Exported for the tool tasks: `PointsSpendService`.
 *
 * Mounting it in AppModule is SHARED-CHANGES POINTS-03 #1 (one import and one
 * entry, after PointsConvertModule).
 */
@Module({
  imports: [
    WawuAuthModule,
    MoneyModule,
    PlansModule,
    PointsModule,
    WalletProviderModule,
  ],
  controllers: [PointsSpendController, PointsSettingsController],
  providers: [
    PointsSpendService,
    PointsQuoteService,
    PointsShortfallService,
    PointsHoldSweepService,
  ],
  exports: [PointsSpendService],
})
export class PointsSpendModule {}
