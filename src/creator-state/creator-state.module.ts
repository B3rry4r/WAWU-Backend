import { Module } from '@nestjs/common';
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
  imports: [PlansModule],
  controllers: [CreatorStateController],
  providers: [CreatorStateService],
})
export class CreatorStateModule {}
