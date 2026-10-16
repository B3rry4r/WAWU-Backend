-- EMAIL-01: the email campaign tool in the admin dashboard.
--
-- Additive: four new tables and three new enums. No existing table, column,
-- index or value is touched, and an older instance never reads or writes them.
--
-- Rollback (also in rollback.sql):
--   DROP TABLE "EmailRecipient", "EmailCampaign", "EmailTemplate", "EmailSuppression";
--   DROP TYPE "EmailCampaignStatus", "EmailRecipientStatus", "EmailSuppressionReason";
--   DELETE FROM "_prisma_migrations" WHERE migration_name = '20261021250000_email_campaigns';

CREATE TYPE "EmailCampaignStatus" AS ENUM ('ready', 'sending', 'sent');
CREATE TYPE "EmailRecipientStatus" AS ENUM ('queued', 'sent', 'failed', 'skipped');
CREATE TYPE "EmailSuppressionReason" AS ENUM ('unsubscribed', 'bounced', 'complained');

CREATE TABLE "EmailTemplate" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "previewText" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailTemplate_updatedAt_idx" ON "EmailTemplate"("updatedAt");

CREATE TABLE "EmailCampaign" (
  "id" TEXT NOT NULL,
  "templateId" TEXT,
  "templateName" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "previewText" TEXT NOT NULL DEFAULT '',
  "body" TEXT NOT NULL,
  "audienceKind" TEXT NOT NULL,
  "audienceNote" TEXT NOT NULL,
  "status" "EmailCampaignStatus" NOT NULL DEFAULT 'ready',
  "totalCount" INTEGER NOT NULL DEFAULT 0,
  "sentCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "skippedCount" INTEGER NOT NULL DEFAULT 0,
  "invalidCount" INTEGER NOT NULL DEFAULT 0,
  "duplicateCount" INTEGER NOT NULL DEFAULT 0,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailCampaign_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailCampaign_createdAt_idx" ON "EmailCampaign"("createdAt");
CREATE INDEX "EmailCampaign_status_idx" ON "EmailCampaign"("status");

CREATE TABLE "EmailRecipient" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "firstName" TEXT,
  "status" "EmailRecipientStatus" NOT NULL DEFAULT 'queued',
  "claimedAt" TIMESTAMP(3),
  "providerId" TEXT,
  "error" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailRecipient_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailRecipient_campaignId_email_key" ON "EmailRecipient"("campaignId", "email");
CREATE INDEX "EmailRecipient_campaignId_status_idx" ON "EmailRecipient"("campaignId", "status");
ALTER TABLE "EmailRecipient" ADD CONSTRAINT "EmailRecipient_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "EmailCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EmailSuppression" (
  "email" TEXT NOT NULL,
  "reason" "EmailSuppressionReason" NOT NULL,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailSuppression_pkey" PRIMARY KEY ("email")
);
