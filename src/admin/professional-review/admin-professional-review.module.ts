import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { StorageModule } from '../../storage/storage.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { AdminProfessionalReviewController } from './admin-professional-review.controller';
import { AdminProfessionalReviewService } from './admin-professional-review.service';

/**
 * Admin review for professional applications. Same three imports, and the
 * same reasons, as AdminVerificationReviewModule: AdminAuthModule for the
 * guards it exports, StorageModule for signed document reads, WawuAuthModule
 * for WawuIdClient — which this needs both to resolve applicant names and to
 * elevate the badge on approval.
 */
@Module({
  imports: [AdminAuthModule, StorageModule, WawuAuthModule],
  controllers: [AdminProfessionalReviewController],
  providers: [AdminProfessionalReviewService],
})
export class AdminProfessionalReviewModule {}
