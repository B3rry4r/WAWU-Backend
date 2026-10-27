-- Rollback for 20261213090100_store_buy_ladder_rows (STORE-BUY-HUB). Removes the ladder products. It refuses while any
-- purchase or intent names one (a purchase is a record of money; "StorePurchase"."productId" restricts the delete).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StorePurchase" p JOIN "StoreProduct" s ON s."id" = p."productId" WHERE s."kind"::text = 'buy') THEN
    RAISE EXCEPTION 'rollback refused: a purchase names a ladder product';
  END IF;
  IF EXISTS (SELECT 1 FROM "StorePurchaseIntent" i JOIN "StoreProduct" s ON s."id" = i."productId" WHERE s."kind"::text = 'buy') THEN
    RAISE EXCEPTION 'rollback refused: an intent names a ladder product';
  END IF;
END $$;

DELETE FROM "StoreProduct" WHERE "kind"::text = 'buy' AND "storeProductId" LIKE 'wawu.buy.%';
