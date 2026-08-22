import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { StorageModule } from '../../storage/storage.module';
import { WawuAuthModule } from '../../common/auth/wawu-auth.module';
import { VerificationSubmissionService } from '../../verification-submission/verification-submission.service';
import { AdminVerificationReviewController } from './admin-verification-review.controller';
import { AdminVerificationReviewService } from './admin-verification-review.service';

/**
 * Admin verification-tier review — the queue that makes the existing,
 * unreachable `POST /verification/submissions/:id/review` reachable.
 *
 * Imports:
 *  - AdminAuthModule, for the guards it already exports.
 *  - StorageModule, for StorageService.signedReadUrl.
 *  - WawuAuthModule, for WawuIdClient, which the reused
 *    VerificationSubmissionService needs to elevate a tier. This is the same
 *    import VerificationSubmissionModule makes and for the same reason; it is
 *    a READ of the SSO integration's client, not a change to it. Nothing here
 *    touches the wawu-jwt strategy, the user guard, or how a user token is
 *    validated — an admin never becomes a passport principal, and this
 *    module's own routes are gated by AdminAuthGuard alone.
 *
 * Providers include the app's own `VerificationSubmissionService`, listed here
 * rather than imported through VerificationSubmissionModule, which exports
 * nothing. The approve/reject endpoints delegate to its unmodified `review()`,
 * so the admin route preserves the elevate-at-WAWU-ID-BEFORE-local-write
 * ordering exactly — an ordering that service's own comment describes as
 * unrecoverable if reversed. Listing the class instantiates a second instance
 * of a stateless service and changes nothing about the first; no existing
 * module, service, DTO or route is edited.
 *
 * VerificationSubmissionController is NOT registered here. A controller
 * belongs to the module that declares it; providing the service alone brings
 * no route with it.
 */
@Module({
  imports: [AdminAuthModule, StorageModule, WawuAuthModule],
  controllers: [AdminVerificationReviewController],
  providers: [AdminVerificationReviewService, VerificationSubmissionService],
})
export class AdminVerificationReviewModule {}
