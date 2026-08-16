import { Module } from '@nestjs/common';
import { WawuAuthModule } from '../common/auth/wawu-auth.module';
import { VerificationSubmissionController } from './verification-submission.controller';
import { VerificationSubmissionService } from './verification-submission.service';
import { VerificationAdminGuard } from './guards/admin.guard';

/**
 * registry.json "VerificationSubmission" resource module. Imports
 * WawuAuthModule for WawuIdClient (elevateVerificationTier on approval) —
 * WawuAuthModule's own doc comment names this resource as its intended
 * consumer. PrismaService comes from the globally-registered PrismaModule.
 */
@Module({
  imports: [WawuAuthModule],
  controllers: [VerificationSubmissionController],
  providers: [VerificationSubmissionService, VerificationAdminGuard],
})
export class VerificationSubmissionModule {}
