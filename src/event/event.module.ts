import { Module } from '@nestjs/common';
import { EventController } from './event.controller';
import { EventService } from './event.service';

/**
 * Events, app-facing half. Reinstated 22 Aug 2026 by product-owner decision.
 *
 * Imports nothing: PrismaService arrives from the global PrismaModule and the
 * WAWU ID guard comes from WawuAuthModule, which AppModule already registers
 * once for the whole app — exactly as every other resource module here does.
 *
 * The admin half is a separate module (src/admin/events/) under the `admin/`
 * prefix, so the moderation surface and the surface it moderates never share a
 * controller, a guard, or a role assumption.
 */
@Module({
  controllers: [EventController],
  providers: [EventService],
  exports: [EventService],
})
export class EventModule {}
