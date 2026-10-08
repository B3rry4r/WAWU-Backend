-- NUV-01: the Nuvion adapter. Additive only: two new tables (NuvionWebhookEvent,
-- NuvionEntity) and a nullable "provider" column, default 'fintava', on the
-- wallet, opening and ledger tables, so a rollback to Fintava acts only on
-- Fintava's rows. Existing rows read 'fintava' (the column default).
-- CreateEnum
CREATE TYPE "NuvionWebhookProcessing" AS ENUM ('pending', 'processed', 'failed', 'unrecognised', 'test');

-- AlterTable
ALTER TABLE "FintavaWallet" ADD COLUMN     "provider" TEXT DEFAULT 'fintava';

-- AlterTable
ALTER TABLE "FintavaWalletOpening" ADD COLUMN     "provider" TEXT DEFAULT 'fintava';

-- AlterTable
ALTER TABLE "FintavaLedgerEntry" ADD COLUMN     "provider" TEXT DEFAULT 'fintava';

-- CreateTable
CREATE TABLE "NuvionWebhookEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "resourceId" TEXT,
    "entityId" TEXT,
    "signedAt" TEXT NOT NULL,
    "bodySha256" TEXT NOT NULL,
    "rawBody" BYTEA NOT NULL,
    "payload" JSONB NOT NULL,
    "processingStatus" "NuvionWebhookProcessing" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedUntil" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "NuvionWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NuvionEntity" (
    "wawuUserId" TEXT NOT NULL,
    "entityId" TEXT,
    "personId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'incomplete',
    "decidedAt" TIMESTAMP(3),
    "rejectionReasons" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accountId" TEXT,
    "nuvionBan" TEXT,
    "accountDetailsId" TEXT,
    "accountDetailsStatus" TEXT,
    "accountNumber" TEXT,
    "issuerBankName" TEXT,
    "issuerBankCode" TEXT,
    "currency" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NuvionEntity_pkey" PRIMARY KEY ("wawuUserId")
);

-- CreateIndex
CREATE UNIQUE INDEX "NuvionWebhookEvent_eventId_key" ON "NuvionWebhookEvent"("eventId");

-- CreateIndex
CREATE INDEX "NuvionWebhookEvent_processingStatus_event_receivedAt_idx" ON "NuvionWebhookEvent"("processingStatus", "event", "receivedAt");

-- CreateIndex
CREATE INDEX "NuvionWebhookEvent_event_resourceId_idx" ON "NuvionWebhookEvent"("event", "resourceId");

-- CreateIndex
CREATE INDEX "NuvionWebhookEvent_entityId_idx" ON "NuvionWebhookEvent"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "NuvionWebhookEvent_signedAt_bodySha256_key" ON "NuvionWebhookEvent"("signedAt", "bodySha256");

-- CreateIndex
CREATE UNIQUE INDEX "NuvionEntity_entityId_key" ON "NuvionEntity"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "NuvionEntity_accountId_key" ON "NuvionEntity"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "NuvionEntity_nuvionBan_key" ON "NuvionEntity"("nuvionBan");

-- CreateIndex
CREATE UNIQUE INDEX "NuvionEntity_accountDetailsId_key" ON "NuvionEntity"("accountDetailsId");

-- CreateIndex
CREATE INDEX "NuvionEntity_status_idx" ON "NuvionEntity"("status");

-- CreateIndex
CREATE INDEX "NuvionEntity_accountNumber_idx" ON "NuvionEntity"("accountNumber");

