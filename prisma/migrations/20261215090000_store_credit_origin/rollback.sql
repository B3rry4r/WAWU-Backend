\set ON_ERROR_STOP on
-- Rollback for 20261215090000_store_credit_origin (STORE-BUY-HUB round 4). It refuses while a credit made of the rest of
-- another exists (its "sourcePurchaseId" carries ':rem:'): without the column nothing says which purchase it came from.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StoreCredit" WHERE "sourcePurchaseId" LIKE '%:rem:%') THEN
    RAISE EXCEPTION 'rollback refused: a credit made of the rest of another exists';
  END IF;
END $$;

DROP INDEX "StoreCredit_originPurchaseId_idx";
ALTER TABLE "StoreCredit" DROP COLUMN "originPurchaseId";
