-- Rollback of 20261029090000_community_pass_removal_refund (INBOX-25).
-- Run with: psql -1 -f rollback.sql (plain psql -f or a pipe works the same).
-- Refuses (and changes nothing) while any money record of this task exists: a
-- refund, a deduction, a take, or a pass marked as paid back cannot be rebuilt
-- once dropped. Export them first, then run this again.
-- The guard and every drop are ONE statement (a single DO block), so a refusal
-- stops the drops however the file is run: psql continues after an error when
-- it is not run with -1, and separate statements after a failed guard would
-- still have dropped the tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CommunityPassRefund")
     OR EXISTS (SELECT 1 FROM "EarningDeduction")
     OR EXISTS (SELECT 1 FROM "EarningDeductionTake")
     OR EXISTS (SELECT 1 FROM "CommunityPass" WHERE "refundId" IS NOT NULL) THEN
    RAISE EXCEPTION 'INBOX-25 rollback refused: pass refunds, deductions or marked passes exist; export them first. Nothing was changed.';
  END IF;

  DROP TRIGGER "EarningDeductionTake_guard_trigger" ON "EarningDeductionTake";
  DROP FUNCTION "EarningDeductionTake_guard"();
  DROP TABLE "EarningDeductionTake";
  DROP TABLE "EarningDeduction";
  DROP TABLE "CommunityPassRefund";
  DROP INDEX "CommunityPass_refundId_idx";
  ALTER TABLE "CommunityPass" DROP COLUMN "refundId";
  DELETE FROM "_prisma_migrations" WHERE migration_name = '20261029090000_community_pass_removal_refund';
END $$;
