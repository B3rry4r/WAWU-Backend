\set ON_ERROR_STOP on
-- Rollback for 20261217090000_store_payout (STORE-PAYOUT). It refuses while any payout, any take made by a payout, any
-- notice or any 'sending' earning exists: they are records of money paid and cannot be rebuilt. With none, it puts the schema back as it was.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StoreEarningPayout") THEN
    RAISE EXCEPTION 'rollback refused: StoreEarningPayout has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "EarningDeductionTake" WHERE "storePayoutId" IS NOT NULL OR "moveId" IS NULL) THEN
    RAISE EXCEPTION 'rollback refused: a deduction was taken by a store payout';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreAdminNotice") THEN
    RAISE EXCEPTION 'rollback refused: StoreAdminNotice has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreEarning" WHERE "status" = 'sending') THEN
    RAISE EXCEPTION 'rollback refused: a store earning is being sent';
  END IF;
END $$;

ALTER TABLE "EarningDeductionTake" DROP CONSTRAINT "EarningDeductionTake_one_taker_check";
ALTER TABLE "EarningDeductionTake" DROP CONSTRAINT "EarningDeductionTake_storePayoutId_fkey";
DROP INDEX "EarningDeductionTake_deductionId_storePayoutId_key";
DROP INDEX "EarningDeductionTake_storePayoutId_idx";
ALTER TABLE "EarningDeductionTake" DROP COLUMN "storePayoutId";
ALTER TABLE "EarningDeductionTake" ALTER COLUMN "moveId" SET NOT NULL;
ALTER TABLE "StoreEarning" DROP CONSTRAINT "StoreEarning_status_check";
ALTER TABLE "StoreEarning" ADD CONSTRAINT "StoreEarning_status_check"
    CHECK ("status" IN ('owed', 'paid', 'cancelled') AND "role" IN ('sale', 'restore'));
DROP TABLE "StoreEarningPayout";
DROP TABLE "StoreAdminNotice";
