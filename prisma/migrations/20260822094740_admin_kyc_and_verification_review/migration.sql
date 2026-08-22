-- CreateEnum
CREATE TYPE "AdminKycAction" AS ENUM ('document_viewed', 'identifiers_revealed', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "AdminVerificationAction" AS ENUM ('document_viewed', 'approved', 'rejected');

-- CreateTable
CREATE TABLE "AdminKycAudit" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "subjectWawuUserId" TEXT NOT NULL,
    "action" "AdminKycAction" NOT NULL,
    "previousStatus" "ReviewStatus",
    "newStatus" "ReviewStatus",
    "reason" TEXT,
    "actedByAdminId" TEXT NOT NULL,
    "actedByAdminEmail" TEXT NOT NULL,
    "actedByAdminRole" "AdminRole" NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminKycAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminVerificationAudit" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "subjectWawuUserId" TEXT NOT NULL,
    "tier" "VerificationTier" NOT NULL,
    "action" "AdminVerificationAction" NOT NULL,
    "previousStatus" "ReviewStatus",
    "newStatus" "ReviewStatus",
    "reason" TEXT,
    "documentIndex" INTEGER,
    "tierElevatedAtWawuId" BOOLEAN NOT NULL DEFAULT false,
    "actedByAdminId" TEXT NOT NULL,
    "actedByAdminEmail" TEXT NOT NULL,
    "actedByAdminRole" "AdminRole" NOT NULL,
    "actedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminVerificationAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdminKycAudit_submissionId_idx" ON "AdminKycAudit"("submissionId");

-- CreateIndex
CREATE INDEX "AdminKycAudit_subjectWawuUserId_idx" ON "AdminKycAudit"("subjectWawuUserId");

-- CreateIndex
CREATE INDEX "AdminKycAudit_actedByAdminId_idx" ON "AdminKycAudit"("actedByAdminId");

-- CreateIndex
CREATE INDEX "AdminKycAudit_actedAt_idx" ON "AdminKycAudit"("actedAt");

-- CreateIndex
CREATE INDEX "AdminVerificationAudit_submissionId_idx" ON "AdminVerificationAudit"("submissionId");

-- CreateIndex
CREATE INDEX "AdminVerificationAudit_subjectWawuUserId_idx" ON "AdminVerificationAudit"("subjectWawuUserId");

-- CreateIndex
CREATE INDEX "AdminVerificationAudit_actedByAdminId_idx" ON "AdminVerificationAudit"("actedByAdminId");

-- CreateIndex
CREATE INDEX "AdminVerificationAudit_actedAt_idx" ON "AdminVerificationAudit"("actedAt");
