-- Money in, told once (task WALLET-10, BACKEND_GAPS G-33).
--
-- Additive only: one new table, "MoneyInNotice", one new enum, and one index
-- on "FintavaLedgerEntry" for the sweep that reads it. No existing column,
-- row or constraint changes.
--
-- MoneyInNotice: one row per credited ledger row (direction in, category
-- top_up, on a person's wallet) that the money-in notice sweep has dealt with.
-- The primary key is the exactly-once rule: a second Hub process, a replay or
-- a ledger row seen twice meets it. The row is written in the same
-- transaction as the Notification it answers, so a stop between the two
-- writes undoes both. It goes with its ledger row (ON DELETE CASCADE), which
-- is deleted with the account, and names no person.
--
-- The index serves the sweep's read of the credits the Hub learned of lately
-- (direction, category, createdAt).
--
-- Backfill: every credit already in the ledger when this migration runs is
-- marked "before" (not news), so the first sweep after the deploy does not
-- tell people about money they saw in their history days ago. A credit still
-- "pending" is not marked: it is told when it completes. Safe to replay
-- (ON CONFLICT DO NOTHING).
--
-- Rollback: rollback.sql, by hand.

-- CreateEnum
CREATE TYPE "MoneyInNoticeOutcome" AS ENUM ('sent', 'muted', 'before');

-- CreateTable
CREATE TABLE "MoneyInNotice" (
    "entryId" TEXT NOT NULL,
    "outcome" "MoneyInNoticeOutcome" NOT NULL,
    "notificationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MoneyInNotice_pkey" PRIMARY KEY ("entryId")
);

-- CreateIndex
CREATE INDEX "FintavaLedgerEntry_direction_category_createdAt_idx" ON "FintavaLedgerEntry"("direction", "category", "createdAt");

-- AddForeignKey
ALTER TABLE "MoneyInNotice" ADD CONSTRAINT "MoneyInNotice_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "FintavaLedgerEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: the credits already there are not news.
INSERT INTO "MoneyInNotice" ("entryId", "outcome")
SELECT "id", 'before'
  FROM "FintavaLedgerEntry"
 WHERE "direction" = 'in'
   AND "category" = 'top_up'
   AND "walletKind" = 'user'
   AND "status" <> 'pending'
ON CONFLICT ("entryId") DO NOTHING;
