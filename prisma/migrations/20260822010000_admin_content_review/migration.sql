-- Content moderation audit trail — admin-surface-extension Phase 6.
--
-- ADDITIVE ONLY. One new enum type, one new table, three new indexes.
-- There is deliberately no ALTER TABLE below: nothing in
-- .pipeline/protected-registry.json's schema map is dropped, renamed,
-- retyped, narrowed or widened.
--
-- Why a side table instead of moderationReason/moderatedAt/moderatedBy
-- columns on "ContentPiece": protected-surface hazard H-1. Almost every wire
-- type in src/common/types is a bare re-export of its Prisma model and the
-- services return whole rows by spread, so a new ContentPiece column would
-- appear in the SHIPPED app's content responses without a single line of
-- application code changing. A separate table cannot do that.
--
-- No foreign keys, matching how every other cross-boundary reference in this
-- schema is stored (KycSubmission.wawuUserId, Purchase.buyerWawuId): an FK to
-- "ContentPiece" would require a back-relation field on that model, and an
-- audit row has to outlive the record it audits regardless.

-- CreateEnum
CREATE TYPE "AdminContentDecision" AS ENUM ('approved', 'rejected');

-- CreateTable
CREATE TABLE "AdminContentReview" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "creatorWawuId" TEXT NOT NULL,
    "decision" "AdminContentDecision" NOT NULL,
    "previousStatus" "ContentStatus" NOT NULL,
    "newStatus" "ContentStatus" NOT NULL,
    "reason" TEXT,
    "slotReturned" BOOLEAN NOT NULL DEFAULT false,
    "reviewedByAdminId" TEXT NOT NULL,
    "reviewedByAdminEmail" TEXT NOT NULL,
    "reviewedByAdminRole" "AdminRole" NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminContentReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminContentReview_contentId_idx" ON "AdminContentReview"("contentId");

-- CreateIndex
CREATE INDEX "AdminContentReview_reviewedByAdminId_idx" ON "AdminContentReview"("reviewedByAdminId");

-- CreateIndex
CREATE INDEX "AdminContentReview_reviewedAt_idx" ON "AdminContentReview"("reviewedAt");
