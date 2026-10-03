-- The pending sweep's schedule on the ledger row (task MONEY-08, round 2).
--
-- Additive only: four new columns on "FintavaLedgerEntry" (MONEY-10's
-- table, 20261002210000_fintava_ledger) and one index. No existing column,
-- index or row is touched: every existing row reads nextCheckAt, revivedAt
-- and revivedBy as null and statusChecks as 0, which means "never checked,
-- first check due two minutes after createdAt", exactly what a new row means.
--
-- nextCheckAt and statusChecks hold the sweep's backoff (1, 2, 4 ... 60
-- minutes) so that a restart, a deploy or a second server keeps it; it used
-- to live in each process's memory. revivedAt and revivedBy record that a
-- row failed as "no record at Fintava" was seen again, which is not a
-- disagreement with Fintava and so no longer goes on "discrepancy".
--
-- It touches no table MONEY-12's 20261003100000_wallet_opening touches, so
-- the two apply in either order.
--
-- `prisma migrate diff` also proposes dropping "ContentPiece_specializations_idx".
-- That index predates this task (schema drift, not ours) and is left alone.
--
-- Rollback: DROP INDEX "FintavaLedgerEntry_status_nextCheckAt_idx";
--           ALTER TABLE "FintavaLedgerEntry" DROP COLUMN "nextCheckAt",
--             DROP COLUMN "statusChecks", DROP COLUMN "revivedAt", DROP COLUMN "revivedBy";

-- AlterTable
ALTER TABLE "FintavaLedgerEntry" ADD COLUMN     "nextCheckAt" TIMESTAMP(3),
ADD COLUMN     "revivedAt" TIMESTAMP(3),
ADD COLUMN     "revivedBy" TEXT,
ADD COLUMN     "statusChecks" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "FintavaLedgerEntry_status_nextCheckAt_idx" ON "FintavaLedgerEntry"("status", "nextCheckAt");
