\set ON_ERROR_STOP on
-- Rollback for 20261217100000_store_cut30 (STORE-CUT30). It refuses while either table has rows: the switch records a price
-- change made in the stores and the entries are the proof of the total it was made on.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "StoreCut30Switch") THEN
    RAISE EXCEPTION 'rollback refused: StoreCut30Switch has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "StoreProceedsEntry") THEN
    RAISE EXCEPTION 'rollback refused: StoreProceedsEntry has rows';
  END IF;
  IF EXISTS (SELECT 1 FROM "StorePurchase" WHERE "shareFeeBps" IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback refused: a purchase has its share worked on another cut';
  END IF;
END $$;

ALTER TABLE "StorePurchase" DROP COLUMN "shareFeeBps";
DROP TABLE "StoreCut30Switch";
DROP TABLE "StoreProceedsEntry";
