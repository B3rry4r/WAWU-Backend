import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { WawuAuthModule } from './common/auth/wawu-auth.module';
import { AdminAuthModule } from './admin/auth/admin-auth.module';
import { AdminContentReviewModule } from './admin/content-review/admin-content-review.module';
import { AdminKycReviewModule } from './admin/kyc-review/admin-kyc-review.module';
import { AdminVerificationReviewModule } from './admin/verification-review/admin-verification-review.module';
import { AdminProfessionalReviewModule } from './admin/professional-review/admin-professional-review.module';
import { AdminPaymentsModule } from './admin/payments/admin-payments.module';
import { AdminCreatorsModule } from './admin/creators/admin-creators.module';
import { AdminFinanceModule } from './admin/finance/admin-finance.module';
import { AdminEventsModule } from './admin/events/admin-events.module';
import { AdminNotificationsModule } from './admin/notifications/admin-notifications.module';
import { AdminLegalDocumentsModule } from './admin/legal-documents/admin-legal-documents.module';
import { AboutModule } from './about/about.module';
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
import { VerificationStateModule } from './common/verification/verification-state.module';
import { VerificationModule } from './verification/verification.module';
import { VerificationSubmissionModule } from './verification-submission/verification-submission.module';
import { FollowRelationshipModule } from './follow-relationship/follow-relationship.module';
import { CreatorDiscoveryModule } from './creator-discovery/creator-discovery.module';
import { ProfessionalModule } from './professional/professional.module';
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
import { SearchResponseModule } from './search-response/search-response.module';
import { CommunityModule } from './community/community.module';
import { CommunityMessageModule } from './community-message/community-message.module';
import { CreatorEarningsModule } from './creator-earnings/creator-earnings.module';
import { DirectMessageModule } from './direct-message/direct-message.module';
import { PaymentLinkModule } from './payment-link/payment-link.module';
import { EventModule } from './event/event.module';
import { EventTicketingModule } from './event-ticketing/event-ticketing.module';
import { ShopModule } from './shop/shop.module';
import { StorageModule } from './storage/storage.module';
import { BillPaymentModule } from './bill-payment/bill-payment.module';
import { HealthPlanModule } from './health-plan/health-plan.module';
import { LegalModule } from './legal/legal.module';
import { LegalIntakeModule } from './legal-intake/legal-intake.module';
import { ScheduleModule } from '@nestjs/schedule';
import { SchedulerModule } from './scheduler/scheduler.module';
import { AccountPurgeModule } from './account-purge/account-purge.module';
import { WalletModule } from './wallet/wallet.module';
import { MoneyModule } from './money/money.module';
import { ChatModule } from './chat/chat.module';
import { FintavaWebhookModule } from './fintava/webhook/fintava-webhook.module';
import { PaymentWebhookModule } from './payment-webhook/payment-webhook.module';
import { AdminAdsModule } from './admin/ads/admin-ads.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { HUB_THROTTLERS } from './hub-throttlers';
import { HUB_THROTTLER_STORAGE } from './hub-throttler-storage';
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
    // The limits themselves (short 20/s, medium 200/min) live in
    // src/hub-throttlers.ts, so a webhook can skip every one by name.
    ThrottlerModule.forRoot([...HUB_THROTTLERS]),
    ScheduleModule.forRoot(),
    // MUST stay ahead of SchedulerModule, and of everything else that pulls in
    // DirectMessageModule (SchedulerModule, PaymentWebhookModule, ShopModule,
    // EventTicketingModule, AdminPaymentsModule).
    //
    // Both this and DirectMessageController are `@Controller('dm')`, and
    // DirectMessage owns `@Get(':messageId')` behind a ParseUUIDPipe — a
    // parameter route swallows every literal sibling registered after it. So
    // GET /dm/response-stats answered 400 "Validation failed (uuid is
    // expected)" in production, while its own contract test stayed green:
    // that test boots this module alone, where there is nothing to shadow it.
    //
    // Controller order is decided by FIRST ENCOUNTER during the walk of this
    // array, not by where a module is listed — SchedulerModule imports
    // DirectMessageModule, so DirectMessage's controller was mounting at
    // position 11. route-shadowing.regression.spec.ts boots the whole
    // AppModule and fails if this moves back down.
    CreatorNoResponseTrackerModule,
    SchedulerModule,
    AccountPurgeModule,
    WalletModule,
    PrismaModule,
    StorageModule,
    // Lifestyle Services: WAWUPay, WAWUCare, WAWU Legal.
    BillPaymentModule,
    HealthPlanModule,
    LegalIntakeModule,
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
    AdminProfessionalReviewModule,
    // Admin payment reconciliation (the read side of PaymentWebhookReceipt,
    // which shipped with a writer and no reader) and admin creator lookup (the
    // support screen for "I paid and I cannot upload", which had no endpoint at
    // all). Registered adjacent to the other admin modules, and for the same
    // reason they sit here: Express matches in registration order, so putting
    // every `/admin/*` route ahead of every module that owns a parameterised
    // route means no present or future catch-all can swallow one --
    // PartnerServiceController's `@Controller('services')` + `@Get(':id')`
    // being the catch-all that has already bitten twice (see the comment
    // further down).
    //
    // Shadow-safe in the other direction too, which is the direction that
    // matters when registering EARLY. AdminPaymentsController is
    // `@Controller('admin/payments')` and AdminCreatorsController is
    // `@Controller('admin/creators')`. Nothing outside src/admin/ declares an
    // `admin` prefix; the app's own payment surface is
    // `@Controller('webhooks/flutterwave')` and its creator surfaces are
    // `@Controller('creator')` and `@Controller('content/mine/earnings')`
    // -- each a different FIRST segment,
    // so neither of these can shadow an existing route no matter how early it
    // registers. The only root-level controller (AppController) declares one
    // literal path (`health`) with no parameter segment.
    //
    // AdminPaymentsModule imports PaymentWebhookModule, which transitively
    // imports every money module. All of them are already registered below and
    // Nest dedupes, so the load-bearing MentorModule <- ServiceApplicationModule
    // <- PartnerServiceModule ordering is unaffected -- exactly as it already is
    // for PaymentWebhookModule's own registration at the end of this list.
    // Likewise AdminCreatorsModule imports CreatorEarningsModule, which is
    // registered below and deduped.
    AdminPaymentsModule,
    AdminCreatorsModule,
    // The admin MONEY surface, read-only. `/admin/payments` answered only
    // "did this webhook land" and "did this DM refund fail"; nothing anywhere
    // answered what the platform has taken, what WAWU's share of it is, what
    // creators are owed, or what transactions have passed through. `/wallet`
    // and `/content/mine/earnings` answer those for the CALLER's own account,
    // which is no use to an operator holding the whole platform's books.
    //
    // Registered with the other admin modules, and for the same reason they
    // all sit here: Express matches in registration order, so every `/admin/*`
    // route is matched ahead of any module owning a parameterised route --
    // PartnerServiceController's `@Controller('services')` + `@Get(':id')`
    // being the catch-all that has already bitten twice (see the comment
    // further down).
    //
    // Shadow-safe in the other direction too, which is the direction that
    // matters when registering EARLY. AdminFinanceController is
    // `@Controller('admin/finance')`: a SECOND segment no other admin
    // controller declares, and `admin` is a first segment nothing outside
    // src/admin/ declares at all. The app's own money surfaces are
    // `@Controller('wallet')`, `@Controller('content/mine/earnings')` and
    // `@Controller('webhooks/flutterwave')` -- each a different FIRST
    // segment, so this can neither shadow nor be shadowed by one wherever it
    // sits. The only root-level controller (AppController) declares one
    // literal path (`health`) with no parameter segment.
    //
    // AdminFinanceModule imports WalletModule for FLUTTERWAVE_WALLET_GATEWAY.
    // WalletModule is already registered at the top of this list and Nest
    // dedupes, so the load-bearing controller order below is untouched --
    // exactly as it already is for AdminPaymentsModule's own imports.
    AdminFinanceModule,
    // Admin event moderation, for the Events feature reinstated 22 Aug 2026 by
    // product-owner decision (see src/event/ for the app-facing half and
    // prisma/schema.prisma for the three new tables). Registered alongside the
    // other admin modules, and for the same reason they all sit here: Express
    // matches in registration order, so every `/admin/*` route is matched
    // ahead of any module owning a parameterised route -- PartnerServiceController's
    // `@Controller('services')` + `@Get(':id')` being the catch-all that has
    // already bitten twice (see the comment further down).
    //
    // Shadow-safe in the other direction too, which is the direction that
    // matters when registering EARLY. AdminEventsController is
    // `@Controller('admin/events')`; the app's own events surface is
    // `@Controller('events')`, a different FIRST segment, so registering ahead
    // of EventModule cannot shadow it. Nothing outside src/admin/ declares an
    // `admin` prefix, and the only root-level controller (AppController)
    // declares one literal path (`health`) with no parameter segment. Verified
    // by booting and reading the printed route table, not by reasoning about
    // it.
    AdminEventsModule,
    // Admin notification campaigns (build brief C8). Registered alongside the
    // other `/admin/*` modules and for the same shadow-safety reason:
    // AdminNotificationsController is `@Controller('admin/notifications')`;
    // the app's own surface is `@Controller('notifications')`, a different
    // FIRST segment, so neither can swallow the other in either registration
    // order.
    AdminNotificationsModule,
    AccountModule,
    CommentModule,
    CourseLessonModule,
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
    VerificationStateModule,
    VerificationSubmissionModule,
    CreatorDiscoveryModule,
    ProfessionalModule,
    FollowRelationshipModule,
    BlockedAccountModule,
    ContentPieceModule,
    // After ContentPieceModule: VerificationModule imports it for the shared
    // Flutterwave client, and listing it earlier would move ContentPiece's own
    // controllers up the route registration order as a side effect.
    VerificationModule,
    CreditPurchaseModule,
    KycSubmissionModule,
    LearnEntitlementModule,
    MentorRequestModule,
    NotificationSettingsModule,
    PrivacySettingsModule,
    UserProfileModule,
    CourseEnrollmentModule,
    SearchResponseModule,
    CommunityModule,
    CommunityMessageModule,
    CreatorEarningsModule,
    DirectMessageModule,
    PaymentLinkModule,
    // Events, app-facing half -- reinstated 22 Aug 2026 by product-owner
    // decision, reversing the "no Events section" line in WAWU-Web/CLAUDE.md
    // and docs/00_PLATFORM_MAP.md (both amended with that date rather than
    // left contradicting this code).
    //
    // Position is safe in both directions. EventController is
    // `@Controller('events')`: a first segment no other controller in this
    // file declares, so it can neither shadow nor be shadowed by one -- in
    // particular it is NOT under `services`, so PartnerServiceController's
    // `@Get(':id')` catch-all cannot reach it wherever either sits. Its own
    // `mine` route is declared before `:id` INSIDE the controller, which is
    // where that ordering actually matters. AdminEventsModule above owns
    // `admin/events` and is deliberately a separate module: two halves, two
    // guards, two role vocabularies, one set of tables.
    EventModule,
    EventTicketingModule,
    ShopModule,
    // The Naira wallet's served routes (task MONEY-09 first: the transaction
    // PIN). `@Controller('money')` is a first segment nothing else declares,
    // so it can neither shadow nor be shadowed wherever it sits. The declared,
    // unserved half (MoneyContractModule) is never imported here.
    MoneyModule,
    // About and the Terms and Privacy policy text (task SETTINGS-02): `about` and
    // `policies` are first segments nothing else declares; the admin write sits
    // under `admin/policies`.
    AboutModule,
    AdminLegalDocumentsModule,
    // Free chat between two users (task INBOX-06). `@Controller('chats')` is a
    // first segment nothing else declares, so it cannot shadow or be shadowed.
    ChatModule,
    // Fintava's webhooks (task MONEY-07): POST /webhooks/fintava, recorded
    // once, no money moved. `webhooks/fintava` is a fixed path no other
    // controller declares, beside the unchanged `webhooks/flutterwave`.
    FintavaWebhookModule,
    // Admin ad management (task ADS-06): `admin/ads`, a second segment no other
    // controller declares, so it cannot shadow or be shadowed wherever it sits.
    AdminAdsModule,

    // LAST on purpose. PaymentWebhookModule imports every money module so it
    // can reuse their /verify settlement, and every one of them is already
    // registered above — Nest dedupes, so the load-bearing controller order
    // (MentorModule / ServiceApplicationModule before PartnerServiceModule's
    // `@Get(':id')` catch-all) is unaffected.
    PaymentWebhookModule,
  ],
  controllers: [AppController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // FIX-05: the guard above counts in our own store, one bucket per caller
    // (src/hub-throttler-storage.ts), not the library's default one, whose
    // ending of one caller's block stopped every other caller's hits expiring.
    HUB_THROTTLER_STORAGE,
  ],
})
export class AppModule {}
