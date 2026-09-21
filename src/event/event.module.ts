import { Module } from '@nestjs/common';
import { VerificationStateModule } from '../common/verification/verification-state.module';
import { EventController } from './event.controller';
import { EventService } from './event.service';

/**
 * Events, app-facing half. Reinstated 22 Aug 2026 by product-owner decision.
 *
 * PrismaService arrives from the global PrismaModule and the WAWU ID guard
 * comes from WawuAuthModule, which AppModule already registers once for the
 * whole app — exactly as every other resource module here does.
 *
 * VerificationStateModule IS imported, explicitly, although it is @Global().
 * @Global() only makes a provider visible once its module is somewhere in the
 * graph, and this module's contract spec boots it alone. Hosting is
 * verified-only, so a boot without the tick reader is a boot where the gate
 * cannot be enforced; naming the dependency means that fails at compile time
 * rather than at the first submission. It declares no controller, so this
 * costs no route order.
 *
 * The admin half is a separate module (src/admin/events/) under the `admin/`
 * prefix, so the moderation surface and the surface it moderates never share a
 * controller, a guard, or a role assumption.
 */
@Module({
  imports: [VerificationStateModule],
  controllers: [EventController],
  providers: [EventService],
  exports: [EventService],
})
export class EventModule {}
