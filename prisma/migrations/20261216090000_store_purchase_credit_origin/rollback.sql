\set ON_ERROR_STOP on
-- Rollback for 20261216090000_store_purchase_credit_origin (STORE-BUY-HUB round 5). It refuses while a purchase has an
-- origin that no credit row records any more (the fan's account was deleted): dropping the column would lose which
-- purchase's refund must take that sale back.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "StorePurchase" p
     WHERE p."creditOriginId" IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM "StoreCredit" c WHERE c."spentPurchaseId" = p."id")
  ) THEN
    RAISE EXCEPTION 'rollback refused: a purchase has a credit origin that no credit row records';
  END IF;
END $$;

DROP INDEX "StorePurchase_creditOriginId_idx";
ALTER TABLE "StorePurchase" DROP COLUMN "creditOriginId";
