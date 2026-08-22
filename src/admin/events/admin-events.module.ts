import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { AdminEventsController } from './admin-events.controller';
import { AdminEventsService } from './admin-events.service';

/**
 * Admin event moderation — the queue that turns a user's submission into
 * something anyone else can see.
 *
 * Imports exactly one thing: AdminAuthModule, for the guards and nothing else.
 * It already exports AdminAuthGuard and AdminRolesGuard precisely so resource
 * modules built after it do not re-implement or hoist them. PrismaService
 * arrives from the global PrismaModule, same as every other module here.
 *
 * Deliberately does NOT import EventModule. Nest registers a controller once
 * per module, so importing it would be a second registration of
 * EventController; and this service has no business calling the app-facing
 * service anyway — the two halves share the tables and one pure helper
 * (`initialsFor`), not a code path.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [AdminEventsController],
  providers: [AdminEventsService],
})
export class AdminEventsModule {}
