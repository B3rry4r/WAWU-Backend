\set ON_ERROR_STOP on
-- Rollback for 20261226090000_content_cover (CONTENT-COVER, R-114). It refuses while any piece has a cover: dropping the
-- column would leave those pictures in the bucket with nothing pointing at them. Remove the covers first (PATCH
-- /content/:id with "coverAsset": null, or the account purge), then run this.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ContentPiece" WHERE "coverKey" IS NOT NULL) THEN
    RAISE EXCEPTION 'rollback refused: a piece has a cover';
  END IF;
END $$;

ALTER TABLE "ContentPiece" DROP COLUMN "coverKey";
