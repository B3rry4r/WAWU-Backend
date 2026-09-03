-- CreateTable
CREATE TABLE "ReferralClaim" (
    "wawuUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralClaim_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateIndex
CREATE INDEX "ReferralClaim_code_idx" ON "ReferralClaim"("code");
