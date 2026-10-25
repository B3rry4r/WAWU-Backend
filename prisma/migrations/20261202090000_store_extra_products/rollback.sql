\set ON_ERROR_STOP on
-- Rollback of 20261202090000_store_extra_products (IAP-03). Run it only after the Hub build that reads
-- 'extra_products' is gone. Run with: psql -1 -f rollback.sql
-- Postgres cannot drop one value from an enum, so this recreates "StoreProductKind" without 'extra_products'.
-- Refuses (and changes nothing) while any store product or any store purchase of that kind is stored: a product
-- row is something an admin typed, and a purchase is what a person paid a store for and the record a refund is
-- matched against (dropping it would leave products on a tier that a refund could no longer take back). Clear
-- them on purpose first, after a person has decided:
--   DELETE FROM "StoreProduct" WHERE "kind" = 'extra_products';   -- only once no purchase names it
-- The products already added to "MakerTier"."extraProducts" and the "MakerExtraProducts" rows stay: they are
-- the person's allowance and are not part of this migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StorePurchase" WHERE "kind" = 'extra_products') THEN
    RAISE EXCEPTION 'IAP-03 rollback: store purchases of extra products are stored and would be lost. Nothing was changed.';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreProduct" WHERE "kind" = 'extra_products') THEN
    RAISE EXCEPTION 'IAP-03 rollback: the store product map holds an extra products row (an admin typed it). Nothing was changed.';
  END IF;
END $$;
ALTER TYPE "StoreProductKind" RENAME TO "StoreProductKind_old";
CREATE TYPE "StoreProductKind" AS ENUM ('points', 'credits', 'tier', 'pass');
ALTER TABLE "StoreProduct" ALTER COLUMN "kind" TYPE "StoreProductKind" USING "kind"::text::"StoreProductKind";
ALTER TABLE "StorePurchase" ALTER COLUMN "kind" TYPE "StoreProductKind" USING "kind"::text::"StoreProductKind";
DROP TYPE "StoreProductKind_old";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261202090000_store_extra_products';
