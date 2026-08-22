import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { WawuAuthModule } from './common/auth/wawu-auth.module';
import { AdminAuthModule } from './admin/auth/admin-auth.module';
import { AdminContentReviewModule } from './admin/content-review/admin-content-review.module';
import { AdminKycReviewModule } from './admin/kyc-review/admin-kyc-review.module';
import { AdminVerificationReviewModule } from './admin/verification-review/admin-verification-review.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { AccountModule } from './account/account.module';
import { CommentModule } from './comment/comment.module';
import { CourseLessonModule } from './course-lesson/course-lesson.module';
import { CreatorNoResponseTrackerModule } from './creator-no-response-tracker/creator-no-response-tracker.module';
import { CreatorStateModule } from './creator-state/creator-state.module';
import { CreditSpendModule } from './credit-spend/credit-spend.module';
import { CreditsStateModule } from './credits-state/credits-state.module';
import { DataExportRequestModule } from './data-export-request/data-export-request.module';
import { DmReportModule } from './dm-report/dm-report.module';
import { EvgScoreModule } from './evg-score/evg-score.module';
import { LearnCourseModule } from './learn-course/learn-course.module';
import { LearnGuideModule } from './learn-guide/learn-guide.module';
import { MarketplaceSaveModule } from './marketplace-save/marketplace-save.module';
import { NotificationModule } from './notification/notification.module';
import { PartnerServiceModule } from './partner-service/partner-service.module';
import { PlaybookModule } from './playbook/playbook.module';
import { SavedItemModule } from './saved-item/saved-item.module';
import { PurchaseModule } from './purchase/purchase.module';
import { MentorModule } from './mentor/mentor.module';
import { ServiceApplicationModule } from './service-application/service-application.module';
import { VerificationSubmissionModule } from './verification-submission/verification-submission.module';
import { FollowRelationshipModule } from './follow-relationship/follow-relationship.module';
import { BlockedAccountModule } from './blocked-account/blocked-account.module';
import { ContentPieceModule } from './content-piece/content-piece.module';
import { CreditPurchaseModule } from './credit-purchase/credit-purchase.module';
import { KycSubmissionModule } from './kyc-submission/kyc-submission.module';
import { LearnEntitlementModule } from './learn-entitlement/learn-entitlement.module';
import { MentorRequestModule } from './mentor-request/mentor-request.module';
import { NotificationSettingsModule } from './notification-settings/notification-settings.module';
import { PrivacySettingsModule } from './privacy-settings/privacy-settings.module';
import { UserProfileModule } from './user-profile/user-profile.module';
import { CourseEnrollmentModule } from './course-enrollment/course-enrollment.module';
import { CreatorSubscriptionModule } from './creator-subscription/creator-subscription.module';
import { SearchResponseModule } from './search-response/search-response.module';
import { CommunityModule } from './community/community.module';
import { CommunityMessageModule } from './community-message/community-message.module';
import { CreatorEarningsModule } from './creator-earnings/creator-earnings.module';
import { DirectMessageModule } from './direct-message/direct-message.module';
import { StorageModule } from './storage/storage.module';
import { BillPaymentModule } from './bill-payment/bill-payment.module';
import { HealthPlanModule } from './health-plan/health-plan.module';
import { LegalModule } from './legal/legal.module';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerModule } from './scheduler/scheduler.module';
import { PaymentWebhookModule } from './payment-webhook/payment-webhook.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
// Phase 5 build (waves 0-3, all 39 registry resources) is now complete.
// The deferred Flutterwave webhook has now shipped as PaymentWebhookModule
// (POST /api/hub/webhooks/flutterwave) alongside the scheduled-job cron pass,
// so payment confirmation no longer depends on the customer's browser.

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Rate limiting: @nestjs/throttler was a dependency but was never
    // registered, leaving presign, search and every payment-verify endpoint
    // unlimited — a storage-cost and scan-cost DoS from a single account.
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 20 },
      { name: 'medium', ttl: 60_000, limit: 200 },
    ]),
    ScheduleModule.forRoot(),
    SchedulerModule,
    PrismaModule,
    StorageModule,
    // Lifestyle Services: WAWUPay, WAWUCare, WAWU Legal.
    BillPaymentModule,
    HealthPlanModule,
    LegalModule,
    WawuAuthModule,
    // Admin surface. Position is deliberate: immediately after the auth
    // infrastructure and ahead of every module that owns a parameterised
    // route. Express matches in registration order, and the one
    // shadowing hazard in this file is PartnerServiceController --
    // `@Controller('services')` with a `@Get(':id')` catch-all that already
    // swallowed `/services/mentors` and `/services/applications` once (see the
    // comment further down). Registering ahead of every resource module means
    // no present or future catch-all can reach `/admin/*` either. The reverse
    // direction cannot bite: every admin route is `admin/auth/...`, no other
    // controller declares an `admin` prefix, and the only root-level
    // controller (AppController) declares a single literal path (`health`)
    // with no parameter segment -- so nothing registered here can shadow an
    // existing route. The MentorModule <- ServiceApplicationModule <-
    // PartnerServiceModule ordering below is untouched: what matters there is
    // their order relative to each other, not their absolute position.
    AdminAuthModule,
    // Admin content review. Registered immediately after AdminAuthModule for
    // the same reason AdminAuthModule sits where it does: `/admin/*` is
    // matched before any module that owns a parameterised route, so no
    // present or future catch-all can swallow it. Shadow-safe in the other
    // direction too -- every route it declares is `admin/content/...`, no
    // other controller in this file declares an `admin` prefix, and the app's
    // own content routes are `@Controller('content')`, a different first
    // segment. The MentorModule <- ServiceApplicationModule <-
    // PartnerServiceModule ordering below is untouched.
    AdminContentReviewModule,
    // Admin KYC review (the EARNING gate) and admin verification-tier review
    // (the public trust badge). Registered here for the same reason
    // AdminAuthModule and AdminContentReviewModule sit where they do: every
    // `/admin/*` route is matched before any module that owns a parameterised
    // route, so no present or future catch-all -- PartnerServiceController's
    // `@Get(':id')` being the one that has already bitten (see the comment
    // further down) -- can swallow them.
    //
    // Shadow-safe in the other direction too. AdminKycReviewController is
    // `@Controller('admin/kyc')` and AdminVerificationReviewController is
    // `@Controller('admin/verification')`; the app's own routes for the same
    // two resources are `@Controller('kyc')` and `@Controller('verification')`,
    // a different FIRST segment, so registering ahead of KycSubmissionModule
    // and VerificationSubmissionModule cannot shadow either of them. Nothing
    // else in this file declares an `admin` prefix, and the only root-level
    // controller (AppController) declares one literal path (`health`) with no
    // parameter segment.
    //
    // Two separate modules, not one: KYC and the verification tier are
    // independent systems by product rule, and a shared module is the first
    // step towards a shared screen. The MentorModule <- ServiceApplicationModule
    // <- PartnerServiceModule ordering below is untouched.
    AdminKycReviewModule,
    AdminVerificationReviewModule,
    AccountModule,
    CommentModule,
    CourseLessonModule,
    CreatorNoResponseTrackerModule,
    CreatorStateModule,
    CreditSpendModule,
    CreditsStateModule,
    DataExportRequestModule,
    DmReportModule,
    EvgScoreModule,
    LearnCourseModule,
    LearnGuideModule,
    MarketplaceSaveModule,
    NotificationModule,
    // MentorModule/ServiceApplicationModule MUST register before
    // PartnerServiceModule: PartnerServiceController is `@Controller('services')`
    // with `@Get(':id')`, a catch-all that Express matches by registration
    // order — with PartnerServiceModule first, GET /services/mentors and
    // GET /services/applications were being swallowed as `:id === "mentors"`
    // / `:id === "applications"` before MentorController's own
    // `@Controller('services/mentors')` or ServiceApplicationController's
    // `@Get('applications')` were ever reached (confirmed live during Phase
    // 6 frontend wiring — both routes 400'd with "uuid v4 is expected").
    MentorModule,
    ServiceApplicationModule,
    PartnerServiceModule,
    PlaybookModule,
    SavedItemModule,
    PurchaseModule,
    VerificationSubmissionModule,
    FollowRelationshipModule,
    BlockedAccountModule,
    ContentPieceModule,
    CreditPurchaseModule,
    KycSubmissionModule,
    LearnEntitlementModule,
    MentorRequestModule,
    NotificationSettingsModule,
    PrivacySettingsModule,
    UserProfileModule,
    CourseEnrollmentModule,
    CreatorSubscriptionModule,
    SearchResponseModule,
    CommunityModule,
    CommunityMessageModule,
    CreatorEarningsModule,
    DirectMessageModule,
    // LAST on purpose. PaymentWebhookModule imports every money module so it
    // can reuse their /verify settlement, and every one of them is already
    // registered above — Nest dedupes, so the load-bearing controller order
    // (MentorModule / ServiceApplicationModule before PartnerServiceModule's
    // `@Get(':id')` catch-all) is unaffected.
    PaymentWebhookModule,
  ],
  controllers: [AppController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
