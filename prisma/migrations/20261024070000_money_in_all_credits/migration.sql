-- Money in, told for every credit (task WALLET-39, R-54).
--
-- Additive only: two new nullable columns on "MoneyInNotice" (WALLET-10's
-- table). No existing column, row, constraint or index changes.
--
-- "correctedAt" and "correctionNotificationId": a credit the person was told
-- about ("sent") that the ledger later reverses is followed by one correction
-- notice. The correction and "correctedAt" are written in one transaction, so
-- a reversal is corrected once. Both stay null on a "muted" or "before" mark:
-- nothing was said, so nothing is corrected.
--
-- Backfill 1: the credits of the three newly told categories (transfer,
-- earning, refund) already in the ledger when this migration runs are marked
-- "before" (not news), so the first sweep after the deploy does not tell
-- people about money they saw in their history days ago. A credit still
-- "pending" is not marked: it is told when it completes. Same rule as
-- WALLET-10's backfill for "top_up". Safe to replay (ON CONFLICT DO NOTHING).
--
-- Backfill 2: a credit that was told and is already reversed gets
-- "correctedAt" now, with no notification, so the first sweep after the deploy
-- does not announce a reversal that is old news.
--
-- Rollback: rollback.sql, by hand.

-- AlterTable
ALTER TABLE "MoneyInNotice"
  ADD COLUMN "correctedAt" TIMESTAMP(3),
  ADD COLUMN "correctionNotificationId" TEXT;

-- Backfill 1: the credits already there are not news.
INSERT INTO "MoneyInNotice" ("entryId", "outcome")
SELECT "id", 'before'
  FROM "FintavaLedgerEntry"
 WHERE "direction" = 'in'
   AND "category" IN ('transfer', 'earning', 'refund')
   AND "walletKind" = 'user'
   AND "status" <> 'pending'
ON CONFLICT ("entryId") DO NOTHING;

-- Backfill 2: a reversal that is already in the ledger is not news either.
UPDATE "MoneyInNotice" AS m
   SET "correctedAt" = now()
  FROM "FintavaLedgerEntry" AS e
 WHERE e."id" = m."entryId"
   AND m."outcome" = 'sent'
   AND e."status" = 'reversed'
   AND m."correctedAt" IS NULL;
