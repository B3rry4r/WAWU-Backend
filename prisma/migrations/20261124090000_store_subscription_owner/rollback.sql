\set ON_ERROR_STOP on
-- Rollback of 20261124090000_store_subscription_owner (IAP-01 fix round 1). Run it only after the Hub build that reads
-- these is gone. Run with: psql -1 -f rollback.sql
-- Refuses (and changes nothing) while any subscription holder, account token or flagged purchase is stored: dropping
-- them loses who holds a store subscription (the next order of it could then be taken by someone else), the binding of
-- people's store purchases to them, and the purchases an admin has to look at. Clear them on purpose first (after a
-- person has decided), and roll back 20261121090000_store_purchases only after this one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StoreSubscription") THEN
    RAISE EXCEPTION 'IAP-01 round 1 rollback: store subscription holders are stored and would be lost. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreAccountToken") THEN
    RAISE EXCEPTION 'IAP-01 round 1 rollback: store account tokens are stored and would be lost. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "StorePurchase" WHERE "flag" IS NOT NULL) THEN
    RAISE EXCEPTION 'IAP-01 round 1 rollback: flagged store purchases are stored and would lose their flag. Nothing was changed.';
  END IF;
END $$;
DROP TABLE "StoreAccountToken";
DROP TABLE "StoreSubscription";
ALTER TABLE "StorePurchase" DROP COLUMN "flaggedAt";
ALTER TABLE "StorePurchase" DROP COLUMN "flag";
