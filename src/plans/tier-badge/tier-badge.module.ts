import { Module } from '@nestjs/common';
import { loadPlansConfig, PLANS_CONFIG } from '../plans-config';
import { TierBadgeService } from './tier-badge.service';

/**
 * The tier badge reader, with no routes (TIER-07).
 *
 * Profile and card modules import this to put `badge` on their views. It is
 * a leaf on purpose, like WaitlistCoreModule: importing PlansModule from a
 * feature module would register `GET /plans` and `GET /me/tier` at that
 * module's place in the route order instead of where AppModule lists them.
 * The plan is read here again from the same file under the same token
 * (`PLANS_CONFIG`), so a spec that overrides the token overrides this too.
 * A badge's name and kind are not admin settings (TIER-06 lists none), so the
 * file is their source.
 */
@Module({
  providers: [
    { provide: PLANS_CONFIG, useFactory: () => loadPlansConfig() },
    TierBadgeService,
  ],
  exports: [TierBadgeService],
})
export class TierBadgeModule {}
