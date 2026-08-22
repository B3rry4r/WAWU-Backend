import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin/auth/admin-auth.module';
import { LearnGuideController } from './learn-guide.controller';
import { LearnGuideService } from './learn-guide.service';

/**
 * PrismaModule is @Global() (conventions.md § ORM / database) so it is not
 * re-imported here; LearnGuideService injects PrismaService directly.
 *
 * AdminAuthModule IS imported, for its two exported GUARDS only — the two
 * write endpoints moved off AdminKeyGuard onto AdminAuthGuard +
 * AdminRolesGuard (superadmin). No AdminOpsAuditModule: LearnGuide already
 * carries an `updatedBy` column that has never had a writer, so attribution
 * needs no new table. Imported here rather than wired in app.module.ts so the
 * documented, load-bearing route-registration order in that file is
 * untouched.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [LearnGuideController],
  providers: [LearnGuideService],
})
export class LearnGuideModule {}
