import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { CreatorEarningsModule } from '../../creator-earnings/creator-earnings.module';
import { AdminCreatorsController } from './admin-creators.controller';
import { AdminCreatorsService } from './admin-creators.service';

/**
 * Admin creator lookup — the support screen for "I paid and I cannot upload".
 *
 * Imports exactly two things:
 *  - AdminAuthModule, for the guards and nothing else. It already exports
 *    AdminAuthGuard and AdminRolesGuard precisely so resource modules built
 *    after it do not re-implement or hoist them.
 *  - CreatorEarningsModule, for `CreatorEarningsService`. Adding `exports` to
 *    that module was the only change made to it — no route, response shape,
 *    guard or line of its service moved — and it is what makes this screen's
 *    earnings figure the SAME number the creator sees on their own screen
 *    rather than a second calculation that drifts. Its own controller
 *    (`GET /content/mine/earnings`, behind CreatorAccountGuard) is registered by
 *    app.module.ts, not by this import: Nest registers a controller once per
 *    module and CreatorEarningsModule is already in the graph.
 *
 * PrismaService arrives from the global PrismaModule, same as every resource
 * module. Nothing belonging to the app is imported for WRITING, and this whole
 * surface is read-only — there is no write endpoint on it.
 */
@Module({
  imports: [AdminAuthModule, CreatorEarningsModule],
  controllers: [AdminCreatorsController],
  providers: [AdminCreatorsService],
})
export class AdminCreatorsModule {}
