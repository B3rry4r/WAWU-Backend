-- CreateTable
CREATE TABLE "ReferralCode" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "discountPercent" INTEGER NOT NULL,
    "tier" "CreatorTier" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "maxUses" INTEGER,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdByAdmin" TEXT,

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ReferralRedemption" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "redeemedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "publicSignupEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferralCode_active_idx" ON "ReferralCode"("active");

-- CreateIndex
CREATE INDEX "ReferralRedemption_wawuUserId_idx" ON "ReferralRedemption"("wawuUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralRedemption_code_wawuUserId_key" ON "ReferralRedemption"("code", "wawuUserId");

-- AddForeignKey
ALTER TABLE "ReferralRedemption" ADD CONSTRAINT "ReferralRedemption_code_fkey" FOREIGN KEY ("code") REFERENCES "ReferralCode"("code") ON DELETE CASCADE ON UPDATE CASCADE;
