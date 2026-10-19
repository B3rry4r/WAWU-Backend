-- Rollback of 20261029090000_community_pass_removal_refund (INBOX-25).
-- Refuses to run while any money record of this task exists: a refund, a
-- deduction, a take, or a pass marked as paid back cannot be rebuilt once
-- dropped. Export them first, then run this again.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "CommunityPassRefund")
     OR EXISTS (SELECT 1 FROM "EarningDeduction")
     OR EXISTS (SELECT 1 FROM "EarningDeductionTake")
     OR EXISTS (SELECT 1 FROM "CommunityPass" WHERE "refundId" IS NOT NULL) THEN
    RAISE EXCEPTION 'INBOX-25 rollback refused: pass refunds, deductions or marked passes exist; export them first';
  END IF;
END $$;

DROP TRIGGER "EarningDeductionTake_guard_trigger" ON "EarningDeductionTake";
DROP FUNCTION "EarningDeductionTake_guard"();
DROP TABLE "EarningDeductionTake";
DROP TABLE "EarningDeduction";
DROP TABLE "CommunityPassRefund";
DROP INDEX "CommunityPass_refundId_idx";
ALTER TABLE "CommunityPass" DROP COLUMN "refundId";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20261029090000_community_pass_removal_refund';
