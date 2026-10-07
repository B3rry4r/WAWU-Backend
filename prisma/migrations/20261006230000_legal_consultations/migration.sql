-- LEGAL-03. Additive only: new enum values, one nullable column, three new
-- tables. Nothing the web or the dashboard calls is renamed, retyped or removed.
--
-- The three consultation rows below carry what the web already charges today
-- (the figures the code held as constants until now), so no price the web
-- shows or takes changes when this lands. From here on WAWU sets them in admin
-- (R-14). There is no row for a phone call: nobody has set a price for one, so
-- it is not offered until WAWU does.

-- AlterEnum
ALTER TYPE "AdminOpsAction" ADD VALUE 'legal_price_set';

-- AlterEnum
ALTER TYPE "AdminOpsResource" ADD VALUE 'legal_price';

-- AlterEnum
ALTER TYPE "ConsultationMedium" ADD VALUE 'phone';

-- AlterTable
ALTER TABLE "LegalRequest" ADD COLUMN     "consultationMinutes" INTEGER;

-- CreateTable
CREATE TABLE "LegalConsultationOption" (
    "id" TEXT NOT NULL,
    "medium" "ConsultationMedium" NOT NULL,
    "priceKobo" INTEGER,
    "minutes" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByAdminId" TEXT,

    CONSTRAINT "LegalConsultationOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegalServicePrice" (
    "serviceCode" TEXT NOT NULL,
    "priceKobo" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByAdminId" TEXT,

    CONSTRAINT "LegalServicePrice_pkey" PRIMARY KEY ("serviceCode")
);

-- CreateTable
CREATE TABLE "LegalDeliverable" (
    "id" TEXT NOT NULL,
    "legalRequestId" TEXT NOT NULL,
    "wawuUserId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "pages" INTEGER,
    "chatMessageId" TEXT,
    "postedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegalDeliverable_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegalConsultationOption_medium_key" ON "LegalConsultationOption"("medium");

-- CreateIndex
CREATE UNIQUE INDEX "LegalDeliverable_chatMessageId_key" ON "LegalDeliverable"("chatMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "LegalDeliverable_legalRequestId_url_key" ON "LegalDeliverable"("legalRequestId", "url");

-- CreateIndex
CREATE INDEX "LegalDeliverable_legalRequestId_createdAt_idx" ON "LegalDeliverable"("legalRequestId", "createdAt");

-- CreateIndex
CREATE INDEX "LegalDeliverable_wawuUserId_idx" ON "LegalDeliverable"("wawuUserId");

-- Seed: the consultation prices and lengths in force today (whole naira, in kobo).
INSERT INTO "LegalConsultationOption" ("id", "medium", "priceKobo", "minutes", "enabled", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'chat', 2500000, 60, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'zoom', 4500000, 60, true, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'physical', NULL, NULL, true, CURRENT_TIMESTAMP);
