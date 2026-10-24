\set ON_ERROR_STOP on
-- Rollback of 20261121090000_store_purchases (IAP-01). Run it only after the Hub build that reads these is gone.
-- Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any store purchase or credit pack bought in a store is stored: dropping them
-- loses what people paid a store for and the record a refund would be matched against. Clear them on purpose first
-- (after the take-backs are decided by a person):
--   UPDATE "CreditPurchase" SET "storePurchaseId" = NULL;   -- only for rows already reviewed
--   DELETE FROM "StoreNotification"; DELETE FROM "StorePurchase";
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StorePurchase") THEN
    RAISE EXCEPTION 'IAP-01 rollback: store purchases are stored and would be lost. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "CreditPurchase" WHERE "storePurchaseId" IS NOT NULL) THEN
    RAISE EXCEPTION 'IAP-01 rollback: credit packs bought in a store are stored and would lose their link. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreProduct") THEN
    RAISE EXCEPTION 'IAP-01 rollback: the store product map holds rows (an admin typed them). Nothing was changed.';
  END IF;
END $$;
DROP TABLE "StoreNotification";
DROP TABLE "StorePurchase";
DROP TABLE "StorePlatformSetting";
DROP TABLE "StoreProduct";
DROP INDEX "CreditPurchase_storePurchaseId_key";
ALTER TABLE "CreditPurchase" DROP COLUMN "storePurchaseId";
DROP TYPE "StorePurchaseStatus";
DROP TYPE "StoreProductKind";
DROP TYPE "StorePlatform";
