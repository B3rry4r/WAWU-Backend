-- Rollback for 20261214090000_store_buy_credit_notice (STORE-BUY-HUB round 3). It refuses while any credit exists, any
-- purchase has its buyer cleared (a deleted account's purchase; the column cannot be NOT NULL again without losing it),
-- or any notice date is recorded.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StoreCredit") THEN
    RAISE EXCEPTION 'rollback refused: StoreCredit has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "StorePurchase" WHERE "wawuUserId" IS NULL) THEN
    RAISE EXCEPTION 'rollback refused: a purchase has its buyer cleared (deleted account)';
  END IF;
  IF EXISTS (SELECT 1 FROM "StorePurchase" WHERE "lastNoticeAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback refused: a purchase has a notice date';
  END IF;
END $$;

DROP TABLE "StoreCredit";
ALTER TABLE "StorePurchase" DROP COLUMN "lastNoticeAt";
ALTER TABLE "StorePurchase" ALTER COLUMN "wawuUserId" SET NOT NULL;
