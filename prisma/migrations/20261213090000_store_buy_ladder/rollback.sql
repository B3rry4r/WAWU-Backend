\set ON_ERROR_STOP on
-- Rollback for 20261213090000_store_buy_ladder (STORE-BUY-HUB). Run 20261213090100_store_buy_ladder_rows' rollback first.
-- It refuses while any record of money made by the ladder exists: an intent, a store earning, a ladder purchase, or a
-- deduction a store refund made. Those cannot be rebuilt, so they are never dropped silently.
--
-- The `buy` value stays in "StoreProductKind": Postgres cannot drop an enum value. Nothing uses it once the ladder rows
-- are gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StorePurchaseIntent") THEN
    RAISE EXCEPTION 'rollback refused: StorePurchaseIntent has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreEarning") THEN
    RAISE EXCEPTION 'rollback refused: StoreEarning has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "StorePurchase" WHERE "intentId" IS NOT NULL OR "buyKind" IS NOT NULL OR "targetId" IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback refused: a ladder purchase exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "EarningDeduction" WHERE "storePurchaseId" IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback refused: a store refund deduction exists';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreProduct" WHERE "kind"::text = 'buy') THEN
    RAISE EXCEPTION 'rollback refused: ladder products exist (run the rows migration rollback first)';
  END IF;
END $$;

ALTER TABLE "EarningDeduction" DROP CONSTRAINT "EarningDeduction_one_source_check";
DROP INDEX "EarningDeduction_storePurchaseId_key";
ALTER TABLE "EarningDeduction" DROP COLUMN "storePurchaseId";
ALTER TABLE "EarningDeduction" ALTER COLUMN "passRefundId" SET NOT NULL;

ALTER TABLE "StoreProduct" DROP CONSTRAINT "StoreProduct_store_price_check";
ALTER TABLE "StoreProduct" DROP COLUMN "storePriceKobo";

DROP INDEX "StorePurchase_intentId_key";
ALTER TABLE "StorePurchase" DROP COLUMN "intentId", DROP COLUMN "buyKind", DROP COLUMN "targetId";

DROP TABLE "StoreEarning";
DROP TABLE "StorePurchaseIntent";
DROP TYPE "StoreIntentStatus";
DROP TYPE "StoreIntentKind";
