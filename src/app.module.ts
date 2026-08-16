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
// SEAM: remaining Phase 5 resource modules (waves 1-3) register here,
// one import line each, per conventions.md § Naming & layout
// "Registration entry". Still missing from wave 0 (build failed on
// session limit with zero work committed, to be rebuilt): Purchase,
// Mentor, ServiceApplication, VerificationSubmission,
// FollowRelationship.

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
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
