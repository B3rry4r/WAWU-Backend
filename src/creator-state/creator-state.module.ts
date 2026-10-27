import { Module } from '@nestjs/common';
import { PriceListModule } from '../price-list/price-list.module';
import { PlansModule } from '../plans/plans.module';
import { CreatorStateController } from './creator-state.controller';
import { CreatorStateService } from './creator-state.service';

/**
 * Registration line for src/app.module.ts (applied centrally by the
 * dispatcher, see this agent's report):
 *   import { CreatorStateModule } from './creator-state/creator-state.module';
 *   // add CreatorStateModule to the `imports` array
 *
 * PlansModule gives `slotsTotal` the same figure the publishing gate checks
 * (TIER-02).
 */
@Module({
  imports: [
    PlansModule,
    // The paid question price is on the price list for the app's requests (PRICE-LIST round 3).
    PriceListModule,
  ],
  controllers: [CreatorStateController],
  providers: [CreatorStateService],
})
export class CreatorStateModule {}
