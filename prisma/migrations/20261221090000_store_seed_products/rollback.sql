\set ON_ERROR_STOP on
-- Rollback for 20261221090000_store_seed_products (STORE-SEED). Removes the store products that migration inserted, and only
-- the ones that are still exactly as it left them and that nothing names:
--   - a row an admin has written ("updatedBy" is set) is the admin's now, and stays;
--   - a row a purchase names stays ("StorePurchase"."productId" restricts the delete, and a purchase is a record of money);
--   - a row a purchase intent names stays.
-- It never fails for a kept row and never loses a purchase: it deletes what it can and says how many it kept.
DO $$
DECLARE
  removed integer;
  kept integer;
BEGIN
  WITH seeded("storeProductId") AS (VALUES
    ('wawu.tier.verify'), ('wawu.tier.plus'), ('wawu.tier.founding'),
    ('wawu.points.s'), ('wawu.points.m'), ('wawu.points.l'),
    ('wawu.credits.starter'), ('wawu.credits.popular'), ('wawu.credits.pro'),
    ('wawu.more.products.5')
  ), gone AS (
    DELETE FROM "StoreProduct" sp
     USING seeded
     WHERE sp."storeProductId" = seeded."storeProductId"
       AND sp."kind"::text <> 'buy'
       AND sp."updatedBy" IS NULL
       AND NOT EXISTS (SELECT 1 FROM "StorePurchase" p WHERE p."productId" = sp."id")
       AND NOT EXISTS (SELECT 1 FROM "StorePurchaseIntent" i WHERE i."productId" = sp."id")
    RETURNING sp."id"
  )
  SELECT count(*) INTO removed FROM gone;
  SELECT count(*) INTO kept FROM "StoreProduct"
   WHERE "storeProductId" IN ('wawu.tier.verify', 'wawu.tier.plus', 'wawu.tier.founding',
                              'wawu.points.s', 'wawu.points.m', 'wawu.points.l',
                              'wawu.credits.starter', 'wawu.credits.popular', 'wawu.credits.pro',
                              'wawu.more.products.5');
  RAISE NOTICE 'store seed rollback: % rows removed, % kept (named by a purchase or intent, or written by an admin)', removed, kept;
END $$;

DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261221090000_store_seed_products';
