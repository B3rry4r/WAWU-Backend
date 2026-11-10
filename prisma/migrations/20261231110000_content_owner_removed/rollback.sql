\set ON_ERROR_STOP on
-- Rollback for CREATOR-TAKEDOWN. Refuses while any piece carries the mark: dropping it would hand a buyer's kept piece back to "gone for everyone".
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ContentPiece" WHERE "ownerRemovedAt" IS NOT NULL) THEN
    RAISE EXCEPTION 'CREATOR-TAKEDOWN rollback refused: % piece(s) were taken down by their creator and buyers keep them', (SELECT count(*) FROM "ContentPiece" WHERE "ownerRemovedAt" IS NOT NULL);
  END IF;
END $$;
ALTER TABLE "ContentPiece" DROP COLUMN "ownerRemovedAt";
