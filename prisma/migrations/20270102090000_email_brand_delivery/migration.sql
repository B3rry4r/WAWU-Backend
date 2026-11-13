-- EMAIL-03: bulk email for Who Made This and Voices. Additive only: nullable columns, two new tables, one index.
-- AlterTable
ALTER TABLE "EmailTemplate" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "buttonText" TEXT,
ADD COLUMN     "buttonUrl" TEXT;

-- AlterTable
ALTER TABLE "EmailCampaign" ADD COLUMN     "brand" TEXT,
ADD COLUMN     "buttonText" TEXT,
ADD COLUMN     "buttonUrl" TEXT,
ADD COLUMN     "pauseReason" TEXT,
ADD COLUMN     "pausedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "EmailRecipient" ADD COLUMN     "delivery" TEXT,
ADD COLUMN     "deliveryAt" TIMESTAMP(3),
ADD COLUMN     "deliveryNote" TEXT;

-- CreateTable
CREATE TABLE "EmailBrandSuppression" (
    "email" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailBrandSuppression_pkey" PRIMARY KEY ("email","brand")
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" TEXT NOT NULL,
    "svixId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "providerId" TEXT,
    "email" TEXT,
    "at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_svixId_key" ON "EmailEvent"("svixId");

-- CreateIndex
CREATE INDEX "EmailEvent_providerId_idx" ON "EmailEvent"("providerId");

-- CreateIndex
CREATE INDEX "EmailRecipient_providerId_idx" ON "EmailRecipient"("providerId");

