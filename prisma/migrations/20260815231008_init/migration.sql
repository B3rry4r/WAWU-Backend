-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('user', 'creator');

-- CreateEnum
CREATE TYPE "CreatorTier" AS ENUM ('basic', 'pro');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "VerificationTier" AS ENUM ('basic', 'verified_user', 'verified_business', 'certified_professional', 'trusted_partner');

-- CreateEnum
CREATE TYPE "ContentType" AS ENUM ('video', 'course', 'audio', 'pdf', 'image', 'template');

-- CreateEnum
CREATE TYPE "AccessType" AS ENUM ('free', 'paid');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('pending', 'live', 'rejected');

-- CreateEnum
CREATE TYPE "PurchaseType" AS ENUM ('content', 'tip');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('pending', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "DmStatus" AS ENUM ('awaiting_response', 'responded', 'refunded');

-- CreateEnum
CREATE TYPE "PenaltyState" AS ENUM ('none', 'warned', 'disabled_7d', 'disabled_30d');

-- CreateEnum
CREATE TYPE "CommunityKind" AS ENUM ('open', 'private');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('joined', 'pending');

-- CreateEnum
CREATE TYPE "CreditPack" AS ENUM ('starter', 'popular', 'pro');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('active', 'past_due', 'cancelled', 'expired');

-- CreateEnum
CREATE TYPE "PartnerServiceStatus" AS ENUM ('live', 'coming');

-- CreateEnum
CREATE TYPE "ServiceApplicationKind" AS ENUM ('cac', 'nepc', 'mentor-request');

-- CreateEnum
CREATE TYPE "GuideKind" AS ENUM ('country', 'article', 'template');

-- CreateEnum
CREATE TYPE "ShopKind" AS ENUM ('basket', 'beauty');

-- CreateTable
CREATE TABLE "UserProfile" (
    "wawuUserId" TEXT NOT NULL,
    "accountType" "AccountType" NOT NULL,
    "handle" TEXT,
    "bio" TEXT,
    "interests" TEXT[],
    "instagramHandle" TEXT,
    "whatsappHandle" TEXT,
    "websiteUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateTable
CREATE TABLE "CreatorState" (
    "wawuUserId" TEXT NOT NULL,
    "tier" "CreatorTier" NOT NULL,
    "subscriptionPaid" BOOLEAN NOT NULL DEFAULT false,
    "kycStatus" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "slotsUsed" INTEGER NOT NULL DEFAULT 0,
    "dmPrice" INTEGER,
    "dmEnabled" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CreatorState_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateTable
CREATE TABLE "VerificationSubmission" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "tier" "VerificationTier" NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "documents" TEXT[],
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,

    CONSTRAINT "VerificationSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KycSubmission" (
    "id" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "bvn" TEXT,
    "nin" TEXT,
    "nationalIdEquivalent" TEXT,
    "idDocumentType" TEXT NOT NULL,
    "idDocumentUrl" TEXT NOT NULL,
    "payoutBankName" TEXT NOT NULL,
    "payoutAccountNumber" TEXT NOT NULL,
    "status" "ReviewStatus" NOT NULL DEFAULT 'pending',
    "rejectionReason" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),

    CONSTRAINT "KycSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPiece" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "creatorWawuId" TEXT NOT NULL,
    "contentType" "ContentType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accessType" "AccessType" NOT NULL,
    "price" INTEGER NOT NULL,
    "durationLabel" TEXT,
    "pageCount" INTEGER,
    "previewAssetUrl" TEXT NOT NULL,
    "fullAssetUrl" TEXT,
    "creatorFirstUploadFree" BOOLEAN NOT NULL DEFAULT false,
    "status" "ContentStatus" NOT NULL DEFAULT 'pending',
    "views" INTEGER NOT NULL DEFAULT 0,
    "ratingPct" INTEGER,
    "commentCount" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentPiece_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseLesson" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "durationLabel" TEXT,

    CONSTRAINT "CourseLesson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "authorWawuId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "replyToId" TEXT,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "contentId" TEXT,
    "type" "PurchaseType" NOT NULL,
    "buyerWawuId" TEXT NOT NULL,
    "creatorWawuId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "commissionRate" DECIMAL(5,4) NOT NULL,
    "flutterwaveTxRef" TEXT NOT NULL,
    "flutterwaveTxId" TEXT,
    "status" "TransactionStatus" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedItem" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowRelationship" (
    "id" TEXT NOT NULL,
    "followerWawuId" TEXT NOT NULL,
    "followingWawuId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowRelationship_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DirectMessage" (
    "id" TEXT NOT NULL,
    "creatorWawuId" TEXT NOT NULL,
    "senderWawuId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "DmStatus" NOT NULL DEFAULT 'awaiting_response',
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "respondedAt" TIMESTAMP(3),
    "responseText" TEXT,
    "flutterwaveTxRef" TEXT NOT NULL,

    CONSTRAINT "DirectMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorNoResponseTracker" (
    "creatorWawuId" TEXT NOT NULL,
    "noResponseRatePct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "penaltyState" "PenaltyState" NOT NULL DEFAULT 'none',
    "dmDisabledUntil" TIMESTAMP(3),

    CONSTRAINT "CreatorNoResponseTracker_pkey" PRIMARY KEY ("creatorWawuId")
);

-- CreateTable
CREATE TABLE "DmReport" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "reporterWawuId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Community" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "hostWawuId" TEXT NOT NULL,
    "kind" "CommunityKind" NOT NULL,

    CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityMembership" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'joined',
    "joinedAt" TIMESTAMP(3),

    CONSTRAINT "CommunityMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunityMessage" (
    "id" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "senderWawuId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "costInCredits" INTEGER NOT NULL DEFAULT 1,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunityMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditsState" (
    "userWawuId" TEXT NOT NULL,
    "creditBalance" INTEGER NOT NULL DEFAULT 0,
    "trialEndsAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditsState_pkey" PRIMARY KEY ("userWawuId")
);

-- CreateTable
CREATE TABLE "CreditPurchase" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "pack" "CreditPack" NOT NULL,
    "creditsGranted" INTEGER NOT NULL,
    "flutterwaveTxRef" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'pending',
    "purchasedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditPurchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditSpend" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "communityId" TEXT NOT NULL,
    "creditsSpent" INTEGER NOT NULL DEFAULT 1,
    "creatorWawuId" TEXT NOT NULL,
    "spentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditSpend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorSubscription" (
    "creatorWawuId" TEXT NOT NULL,
    "tier" "CreatorTier" NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'active',
    "commissionRateOverride" DECIMAL(5,4),
    "flutterwaveCustomerRef" TEXT,
    "flutterwavePlanId" TEXT,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "renewalAttempts" INTEGER NOT NULL DEFAULT 0,
    "cancelsAt" TIMESTAMP(3),
    "cardLast4" TEXT,

    CONSTRAINT "CreatorSubscription_pkey" PRIMARY KEY ("creatorWawuId")
);

-- CreateTable
CREATE TABLE "EvgScore" (
    "creatorWawuId" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EvgScore_pkey" PRIMARY KEY ("creatorWawuId")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tone" TEXT NOT NULL,
    "amount" INTEGER,
    "creditsCount" INTEGER,
    "actionLabel" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSettings" (
    "userWawuId" TEXT NOT NULL,
    "newReplies" BOOLEAN NOT NULL DEFAULT true,
    "newFollowers" BOOLEAN NOT NULL DEFAULT true,
    "dmReminders" BOOLEAN NOT NULL DEFAULT true,
    "refunds" BOOLEAN NOT NULL DEFAULT true,
    "promotions" BOOLEAN NOT NULL DEFAULT false,
    "communityDigest" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotificationSettings_pkey" PRIMARY KEY ("userWawuId")
);

-- CreateTable
CREATE TABLE "PartnerService" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "blurb" TEXT NOT NULL,
    "icon" TEXT NOT NULL,
    "status" "PartnerServiceStatus" NOT NULL,
    "turnaround" TEXT,
    "priceFrom" TEXT,
    "partner" TEXT,
    "comingNote" TEXT,

    CONSTRAINT "PartnerService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ServiceApplication" (
    "id" TEXT NOT NULL,
    "applicantWawuId" TEXT NOT NULL,
    "kind" "ServiceApplicationKind" NOT NULL,
    "title" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "appliedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "statusLabel" TEXT NOT NULL,
    "amountPaid" INTEGER,
    "certificateExpectedBy" DATE,
    "timeline" JSONB NOT NULL,
    "rejection" TEXT,

    CONSTRAINT "ServiceApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mentor" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "tagline" TEXT NOT NULL,
    "bio" TEXT NOT NULL,
    "topics" TEXT[],
    "verification" TEXT NOT NULL,
    "openForRequests" BOOLEAN NOT NULL DEFAULT true,
    "fullUntil" TEXT,
    "yearsExperience" INTEGER NOT NULL,
    "sessions" INTEGER NOT NULL DEFAULT 0,
    "languages" TEXT[],

    CONSTRAINT "Mentor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorRequest" (
    "id" TEXT NOT NULL,
    "mentorId" TEXT NOT NULL,
    "requesterWawuId" TEXT NOT NULL,
    "topics" TEXT[],
    "note" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MentorRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnCourse" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "hours" INTEGER NOT NULL,
    "certificate" BOOLEAN NOT NULL DEFAULT false,
    "overview" TEXT NOT NULL,
    "whatItCovers" TEXT[],
    "externalHostUrl" TEXT NOT NULL,

    CONSTRAINT "LearnCourse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseEnrollment" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "progressPct" INTEGER,

    CONSTRAINT "CourseEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Playbook" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "pages" INTEGER NOT NULL,
    "format" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "chapters" JSONB NOT NULL,
    "readingSections" JSONB NOT NULL,

    CONSTRAINT "Playbook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnGuide" (
    "id" TEXT NOT NULL,
    "kind" "GuideKind" NOT NULL,
    "title" TEXT NOT NULL,
    "updated" DATE NOT NULL,
    "country" TEXT,
    "subtitle" TEXT NOT NULL,
    "readMinutes" INTEGER NOT NULL,
    "sections" JSONB,
    "fileCount" INTEGER,

    CONSTRAINT "LearnGuide_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketplaceSave" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shop" "ShopKind" NOT NULL,
    "savedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketplaceSave_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacySettings" (
    "userWawuId" TEXT NOT NULL,
    "showPurchases" BOOLEAN NOT NULL DEFAULT true,
    "showSavedItems" BOOLEAN NOT NULL DEFAULT true,
    "showFollowing" BOOLEAN NOT NULL DEFAULT true,
    "showInMemberLists" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "PrivacySettings_pkey" PRIMARY KEY ("userWawuId")
);

-- CreateTable
CREATE TABLE "BlockedAccount" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "blockedWawuId" TEXT NOT NULL,
    "blockedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataExportRequest" (
    "id" TEXT NOT NULL,
    "userWawuId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DataExportRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_handle_key" ON "UserProfile"("handle");

-- CreateIndex
CREATE INDEX "UserProfile_accountType_idx" ON "UserProfile"("accountType");

-- CreateIndex
CREATE INDEX "CreatorState_tier_idx" ON "CreatorState"("tier");

-- CreateIndex
CREATE INDEX "CreatorState_kycStatus_idx" ON "CreatorState"("kycStatus");

-- CreateIndex
CREATE INDEX "VerificationSubmission_wawuUserId_idx" ON "VerificationSubmission"("wawuUserId");

-- CreateIndex
CREATE INDEX "VerificationSubmission_status_idx" ON "VerificationSubmission"("status");

-- CreateIndex
CREATE INDEX "KycSubmission_wawuUserId_idx" ON "KycSubmission"("wawuUserId");

-- CreateIndex
CREATE INDEX "KycSubmission_status_idx" ON "KycSubmission"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPiece_slug_key" ON "ContentPiece"("slug");

-- CreateIndex
CREATE INDEX "ContentPiece_creatorWawuId_idx" ON "ContentPiece"("creatorWawuId");

-- CreateIndex
CREATE INDEX "ContentPiece_status_idx" ON "ContentPiece"("status");

-- CreateIndex
CREATE INDEX "ContentPiece_category_idx" ON "ContentPiece"("category");

-- CreateIndex
CREATE INDEX "ContentPiece_contentType_idx" ON "ContentPiece"("contentType");

-- CreateIndex
CREATE INDEX "CourseLesson_contentId_idx" ON "CourseLesson"("contentId");

-- CreateIndex
CREATE INDEX "Comment_contentId_idx" ON "Comment"("contentId");

-- CreateIndex
CREATE INDEX "Comment_authorWawuId_idx" ON "Comment"("authorWawuId");

-- CreateIndex
CREATE INDEX "Purchase_buyerWawuId_idx" ON "Purchase"("buyerWawuId");

-- CreateIndex
CREATE INDEX "Purchase_creatorWawuId_idx" ON "Purchase"("creatorWawuId");

-- CreateIndex
CREATE INDEX "Purchase_contentId_idx" ON "Purchase"("contentId");

-- CreateIndex
CREATE INDEX "Purchase_status_idx" ON "Purchase"("status");

-- CreateIndex
CREATE INDEX "SavedItem_userWawuId_idx" ON "SavedItem"("userWawuId");

-- CreateIndex
CREATE INDEX "SavedItem_contentId_idx" ON "SavedItem"("contentId");

-- CreateIndex
CREATE UNIQUE INDEX "SavedItem_userWawuId_contentId_key" ON "SavedItem"("userWawuId", "contentId");

-- CreateIndex
CREATE INDEX "FollowRelationship_followerWawuId_idx" ON "FollowRelationship"("followerWawuId");

-- CreateIndex
CREATE INDEX "FollowRelationship_followingWawuId_idx" ON "FollowRelationship"("followingWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "FollowRelationship_followerWawuId_followingWawuId_key" ON "FollowRelationship"("followerWawuId", "followingWawuId");

-- CreateIndex
CREATE INDEX "DirectMessage_creatorWawuId_idx" ON "DirectMessage"("creatorWawuId");

-- CreateIndex
CREATE INDEX "DirectMessage_senderWawuId_idx" ON "DirectMessage"("senderWawuId");

-- CreateIndex
CREATE INDEX "DirectMessage_status_deadlineAt_idx" ON "DirectMessage"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "DmReport_threadId_idx" ON "DmReport"("threadId");

-- CreateIndex
CREATE INDEX "DmReport_reporterWawuId_idx" ON "DmReport"("reporterWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "DmReport_threadId_reporterWawuId_key" ON "DmReport"("threadId", "reporterWawuId");

-- CreateIndex
CREATE INDEX "Community_hostWawuId_idx" ON "Community"("hostWawuId");

-- CreateIndex
CREATE INDEX "Community_kind_idx" ON "Community"("kind");

-- CreateIndex
CREATE INDEX "CommunityMembership_userWawuId_idx" ON "CommunityMembership"("userWawuId");

-- CreateIndex
CREATE INDEX "CommunityMembership_communityId_idx" ON "CommunityMembership"("communityId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunityMembership_userWawuId_communityId_key" ON "CommunityMembership"("userWawuId", "communityId");

-- CreateIndex
CREATE INDEX "CommunityMessage_communityId_idx" ON "CommunityMessage"("communityId");

-- CreateIndex
CREATE INDEX "CommunityMessage_senderWawuId_idx" ON "CommunityMessage"("senderWawuId");

-- CreateIndex
CREATE INDEX "CreditPurchase_userWawuId_idx" ON "CreditPurchase"("userWawuId");

-- CreateIndex
CREATE INDEX "CreditPurchase_status_idx" ON "CreditPurchase"("status");

-- CreateIndex
CREATE INDEX "CreditSpend_userWawuId_idx" ON "CreditSpend"("userWawuId");

-- CreateIndex
CREATE INDEX "CreditSpend_communityId_idx" ON "CreditSpend"("communityId");

-- CreateIndex
CREATE INDEX "CreditSpend_creatorWawuId_idx" ON "CreditSpend"("creatorWawuId");

-- CreateIndex
CREATE INDEX "CreatorSubscription_status_idx" ON "CreatorSubscription"("status");

-- CreateIndex
CREATE INDEX "CreatorSubscription_currentPeriodEnd_idx" ON "CreatorSubscription"("currentPeriodEnd");

-- CreateIndex
CREATE INDEX "Notification_userWawuId_idx" ON "Notification"("userWawuId");

-- CreateIndex
CREATE INDEX "Notification_userWawuId_read_idx" ON "Notification"("userWawuId", "read");

-- CreateIndex
CREATE INDEX "ServiceApplication_applicantWawuId_idx" ON "ServiceApplication"("applicantWawuId");

-- CreateIndex
CREATE INDEX "ServiceApplication_kind_idx" ON "ServiceApplication"("kind");

-- CreateIndex
CREATE UNIQUE INDEX "Mentor_handle_key" ON "Mentor"("handle");

-- CreateIndex
CREATE INDEX "Mentor_category_idx" ON "Mentor"("category");

-- CreateIndex
CREATE INDEX "MentorRequest_mentorId_idx" ON "MentorRequest"("mentorId");

-- CreateIndex
CREATE INDEX "MentorRequest_requesterWawuId_idx" ON "MentorRequest"("requesterWawuId");

-- CreateIndex
CREATE INDEX "LearnCourse_category_idx" ON "LearnCourse"("category");

-- CreateIndex
CREATE INDEX "CourseEnrollment_userWawuId_idx" ON "CourseEnrollment"("userWawuId");

-- CreateIndex
CREATE INDEX "CourseEnrollment_courseId_idx" ON "CourseEnrollment"("courseId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseEnrollment_userWawuId_courseId_key" ON "CourseEnrollment"("userWawuId", "courseId");

-- CreateIndex
CREATE INDEX "LearnGuide_kind_idx" ON "LearnGuide"("kind");

-- CreateIndex
CREATE INDEX "LearnGuide_country_idx" ON "LearnGuide"("country");

-- CreateIndex
CREATE INDEX "MarketplaceSave_userWawuId_idx" ON "MarketplaceSave"("userWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketplaceSave_userWawuId_productId_shop_key" ON "MarketplaceSave"("userWawuId", "productId", "shop");

-- CreateIndex
CREATE INDEX "BlockedAccount_userWawuId_idx" ON "BlockedAccount"("userWawuId");

-- CreateIndex
CREATE INDEX "BlockedAccount_blockedWawuId_idx" ON "BlockedAccount"("blockedWawuId");

-- CreateIndex
CREATE UNIQUE INDEX "BlockedAccount_userWawuId_blockedWawuId_key" ON "BlockedAccount"("userWawuId", "blockedWawuId");

-- CreateIndex
CREATE INDEX "DataExportRequest_userWawuId_idx" ON "DataExportRequest"("userWawuId");

-- AddForeignKey
ALTER TABLE "CourseLesson" ADD CONSTRAINT "CourseLesson_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "Comment"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedItem" ADD CONSTRAINT "SavedItem_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ContentPiece"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmReport" ADD CONSTRAINT "DmReport_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DirectMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityMembership" ADD CONSTRAINT "CommunityMembership_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunityMessage" ADD CONSTRAINT "CommunityMessage_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditSpend" ADD CONSTRAINT "CreditSpend_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "Community"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MentorRequest" ADD CONSTRAINT "MentorRequest_mentorId_fkey" FOREIGN KEY ("mentorId") REFERENCES "Mentor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseEnrollment" ADD CONSTRAINT "CourseEnrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "LearnCourse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
