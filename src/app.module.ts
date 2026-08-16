import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { WawuAuthModule } from './common/auth/wawu-auth.module';
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
// SEAM: remaining Phase 5 resource modules (waves 2-3) register here,
// one import line each, per conventions.md § Naming & layout
// "Registration entry". Waves 0-1 (31 resources) are now complete.

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    WawuAuthModule,
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
    PartnerServiceModule,
    PlaybookModule,
    SavedItemModule,
    PurchaseModule,
    MentorModule,
    ServiceApplicationModule,
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
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
