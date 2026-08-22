import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../auth/admin-auth.module';
import { StorageModule } from '../../storage/storage.module';
import { KycSubmissionService } from '../../kyc-submission/kyc-submission.service';
import { AdminKycReviewController } from './admin-kyc-review.controller';
import { AdminKycReviewService } from './admin-kyc-review.service';

/**
 * Admin KYC review — the queue that makes the existing, unreachable
 * `POST /kyc/:id/review` reachable, and with it the earning gate.
 *
 * Imports:
 *  - AdminAuthModule, for the guards and nothing else. It already exports
 *    AdminAuthGuard and AdminRolesGuard precisely so resource modules built
 *    after it do not re-implement or hoist them.
 *  - StorageModule, for StorageService.signedReadUrl. Its own controller is
 *    registered by app.module.ts, not by this import — Nest registers a
 *    controller once per module and StorageModule is already in the graph.
 *
 * Providers include the app's own `KycSubmissionService`, listed here rather
 * than imported through KycSubmissionModule, which exports nothing. That is a
 * deliberate reuse, not a copy: the approve/reject endpoints delegate to its
 * unmodified `review()`, so the admin route runs the same transition, the same
 * validation and the same CreatorState.kycStatus write as the shipped route.
 * Listing the class instantiates a second instance of a stateless service
 * (PrismaService from the global PrismaModule, StorageService from
 * StorageModule) and changes nothing about the first — no existing module,
 * service, DTO or route is edited to make it reachable.
 *
 * KycSubmissionController is NOT registered here. A controller belongs to the
 * module that declares it; providing the service alone brings no route with
 * it.
 */
@Module({
  imports: [AdminAuthModule, StorageModule],
  controllers: [AdminKycReviewController],
  providers: [AdminKycReviewService, KycSubmissionService],
})
export class AdminKycReviewModule {}
