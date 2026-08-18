import { Module } from '@nestjs/common';
import { KycSubmissionController } from './kyc-submission.controller';
import { KycSubmissionService } from './kyc-submission.service';
import { KycAdminGuard } from './guards/admin.guard';
import { StorageModule } from '../storage/storage.module';

/**
 * registry.json "KycSubmission" resource module. PrismaService comes from
 * the globally-registered PrismaModule (conventions.md § ORM / database) —
 * not re-imported here. No WawuAuthModule import needed: unlike
 * VerificationSubmission, this resource never calls WawuIdClient (KYC is
 * fully owned by this backend, conventions.md § Auth model) — the
 * WawuAuthGuard's 'wawu-jwt' passport strategy is registered once by
 * WawuAuthModule at the AppModule level; isolated test modules for this
 * resource import WawuAuthModule directly alongside this module (see
 * tests/kyc-submission.contract.spec.ts), matching comment.module.ts's
 * precedent for a resource with no WawuIdClient dependency of its own.
 */
@Module({
  imports: [StorageModule],
  controllers: [KycSubmissionController],
  providers: [KycSubmissionService, KycAdminGuard],
})
export class KycSubmissionModule {}
