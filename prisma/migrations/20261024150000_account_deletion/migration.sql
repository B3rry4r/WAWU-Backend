-- SETTINGS-06 (R-17): deleting an account waits 30 days, the money is handled
-- first, and a cancelled deletion brings everything back.
--
-- Additive: two new tables, nothing else. No existing table, column or row is
-- touched. AccountDeletion is one row per account that asked to be deleted
-- (status scheduled, cancelled or purged); AccountDeletionContent remembers
-- which content pieces the deletion hid and the status each had, so a cancel
-- restores exactly those.
--
-- Rollback (also in rollback.sql): drops both tables. Run it only after every
-- scheduled deletion is cancelled or purged; the Hub then goes back to hiding
-- content for good and freezing nothing.

CREATE TABLE "AccountDeletion" (
  "wawuUserId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'scheduled',
  "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "purgeAfter" TIMESTAMP(3) NOT NULL,
  "walletId" TEXT,
  "walletProvider" TEXT,
  "walletFrozenAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "purgedAt" TIMESTAMP(3),
  "purgeBlockedAt" TIMESTAMP(3),
  "purgeBlockedBy" TEXT,
  "purgeAttempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountDeletion_pkey" PRIMARY KEY ("wawuUserId"),
  CONSTRAINT "AccountDeletion_status_check" CHECK ("status" IN ('scheduled', 'cancelled', 'purged')),
  CONSTRAINT "AccountDeletion_purgeAfter_check" CHECK ("purgeAfter" > "scheduledAt"),
  CONSTRAINT "AccountDeletion_purgeAttempts_check" CHECK ("purgeAttempts" >= 0)
);
CREATE INDEX "AccountDeletion_status_purgeAfter_idx" ON "AccountDeletion"("status", "purgeAfter");

CREATE TABLE "AccountDeletionContent" (
  "id" TEXT NOT NULL,
  "wawuUserId" TEXT NOT NULL,
  "contentPieceId" TEXT NOT NULL,
  "priorStatus" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountDeletionContent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AccountDeletionContent_wawuUserId_contentPieceId_key" ON "AccountDeletionContent"("wawuUserId", "contentPieceId");
CREATE INDEX "AccountDeletionContent_wawuUserId_idx" ON "AccountDeletionContent"("wawuUserId");
