-- Transaction PIN: reserved checks (task MONEY-17, round 3).
--
-- Additive only: two columns on "TransactionPin", one with a default and one
-- nullable. No existing column, index or row changes meaning.
--
-- "pendingTries": checks that took a slot and have not finished. A check
-- takes a slot in one conditional UPDATE (failedTries + pendingTries below
-- the limit), compares the PIN with no transaction and no row lock open,
-- and gives the slot back in one more UPDATE.
-- "pendingSince": when the newest slot was taken, so a slot left by a check
-- that died counts as free after 30 seconds.
--
-- Rollback: ALTER TABLE "TransactionPin" DROP COLUMN "pendingSince", DROP COLUMN "pendingTries";

-- AlterTable
ALTER TABLE "TransactionPin" ADD COLUMN     "pendingSince" TIMESTAMP(3),
ADD COLUMN     "pendingTries" INTEGER NOT NULL DEFAULT 0;
